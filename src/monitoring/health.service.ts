import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { BotConfigService } from '../config/bot-config.service';
import { RiskService } from '../trading/risk.service';
import { ReconciliationService } from '../trading/reconciliation.service';
import { RecoveryService } from '../trading/recovery.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { MarketDataProvider } from '../market-intelligence/mtf/market-data.provider';
import { NotificationService } from '../notification/notification.service';

export type ComponentStatus = 'OK' | 'DEGRADED' | 'ERROR' | 'UNKNOWN';

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  /** Label siap tampil, mis. "ONLINE", "STALE", "SYNCED". */
  label: string;
  detail: string;
  /** Waktu pemeriksaan terakhir. */
  checkedAt: string;
  latencyMs?: number;
}

export interface HealthReport {
  overall: ComponentStatus;
  mode: string;
  components: ComponentHealth[];
  /** Detak jantung terakhir - bila jauh tertinggal, proses bot kemungkinan mati. */
  lastHeartbeat: string;
  heartbeatAgeSeconds: number;
  uptimeSeconds: number;
}

/**
 * Health Monitor (bagian 24 spesifikasi).
 *
 * Menjawab satu pertanyaan yang tidak bisa dijawab log: apakah bot ini
 * sebenarnya masih bekerja? Bot yang macet dan bot yang sedang tidak menemukan
 * peluang terlihat persis sama dari luar - keduanya diam.
 *
 * Karena itu tiap komponen diperiksa secara AKTIF, bukan disimpulkan dari
 * ketiadaan galat. "Tidak ada error" bukan bukti bahwa sesuatu masih hidup.
 */
/**
 * Ambang "pengambilan candle macet".
 *
 * Dipasang DI ATAS jeda penyegar terjadwal (scanner tiap 15 menit) dengan
 * kelonggaran, supaya satu pemindaian yang lambat atau terlewat tidak langsung
 * menjadi alarm. Di bawah 15 menit, pemeriksaan ini akan menyala pada setiap
 * siklus normal.
 */
const MARKET_DATA_STALE_AFTER_SECONDS = 25 * 60;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  /** Diperbarui tiap siklus scheduler; bukti bahwa proses masih berjalan. */
  private lastHeartbeat = Date.now();
  /** Dipakai untuk tidak membanjiri Telegram dengan peringatan yang sama. */
  private lastAlertAt = 0;

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly risk: RiskService,
    private readonly reconciliation: ReconciliationService,
    private readonly recovery: RecoveryService,
    private readonly strategies: StrategyRegistry,
    private readonly marketData: MarketDataProvider,
    private readonly notification: NotificationService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  /** Dipanggil scheduler setiap siklus. */
  beat(): void {
    this.lastHeartbeat = Date.now();
  }

  async check(): Promise<HealthReport> {
    const components = await Promise.all([
      this.checkExchange(),
      this.checkCredentials(),
      this.checkMarketData(),
      this.checkDatabase(),
      this.checkStrategy(),
      this.checkRiskEngine(),
      this.checkExecution(),
      this.checkReconciliation(),
    ]);

    const heartbeatAge = Math.round((Date.now() - this.lastHeartbeat) / 1000);

    return {
      overall: worstOf(components.map((c) => c.status)),
      mode: this.config.mode,
      components,
      lastHeartbeat: new Date(this.lastHeartbeat).toISOString(),
      heartbeatAgeSeconds: heartbeatAge,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Periksa kesehatan dan kirim peringatan bila ada yang rusak. */
  async checkAndAlert(): Promise<HealthReport> {
    const report = await this.check();
    if (report.overall === 'OK') return report;

    // Satu peringatan per 30 menit per kondisi; kesehatan yang buruk tidak
    // membaik karena diberitahukan setiap menit.
    if (Date.now() - this.lastAlertAt < 30 * 60_000) return report;
    this.lastAlertAt = Date.now();

    const broken = report.components.filter((c) => c.status !== 'OK');
    await this.notification.sendAlert(
      `⚠️ HEALTH CHECK: ${report.overall}\n\n` +
        broken.map((c) => `• ${c.component}: ${c.label}\n  ${c.detail}`).join('\n') +
        `\n\nDetak jantung terakhir: ${report.heartbeatAgeSeconds} detik lalu.`,
    );
    return report;
  }

  // --- Pemeriksaan per komponen -------------------------------------------

  private async checkExchange(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      // Endpoint publik yang murah; cukup untuk membuktikan API menjawab.
      await this.indodax.getTicker('btcidr');
      return this.ok('Exchange API', 'ONLINE', 'Endpoint publik Indodax menjawab', Date.now() - started);
    } catch (err) {
      return this.fail(
        'Exchange API',
        'OFFLINE',
        `Tidak bisa menghubungi Indodax: ${err.message}`,
        Date.now() - started,
      );
    }
  }

  /**
   * Uji API PRIVAT, bukan hanya yang publik.
   *
   * Kedua hal ini gagal secara terpisah: endpoint publik bisa menjawab normal
   * sementara kunci API ditolak. Tanpa pemeriksaan ini health tetap hijau
   * padahal bot sama sekali tidak bisa memasang order — kegagalan yang paling
   * mahal untuk ditemukan terlambat, yaitu saat sinyal pertama muncul.
   *
   * Di mode SIMULASI kredensial tidak wajib, jadi kegagalannya DEGRADED, bukan
   * ERROR: ia perlu terlihat tanpa membuat seluruh laporan merah untuk sesuatu
   * yang belum dipakai.
   */
  private async checkCredentials(): Promise<ComponentHealth> {
    const started = Date.now();
    const live = this.config.mode === 'LIVE';

    try {
      await this.indodax.getBalance();
      return this.ok(
        'Kredensial',
        'DITERIMA',
        `API privat menjawab lewat ${this.indodax.getApiVersion().toUpperCase()}`,
        Date.now() - started,
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const ipRejected = /unauthorized ip/i.test(message);

      const detail = ipRejected
        ? 'IP mesin ini tidak ada di whitelist API Indodax — kunci tidak ditolak. ' +
          'Sesuaikan IP Permission di indodax.com/account/settings/api, atau kosongkan.'
        : `API privat menolak: ${message}`;

      // Di LIVE ini menghalangi eksekusi, jadi harus memerahkan laporan.
      return live
        ? this.fail('Kredensial', ipRejected ? 'IP DITOLAK' : 'DITOLAK', detail, Date.now() - started)
        : this.degraded('Kredensial', ipRejected ? 'IP DITOLAK' : 'DITOLAK', detail);
    }
  }

  private async checkMarketData(): Promise<ComponentHealth> {
    const ages = this.marketData.cacheAges();
    if (!ages.length) {
      return {
        component: 'Market Data',
        status: 'UNKNOWN',
        label: 'BELUM ADA DATA',
        detail: 'Belum ada candle yang diambil sejak bot dijalankan',
        checkedAt: new Date().toISOString(),
      };
    }

    /**
     * Yang diukur: APAKAH PENGAMBILAN CANDLE MASIH JALAN — bukan berapa lama
     * sejak sebuah entri terakhir diminta.
     *
     * Versi sebelumnya menandai setiap entri 5m yang berumur lebih dari 10
     * menit sebagai "pengambilan candle macet", dan itu keliru karena cache
     * ini LAZY: ia hanya terisi ketika ada yang meminta. Tidak ada proses yang
     * menyegarkannya di latar belakang.
     *
     * Akibatnya terukur. Scanner berjalan tiap 15 menit dan mengisi cache 5m
     * untuk ~30 pair; TTL 5m hanya 75 detik, lalu entri itu menua di tempat.
     * Pada menit ke-10 setelah pemindaian, pemeriksaan ini berteriak STALE —
     * lalu pada menit ke-15 scanner menyegarkannya lagi. Jadi SETIAP siklus
     * menghasilkan jendela ~5 menit berisi alarm palsu, dan jumlah "timeframe
     * stale" yang dilaporkan hanyalah cerminan berapa pair yang terakhir
     * dipindai (30 tepat setelah pindai, 5 beberapa saat kemudian).
     *
     * Alarm yang menyala saat tidak ada yang rusak melatih operator untuk
     * mengabaikannya — dan alarm yang diabaikan tidak berguna saat benar-benar
     * ada yang rusak.
     *
     * Penanda yang jujur adalah entri PALING BARU: bila TIDAK SATU PUN candle
     * berhasil diambil dalam waktu lebih lama daripada jeda penyegar
     * terjadwal, pengambilannya memang macet.
     */
    const termuda = Math.min(...ages.map((a) => a.ageSeconds));
    if (termuda > MARKET_DATA_STALE_AFTER_SECONDS) {
      return this.fail(
        'Market Data',
        'STALE',
        `Tidak ada candle yang berhasil diambil selama ${Math.round(termuda / 60)} menit ` +
          `(ambang ${MARKET_DATA_STALE_AFTER_SECONDS / 60} menit). ` +
          'Pengambilan data pasar kemungkinan macet.',
      );
    }

    const empty = ages.filter((a) => a.bars === 0);
    if (empty.length) {
      return this.degraded(
        'Market Data',
        'SEBAGIAN KOSONG',
        `${empty.length} entri candle kosong: ${empty.map((e) => e.key).join(', ')}`,
      );
    }

    return this.ok('Market Data', 'ONLINE', `${ages.length} set candle dalam cache`);
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await this.tradeRepo.count();
      return this.ok('Database', 'HEALTHY', 'Kueri berhasil', Date.now() - started);
    } catch (err) {
      return this.fail('Database', 'ERROR', `Kueri gagal: ${err.message}`, Date.now() - started);
    }
  }

  private async checkStrategy(): Promise<ComponentHealth> {
    try {
      const active = this.strategies.active();
      const params = this.config.params();

      if (!params.tradingEnabled) {
        return this.degraded(
          'Strategy',
          'STOPPED',
          `Strategi ${active.name} dimuat, tetapi trading dijeda (TRADING_ENABLED=false)`,
        );
      }
      // Detak jantung basi berarti scheduler berhenti memanggil siklus.
      const heartbeatAge = (Date.now() - this.lastHeartbeat) / 1000;
      if (heartbeatAge > 900) {
        return this.fail(
          'Strategy',
          'STOPPED',
          `Siklus trading tidak berjalan sejak ${Math.round(heartbeatAge / 60)} menit lalu`,
        );
      }

      return this.ok('Strategy', 'RUNNING', `${active.name} aktif pada ${params.tradingPairs.length} pair`);
    } catch (err) {
      return this.fail('Strategy', 'ERROR', err.message);
    }
  }

  private async checkRiskEngine(): Promise<ComponentHealth> {
    try {
      const kill = await this.risk.checkKillSwitch();
      if (kill.halted) {
        return this.degraded('Risk Engine', 'BLOCKED', kill.reasons.join('; '));
      }
      const remaining = await this.risk.getRemainingDailyRisk();
      return this.ok('Risk Engine', 'READY', `Sisa jatah risiko hari ini ${remaining.toFixed(2)}%`);
    } catch (err) {
      return this.fail('Risk Engine', 'ERROR', err.message);
    }
  }

  private async checkExecution(): Promise<ComponentHealth> {
    try {
      const failed = await this.tradeRepo.count({ where: { status: 'FAILED' } });
      if (failed > 0) {
        return this.fail(
          'Execution',
          'ERROR',
          `${failed} posisi gagal ditutup dan butuh pemulihan atau tindakan manual`,
        );
      }

      if (this.config.isLive && !this.indodax.hasCredentials()) {
        return this.fail('Execution', 'ERROR', 'Mode LIVE tetapi kredensial Indodax tidak ada');
      }

      return this.ok(
        'Execution',
        'READY',
        this.config.isLive ? 'Mode LIVE, kredensial tersedia' : 'Mode SIMULASI',
      );
    } catch (err) {
      return this.fail('Execution', 'ERROR', err.message);
    }
  }

  private async checkReconciliation(): Promise<ComponentHealth> {
    const report = this.reconciliation.getLastReport();
    if (!report) {
      return {
        component: 'Reconciliation',
        status: 'UNKNOWN',
        label: 'BELUM DIJALANKAN',
        detail: 'Rekonsiliasi belum pernah dijalankan sejak bot dimulai',
        checkedAt: new Date().toISOString(),
      };
    }

    const critical = report.discrepancies.filter((d) => d.severity === 'CRITICAL');
    if (critical.length) {
      return this.fail(
        'Reconciliation',
        'MISMATCH',
        `${critical.length} selisih kritis: ${critical.map((d) => d.detail).join('; ')}`,
      );
    }

    const unresolved = await this.recovery.hasUnresolvedPositions();
    if (unresolved) {
      return this.degraded(
        'Reconciliation',
        'MISMATCH',
        'Masih ada posisi berstatus FAILED yang belum diselesaikan',
      );
    }

    const warnings = report.discrepancies.filter((d) => d.severity === 'WARNING');
    if (warnings.length) {
      return this.degraded('Reconciliation', 'PERINGATAN', `${warnings.length} selisih ringan`);
    }

    return this.ok('Reconciliation', 'SYNCED', `Terakhir dijalankan ${report.ranAt}`);
  }

  // --- Pembantu ------------------------------------------------------------

  private ok(component: string, label: string, detail: string, latencyMs?: number): ComponentHealth {
    return { component, status: 'OK', label, detail, checkedAt: new Date().toISOString(), latencyMs };
  }

  private degraded(component: string, label: string, detail: string): ComponentHealth {
    return { component, status: 'DEGRADED', label, detail, checkedAt: new Date().toISOString() };
  }

  private fail(
    component: string,
    label: string,
    detail: string,
    latencyMs?: number,
  ): ComponentHealth {
    return { component, status: 'ERROR', label, detail, checkedAt: new Date().toISOString(), latencyMs };
  }
}

/** Status terburuk menentukan status keseluruhan. */
function worstOf(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes('ERROR')) return 'ERROR';
  if (statuses.includes('DEGRADED')) return 'DEGRADED';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  return 'OK';
}
