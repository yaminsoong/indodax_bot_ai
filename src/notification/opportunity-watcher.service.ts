import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { NotificationService } from './notification.service';
import { TradeConfirmService } from './trade-confirm.service';
import { SignalScannerService } from '../market-intelligence/scanner/signal-scanner.service';
import { RiskService } from '../trading/risk.service';
import { BotConfigService } from '../config/bot-config.service';
import { TradingUniverseService } from '../config/trading-universe.service';
import { IndodaxService } from '../indodax/indodax.service';
import { fmtPrice, idr } from '../common/num';

const TZ = { timeZone: 'Asia/Jakarta' };

/**
 * Pengawas peluang — bot menawarkan sendiri, operator cukup menekan tombol.
 *
 * Sebelum ini ada, seluruh bahannya sudah lengkap tetapi tidak tersambung:
 * scanner menilai pair, Risk Engine menghitung ukuran dan stop, dan
 * TradeConfirmService punya tombol BUY dengan konfirmasi dua langkah — namun
 * `offer()` HANYA dipanggil dari perintah `/buy` manual. Artinya operator harus
 * menebak sendiri kapan harus bertanya. Bot tahu lebih dulu, tetapi diam.
 *
 * Yang membedakan ini dari sekadar notifikasi: setiap tawaran DIVALIDASI dulu
 * lewat Risk Engine yang sama dengan jalur otomatis. Tawaran yang tidak akan
 * lolos saat tombolnya ditekan tidak pernah dikirim — menawarkan sesuatu yang
 * kemudian ditolak melatih operator untuk mengabaikan notifikasi.
 */
@Injectable()
export class OpportunityWatcherService {
  private readonly logger = new Logger(OpportunityWatcherService.name);

  /** Kapan sebuah pair terakhir ditawarkan, agar tidak diulang tiap siklus. */
  private readonly lastOffered = new Map<string, number>();

  constructor(
    @InjectRepository(Trade) private readonly trades: Repository<Trade>,
    private readonly notification: NotificationService,
    private readonly tradeConfirm: TradeConfirmService,
    private readonly scanner: SignalScannerService,
    private readonly risk: RiskService,
    private readonly config: BotConfigService,
    private readonly universe: TradingUniverseService,
    private readonly indodax: IndodaxService,
  ) {}

  /**
   * Dijalankan tiap 15 menit.
   *
   * Lebih sering dari laporan scanner dua kali sehari, tetapi tidak tiap siklus
   * trading (5 menit): setup yang layak tidak muncul dan hilang dalam lima
   * menit, dan menawarkan sesering itu membuat operator berhenti membacanya.
   */
  @Cron('*/15 * * * *', TZ)
  async watch(): Promise<void> {
    if (!this.notification.isEnabled()) return;

    const params = this.config.params();
    if (!params.opportunityAlertEnabled) return;

    try {
      await this.findAndOffer();
    } catch (err) {
      // Pengawas yang gagal tidak boleh menghentikan apa pun; ia hanya
      // kehilangan satu putaran.
      this.logger.warn(`Pengawasan peluang gagal: ${(err as Error).message}`);
    }
  }

  /** Dipakai juga oleh perintah Telegram untuk memeriksa sekarang. */
  async findAndOffer(): Promise<{ offered: string[]; considered: number; skipped: string[] }> {
    const params = this.config.params();
    const skipped: string[] = [];

    // Kill switch dan jeda manual dihormati: menawarkan entry saat bot sendiri
    // dilarang membuka posisi hanya akan berakhir dengan penolakan.
    const kill = await this.risk.checkKillSwitch();
    if (kill.halted) {
      return {
        offered: [],
        considered: 0,
        skipped: [`kill switch aktif: ${kill.reasons.join('; ')}`],
      };
    }

    /**
     * Pemindaian dibatasi pada TRADING_PAIRS bila daftarnya DISETEL EKSPLISIT.
     *
     * Sebelumnya pengawas selalu memindai seluruh pasar. Akibatnya nyata: pada
     * 2026-10-09 ia menawarkan MUBARAKIDR padahal operator sudah menyetel
     * `TRADING_PAIRS=fartcoinidr,dogeidr` berdasarkan hasil backtest. MUBARAK
     * memang likuid, tetapi tidak pernah diuji sama sekali — dan ordernya
     * gagal karena presisi kuantitas yang hanya diketahui setelah dicoba.
     *
     * Menyetel daftar pair secara eksplisit adalah keputusan sadar untuk
     * membatasi diri pada yang sudah diperiksa. Pengawas harus menghormatinya.
     * Dengan `TRADING_PAIRS=auto`, pemindaian tetap mencakup seluruh pasar.
     */
    const explicitPairs = this.universe.isAuto ? undefined : this.config.params().tradingPairs;
    const result = await this.scanner.scan({ direction: 'LONG', pairs: explicitPairs });

    const open = await this.trades.find({
      where: { status: In(['OPEN', 'CLOSING']) },
      select: ['pair'],
    });
    const alreadyHeld = new Set(open.map((t) => t.pair.toLowerCase()));

    // Urutan filter ini penting. `hits` dari scanner memuat SELURUH kondisi
    // yang layak diperhatikan, termasuk yang keputusannya NO_TRADE — pada
    // pemindaian nyata, 57 dari 57 hit berstatus NO_TRADE sementara satu di
    // antaranya berskor 71. Menyaring dengan skor lebih dulu akan meloloskan
    // setup yang kemudian ditolak Risk Engine, dan operator belajar
    // mengabaikan notifikasi yang ujungnya penolakan.
    //
    // Keputusan analitis diperiksa LEBIH DULU; skor hanya penyaring tambahan
    // di atasnya.
    const tradeable = result.hits.filter(
      (h) => h.decision === 'TRADE_SETUP' || h.decision === 'HIGH_QUALITY_SETUP',
    );

    const candidates = tradeable
      .filter((h) => h.score >= params.opportunityMinScore)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) {
      // Dibedakan dengan jelas: tidak ada setup sama sekali adalah keadaan
      // yang berbeda dari ada setup tetapi skornya kurang.
      const best = result.hits.reduce((m, h) => Math.max(m, h.score), 0);
      skipped.push(
        tradeable.length
          ? `${tradeable.length} setup ada, tetapi skor tertinggi ${best} di bawah ambang ${params.opportunityMinScore}`
          : `tidak ada setup yang layak dari ${result.hits.length} kondisi terpantau (skor tertinggi ${best}, semuanya NO_TRADE)`,
      );
    }

    const offered: string[] = [];

    for (const hit of candidates) {
      if (offered.length >= params.opportunityMaxPerScan) break;

      const pair = hit.pair.toLowerCase();

      if (alreadyHeld.has(pair)) {
        skipped.push(`${pair}: sudah ada posisi`);
        continue;
      }

      const last = this.lastOffered.get(pair) ?? 0;
      const cooldownMs = params.opportunityCooldownHours * 3_600_000;
      if (Date.now() - last < cooldownMs) {
        skipped.push(`${pair}: masih dalam masa tenang`);
        continue;
      }

      const plan = await this.buildPlan(pair, hit.score);
      if (plan.ok !== true) {
        // Alasan aslinya dibawa apa adanya: "ditolak Risk Engine" tanpa sebab
        // tidak bisa dibedakan dari bug.
        skipped.push(`${pair}: ${plan.reason}`);
        continue;
      }

      await this.tradeConfirm.offer(pair, plan.message);
      this.lastOffered.set(pair, Date.now());
      offered.push(pair);

      this.logger.log(`Peluang ditawarkan: ${pair.toUpperCase()} skor ${hit.score}`);
    }

    return { offered, considered: candidates.length, skipped };
  }

  /**
   * Susun tawaran lengkap, atau null bila Risk Engine menolaknya.
   *
   * Angka di sini datang dari Risk Engine yang sama dengan jalur otomatis, jadi
   * yang dilihat operator adalah yang benar-benar akan dipakai — bukan taksiran
   * terpisah yang bisa menyimpang saat tombolnya ditekan.
   */
  private async buildPlan(
    pair: string,
    score: number,
  ): Promise<{ ok: true; message: string } | { ok: false; reason: string }> {
    const ticker = await this.indodax.getTicker(pair).catch(() => null);
    if (!ticker) return { ok: false, reason: 'harga tidak terbaca' };

    const params = this.config.params();
    const price = ticker.last;

    // Stop sementara dari persen minimum; Risk Engine akan memakai ATR bila
    // tersedia saat tombolnya benar-benar ditekan.
    const stopLoss = price * (1 - params.minStopPercent / 100);

    const decision = await this.risk.evaluateEntry(pair, price, stopLoss, 0);
    if (!decision.allowed) {
      return { ok: false, reason: decision.reason ?? 'ditolak Risk Engine' };
    }

    const levels = this.risk.takeProfitPlan(price, decision.initialRiskPerUnit);
    const rr = levels.length ? levels[levels.length - 1].atR : 0;

    const message = [
      `🎯 *PELUANG — ${pair.toUpperCase()}*`,
      '',
      `Skor analisis: *${score}/100*`,
      `Harga sekarang: Rp ${fmtPrice(price)}`,
      '',
      '*Rencana yang sudah dihitung:*',
      '```',
      `  Beli      ${idr(decision.positionSize)}`,
      `  Stop loss Rp ${fmtPrice(decision.stopLossPrice)}`,
      ...levels.map(
        (l) => `  TP${l.level}       Rp ${fmtPrice(l.price)}  jual ${l.closePercent}%`,
      ),
      `  Risiko    ${idr(decision.riskAmountIdr)}`,
      `  Imbalan   1 : ${rr.toFixed(1)}`,
      '```',
      `Mode: *${this.config.mode}*`,
      '',
      '_Tekan BUY untuk melihat rincian akhir. Order baru dikirim setelah_',
      '_konfirmasi kedua — satu ketukan tidak akan memesan apa pun._',
    ].join('\n');

    return { ok: true, message };
  }
}
