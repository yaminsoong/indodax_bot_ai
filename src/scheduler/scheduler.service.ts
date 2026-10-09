import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradingService } from '../trading/trading.service';
import { PortfolioService } from '../trading/portfolio.service';
import { ReconciliationService } from '../trading/reconciliation.service';
import { RecoveryService } from '../trading/recovery.service';
import { HealthService } from '../monitoring/health.service';
import { AnalysisService } from '../analysis/analysis.service';
import { RiskService } from '../trading/risk.service';
import { NotificationService } from '../notification/notification.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { BotConfigService } from '../config/bot-config.service';
import { ConfigAuditService } from '../config/config-audit.service';
import { AuditService } from '../database/audit.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { IndodaxService } from '../indodax/indodax.service';
import { ScannerReportService } from '../notification/scanner-report.service';
import { TradingUniverseService } from '../config/trading-universe.service';
import { idr } from '../common/num';

const TZ = { timeZone: 'Asia/Jakarta' };

@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private startupDone = false;

  constructor(
    private readonly trading: TradingService,
    private readonly portfolio: PortfolioService,
    private readonly reconciliation: ReconciliationService,
    private readonly recovery: RecoveryService,
    private readonly health: HealthService,
    private readonly analysis: AnalysisService,
    private readonly risk: RiskService,
    private readonly notification: NotificationService,
    private readonly strategies: StrategyRegistry,
    private readonly config: BotConfigService,
    private readonly configAudit: ConfigAuditService,
    private readonly audit: AuditService,
    private readonly pairs: PairRegistryService,
    private readonly scannerReport: ScannerReportService,
    private readonly universe: TradingUniverseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Beri jeda agar metadata pair dan koneksi database siap lebih dulu.
    setTimeout(() => void this.startup(), 5000);
  }

  private async startup(): Promise<void> {
    if (this.startupDone) return;
    this.startupDone = true;

    try {
      // Semesta trading disegarkan lebih dulu: pemeriksaan pair di bawah
      // harus menilai daftar yang benar-benar akan dipakai, bukan cadangan.
      await this.universe.refresh();

      const params = this.config.params();

      // Audit .env sebelum apa pun berjalan. Berkas konfigurasi yang tertinggal
      // di belakang kode tidak menimbulkan gejala apa pun — bot tetap menyala,
      // hanya saja memakai default kode alih-alih niat operator.
      const configAudit = this.configAudit.audit();
      this.configAudit.logReport(configAudit);

      const criticalConfig = configAudit.findings.filter((f) => f.severity === 'CRITICAL');
      const deadKeys = configAudit.findings.filter((f) => f.kind === 'DEAD_KEY');

      if (criticalConfig.length) {
        await this.notification.sendAlert(
          `Masalah konfigurasi serius:\n` +
            criticalConfig.map((f) => `• ${f.key}: ${f.detail}`).join('\n'),
        );
      }
      if (deadKeys.length) {
        await this.notification.sendAlert(
          `${deadKeys.length} parameter di .env sudah tidak dibaca kode dan nilainya ` +
            `tidak berpengaruh:\n` +
            deadKeys.map((f) => `• ${f.key}`).join('\n') +
            `\n\nSalin ulang dari .env.example agar setelan Anda benar-benar berlaku.`,
        );
      }

      // Peringatkan pair yang salah eja sebelum bot berjalan diam-diam tanpa hasil.
      const unknown = params.tradingPairs.filter((p) => !this.pairs.has(p));
      if (unknown.length) {
        const msg = `Pair tidak dikenal di Indodax: ${unknown.join(', ')} — akan dilewati`;
        this.logger.error(msg);
        await this.notification.sendAlert(msg);
      }

      // Timeframe yang tidak didukung ditolak API dan membuat setiap siklus
      // berakhir tanpa data — gejalanya identik dengan "tidak ada peluang".
      const badTimeframes: string[] = [];
      if (!IndodaxService.isValidTimeframe(params.candleTimeframe)) {
        badTimeframes.push(`CANDLE_TIMEFRAME=${params.candleTimeframe}`);
      }
      if (params.requireHtfTrend && !IndodaxService.isValidTimeframe(params.htfTimeframe)) {
        badTimeframes.push(`HTF_TIMEFRAME=${params.htfTimeframe}`);
      }
      if (badTimeframes.length) {
        const msg =
          `Timeframe tidak didukung: ${badTimeframes.join(', ')}. ` +
          `Nilai valid: ${IndodaxService.VALID_TIMEFRAMES.join(', ')} menit. ` +
          `Bot tidak akan menerima data candle sampai ini diperbaiki.`;
        this.logger.error(msg);
        await this.notification.sendAlert(msg);
      }

      const state = await this.portfolio.getState();
      await this.notification.sendStartup({
        mode: this.config.mode,
        strategy: this.strategies.active().name,
        pairs: params.tradingPairs.filter((p) => this.pairs.has(p)),
        equity: state.equityIdr,
      });

      await this.audit.log({
        category: 'SYSTEM',
        event: 'BOT_STARTED',
        message: `Mode ${this.config.mode}, strategi ${this.strategies.active().name}`,
        data: { pairs: params.tradingPairs, equity: state.equityIdr },
      });

      // Rekonsiliasi awal: bot bisa saja mati saat masih ada posisi terbuka.
      await this.reconciliation.reconcile();
      await this.portfolio.snapshot();
      await this.analysis.runDailyAnalysis();
    } catch (err) {
      this.logger.error(`Startup bermasalah: ${err.message}`);
    }
  }

  // ─── Siklus trading: setiap 5 menit ──────────────────────────────────────
  @Cron('*/5 * * * *', TZ)
  async tradingCycle(): Promise<void> {
    // Detak jantung ditandai SEBELUM siklus berjalan: yang ingin dibuktikan
    // adalah scheduler masih memanggil, terlepas dari berhasil-tidaknya siklus.
    this.health.beat();
    try {
      await this.trading.runTradingCycle();
    } catch (err) {
      this.logger.error(`Siklus trading gagal: ${err.message}`);
      await this.audit.log({
        category: 'SYSTEM',
        event: 'CYCLE_ERROR',
        message: err.message,
        isError: true,
      });
    }
  }

  /**
   * Monitor posisi: setiap menit.
   *
   * Dulu monitor dipanggil dari dalam siklus trading DAN punya cron sendiri,
   * sehingga di menit kelipatan 10 keduanya berjalan bersamaan dan bisa
   * mengirim dua order jual untuk posisi yang sama. Sekarang monitor hanya
   * dijadwalkan di sini, dan TradingService tetap menjaganya dengan mutex.
   */
  @Cron('* * * * *', TZ)
  async monitorTrades(): Promise<void> {
    try {
      await this.trading.monitorOpenTrades();
    } catch (err) {
      this.logger.error(`Monitor posisi gagal: ${err.message}`);
    }
  }

  // ─── Snapshot ekuitas: setiap 15 menit ───────────────────────────────────
  @Cron('*/15 * * * *', TZ)
  async equitySnapshot(): Promise<void> {
    await this.portfolio.snapshot();
  }

  // ─── Rekonsiliasi: setiap 30 menit ───────────────────────────────────────
  @Cron('*/30 * * * *', TZ)
  async reconcile(): Promise<void> {
    try {
      await this.reconciliation.reconcile();
    } catch (err) {
      this.logger.error(`Rekonsiliasi gagal: ${err.message}`);
    }
  }

  /**
   * Pemulihan posisi gagal: setiap 10 menit.
   *
   * Dijalankan lebih sering daripada rekonsiliasi karena posisi berstatus
   * FAILED berarti koin mungkin dipegang TANPA stop loss — setiap menit
   * tambahan adalah risiko yang tidak terkendali. Selama posisi seperti itu
   * ada, kill switch juga menahan seluruh entry baru.
   */
  @Cron('*/10 * * * *', TZ)
  async recoverFailed(): Promise<void> {
    try {
      const unresolved = await this.recovery.hasUnresolvedPositions();
      if (!unresolved) return;
      await this.recovery.recover();
    } catch (err) {
      this.logger.error(`Pemulihan gagal: ${err.message}`);
      await this.audit.log({
        category: 'SYSTEM',
        event: 'RECOVERY_ERROR',
        message: err.message,
        isError: true,
      });
    }
  }

  /**
   * Pemindaian pasar: 08:00 dan 20:00 WIB.
   *
   * Dua kali sehari, bukan tiap jam. Analisis Market Intelligence mengambil
   * lima timeframe per pair; menjalankannya terlalu sering akan menghabiskan
   * jatah rate limit Indodax yang juga dibutuhkan siklus trading — dan setup
   * yang layak tidak muncul-hilang dalam hitungan menit.
   */
  @Cron('0 8,20 * * *', TZ)
  async marketScan(): Promise<void> {
    this.logger.log('Menjalankan pemindaian pasar...');
    try {
      await this.scannerReport.scanAndReport();
    } catch (err) {
      this.logger.error(`Pemindaian pasar gagal: ${err.message}`);
    }
  }

  /**
   * Segarkan semesta trading: tiap 6 jam.
   *
   * Tidak lebih sering: likuiditas pair bergeser dalam hitungan hari, bukan
   * menit, dan mengganti daftar pair terlalu sering membuat bot terus-menerus
   * memulai pemantauan dari nol pada pair yang baru masuk.
   */
  @Cron('0 */6 * * *', TZ)
  async refreshUniverse(): Promise<void> {
    await this.universe.refreshIfStale();
  }

  // ─── Analisis pasar: 07:00 WIB ───────────────────────────────────────────
  @Cron('0 7 * * *', TZ)
  async dailyAnalysis(): Promise<void> {
    this.logger.log('Menjalankan analisis pasar harian...');
    try {
      await this.analysis.runDailyAnalysis();
    } catch (err) {
      this.logger.error(`Analisis harian gagal: ${err.message}`);
    }
  }

  // ─── Laporan harian: 22:00 WIB ───────────────────────────────────────────
  @Cron('0 22 * * *', TZ)
  async dailyReport(): Promise<void> {
    this.logger.log('Mengirim laporan harian...');
    try {
      const [stats, state] = await Promise.all([
        this.risk.getDailyStats(),
        this.portfolio.getState(),
      ]);
      await this.notification.sendDailyReport({
        ...stats,
        equity: state.equityIdr,
        drawdownPercent: state.drawdownPercent,
      });
    } catch (err) {
      this.logger.error(`Laporan harian gagal: ${err.message}`);
    }
  }

  /**
   * Pemeriksaan kesehatan komponen: setiap 10 menit.
   *
   * Terpisah dari ringkasan per jam di bawah. Yang ini memeriksa secara AKTIF
   * apakah exchange, database, data pasar, dan eksekusi masih berfungsi —
   * bot yang macet dan bot yang sedang tidak menemukan peluang sama-sama diam,
   * dan hanya pemeriksaan aktif yang bisa membedakannya.
   */
  @Cron('*/10 * * * *', TZ)
  async componentHealth(): Promise<void> {
    try {
      const report = await this.health.checkAndAlert();
      if (report.overall !== 'OK') {
        this.logger.warn(
          `Health ${report.overall}: ` +
            report.components
              .filter((c) => c.status !== 'OK')
              .map((c) => `${c.component}=${c.label}`)
              .join(', '),
        );
      }
    } catch (err) {
      this.logger.error(`Pemeriksaan kesehatan gagal: ${err.message}`);
    }
  }

  // ─── Health check: setiap jam ────────────────────────────────────────────
  @Cron('0 * * * *', TZ)
  async healthCheck(): Promise<void> {
    try {
      const [stats, state, kill] = await Promise.all([
        this.risk.getDailyStats(),
        this.portfolio.getState(),
        this.risk.checkKillSwitch(),
      ]);

      this.logger.log(
        `Health | Ekuitas ${idr(state.equityIdr)} | DD ${state.drawdownPercent.toFixed(2)}% | ` +
          `Posisi ${state.openPositions} | Hari ini ${stats.totalTrades} trade, P&L ${idr(stats.totalPnL)} | ` +
          `${kill.halted ? 'DIHENTIKAN' : 'aktif'}`,
      );

      // Posisi berstatus FAILED tidak akan sembuh sendiri — ingatkan operator.
      const failed = await this.trading.getFailedTrades();
      if (failed.length) {
        await this.notification.sendAlert(
          `${failed.length} posisi berstatus FAILED perlu penanganan manual:\n` +
            failed.map((t) => `• #${t.id} ${t.pair.toUpperCase()} — ${t.lastError}`).join('\n'),
        );
      }
    } catch (err) {
      this.logger.error(`Health check gagal: ${err.message}`);
    }
  }

  // ─── Perawatan: 03:00 WIB ────────────────────────────────────────────────
  @Cron('0 3 * * *', TZ)
  async maintenance(): Promise<void> {
    try {
      await this.pairs.refresh();
      const pruned = await this.audit.prune(30);
      this.logger.log(`Perawatan selesai: metadata pair disegarkan, ${pruned} audit log lama dihapus`);
    } catch (err) {
      this.logger.error(`Perawatan gagal: ${err.message}`);
    }
  }
}
