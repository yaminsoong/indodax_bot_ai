import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ChartBuilderService } from './chart-builder.service';
import { OrderProgressService, OrderProgressState } from './order-progress.service';
import { AnalysisService } from '../analysis/analysis.service';
import { TradingService } from '../trading/trading.service';
import { RiskService } from '../trading/risk.service';
import { BotConfigService } from '../config/bot-config.service';
import { MarketIntelligenceService } from '../market-intelligence/market-intelligence.service';
import { IndodaxService } from '../indodax/indodax.service';
import { fmtPrice, idr } from '../common/num';

interface PendingOrder {
  /**
   * Identitas usulan ini.
   *
   * Usulan disimpan ber-key pair, jadi menekan BUY dua kali untuk pair yang
   * sama menimpa yang pertama — sementara KARTU lamanya masih tertera di layar
   * dengan angka lama. Menekan CONFIRM di kartu itu akan mengeksekusi rencana
   * yang berbeda dari yang ditampilkan. Id ini dibawa di dalam tombol sehingga
   * kartu basi dapat dikenali dan ditolak.
   */
  id: string;
  pair: string;
  price: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  quantity: number;
  riskIdr: number;
  riskReward: number;
  createdAt: number;
}

/** Usulan kedaluwarsa setelah ini; harga pasar sudah bergerak terlalu jauh. */
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Pergeseran harga maksimum antara usulan dan konfirmasi.
 *
 * Dipasang di bawah jarak stop tersempit yang lazim (sekitar 0,8%) supaya
 * pergeseran tidak pernah memakan porsi berarti dari ruang risiko sebelum
 * posisi bahkan dibuka.
 */
const MAX_PRICE_DRIFT_PERCENT = 0.5;

/**
 * Tombol Telegram dan konfirmasi dua langkah sebelum order dikirim.
 *
 * Alur yang disengaja: tombol BUY TIDAK langsung memesan. Ia menampilkan
 * rincian lengkap — ukuran, risiko rupiah, rasio imbalan — lalu meminta
 * konfirmasi kedua. Satu ketukan tidak sengaja di ponsel tidak boleh
 * mengirim uang sungguhan ke pasar.
 *
 * Usulan juga kedaluwarsa. Menekan CONFIRM pada pesan setengah jam lalu akan
 * mengeksekusi perhitungan yang dibuat untuk harga yang sudah tidak ada.
 */
@Injectable()
export class TradeConfirmService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradeConfirmService.name);
  private readonly pending = new Map<string, PendingOrder>();

  constructor(
    private readonly notification: NotificationService,
    private readonly charts: ChartBuilderService,
    private readonly progress: OrderProgressService,
    private readonly analysis: AnalysisService,
    private readonly trading: TradingService,
    private readonly risk: RiskService,
    private readonly config: BotConfigService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly indodax: IndodaxService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.notification.isEnabled()) return;

    this.notification.registerCallback('chart', (pair) => this.onChart(pair));
    this.notification.registerCallback('analyze', (pair) => this.onAnalyze(pair));
    this.notification.registerCallback('buy', (pair) => this.onBuy(pair));
    this.notification.registerCallback('confirm', (pair) => this.onConfirm(pair));
    this.notification.registerCallback('cancel', (pair) => this.onCancel(pair));

    this.logger.log('Tombol konfirmasi Telegram terdaftar');
  }

  /** Kirim sebuah peluang beserta tombolnya. */
  async offer(pair: string, headline: string): Promise<void> {
    await this.notification.sendWithButtons(headline, [
      [
        { label: '📊 Chart', data: `chart:${pair}` },
        { label: '🔍 Analisis', data: `analyze:${pair}` },
      ],
      [
        { label: '🟢 BUY', data: `buy:${pair}` },
        { label: '❌ Lewati', data: `cancel:${pair}` },
      ],
    ]);
  }

  // ─── Handler tombol ───────────────────────────────────────────────────────

  private async onChart(pair: string): Promise<void> {
    const image = await this.charts.build(pair);
    const ticker = await this.indodax.getTicker(pair).catch(() => null);
    await this.notification.sendChart(
      image,
      `*${pair.toUpperCase()}*${ticker ? ` — Rp ${fmtPrice(ticker.last)}` : ''}`,
    );
  }

  private async onAnalyze(pair: string): Promise<string> {
    const a = await this.analysis.analyzeNow(pair);
    if (!a) return `Tidak bisa menganalisis ${pair.toUpperCase()}.`;

    const lines = [
      `🔍 *${pair.toUpperCase()}*`,
      '',
      `Harga: Rp ${fmtPrice(a.price)} (${a.change24h >= 0 ? '+' : ''}${a.change24h.toFixed(2)}% 24j)`,
      `Sinyal: *${a.signal}* (${a.strength}%)`,
      `Tren: ${a.trend} · Regime: ${a.regime} · HTF: ${a.htfTrend}`,
      `RSI ${a.rsi.toFixed(1)} · ADX ${a.adx.toFixed(1)} · ATR ${a.atrPercent.toFixed(2)}% · Spread ${a.spreadPercent.toFixed(3)}%`,
    ];
    if (a.reasons?.length) lines.push('', '*Mendukung:*', ...a.reasons.slice(0, 5).map((r) => `  • ${r}`));
    if (a.blockedBy?.length) lines.push('', '*Menahan:*', ...a.blockedBy.slice(0, 5).map((r) => `  • ${r}`));
    return lines.join('\n');
  }

  /**
   * Langkah pertama: hitung dan tampilkan, JANGAN memesan.
   *
   * Perhitungannya melewati risk engine yang sama dengan jalur otomatis, jadi
   * angka yang dilihat operator adalah angka yang benar-benar akan dipakai —
   * bukan taksiran terpisah yang bisa menyimpang.
   */
  private async onBuy(pair: string): Promise<string> {
    const ticker = await this.indodax.getTicker(pair).catch(() => null);
    if (!ticker) return `Harga ${pair.toUpperCase()} tidak terbaca.`;

    const report = await this.intelligence.analyze(pair, { direction: 'LONG' }).catch(() => null);
    const price = ticker.last;

    // Stop dan target diambil dari analisis yang sama dengan jalur otomatis.
    const atr = report?.mtf?.timeframes?.[report.confluence.timeframe]?.indicators?.volatility?.atr;
    const params = this.config.params();
    const stopLoss =
      atr && atr > 0
        ? price - atr * params.atrStopMultiplier
        : price * (1 - params.minStopPercent / 100);

    const decision = await this.risk.evaluateEntry(pair, price, stopLoss, 0);
    if (!decision.allowed) {
      return `❌ *${pair.toUpperCase()}* tidak dapat dibuka\n\n${decision.reason}`;
    }

    const riskPerUnit = decision.initialRiskPerUnit;
    const plan = this.risk.takeProfitPlan(price, riskPerUnit);
    const riskReward = plan.length ? plan[plan.length - 1].atR : 0;

    const proposalId = Math.random().toString(36).slice(2, 8);

    this.pending.set(pair, {
      id: proposalId,
      pair,
      price,
      stopLoss: decision.stopLossPrice,
      takeProfit: decision.takeProfitPrice,
      positionSize: decision.positionSize,
      quantity: decision.quantity,
      riskIdr: decision.riskAmountIdr,
      riskReward,
      createdAt: Date.now(),
    });

    const text = [
      `⚠️ *KONFIRMASI ORDER*`,
      '',
      `*Pair:* ${pair.toUpperCase()}`,
      `*Mode:* ${this.config.mode}`,
      '',
      `*Harga:* Rp ${fmtPrice(price)}`,
      `*Ukuran:* ${idr(decision.positionSize)} (${decision.quantity.toFixed(8)})`,
      `*Stop loss:* Rp ${fmtPrice(decision.stopLossPrice)}`,
      '',
      ...plan.map((l) => `*TP${l.level}:* Rp ${fmtPrice(l.price)} — tutup ${l.closePercent}% (${l.atR}R)`),
      '',
      `*Risiko:* ${idr(decision.riskAmountIdr)}`,
      `*R:R:* 1 : ${riskReward.toFixed(1)}`,
      ...this.explainBlock(price, atr, decision, report),
      '',
      `_Usulan ini berlaku 5 menit._`,
    ].join('\n');

    await this.notification.sendWithButtons(text, [
      [
        { label: '✅ CONFIRM', data: `confirm:${pair}:${proposalId}` },
        { label: '❌ CANCEL', data: `cancel:${pair}:${proposalId}` },
      ],
    ]);
    return '';
  }

  /**
   * Bagian "kenapa" dan "dari mana angkanya" pada kartu order.
   *
   * Tanpa ini kartu hanya menampilkan hasil: harga, ukuran, stop, risiko.
   * Operator tidak punya cara menilai apakah angka itu masuk akal, dan ketika
   * sebuah usulan ditolak ia tidak bisa membedakan "aturannya bekerja" dari
   * "botnya rusak" - persis kebingungan yang terjadi pada ZEREBROIDR.
   *
   * Yang ditampilkan adalah ARITMETIKA yang benar-benar dipakai, bukan
   * ringkasan terpisah: jarak stop dari ATR, jatah risiko dari persentase
   * ekuitas, lalu ukuran sebagai hasil bagi keduanya. Angka yang bisa
   * dihitung ulang dengan tangan adalah angka yang bisa dipercaya.
   */
  private explainBlock(
    price: number,
    atr: number | undefined,
    decision: {
      stopLossPrice: number;
      positionSize: number;
      quantity: number;
      riskAmountIdr: number;
      initialRiskPerUnit: number;
    },
    report: { confluence?: { score?: number; regime?: string; decision?: string }; explanation?: { reasons?: string[]; risks?: string[] } } | null,
  ): string[] {
    const params = this.config.params();
    const out: string[] = [];

    const stopGap = price - decision.stopLossPrice;
    const stopPercent = price > 0 ? (stopGap / price) * 100 : 0;

    out.push('', '*— Strategi & penilaian —*', `Strategi: ${this.config.str('STRATEGY', 'bawaan')}`);

    if (report?.confluence) {
      const c = report.confluence;
      out.push(
        `Skor kualitas: ${c.score ?? '-'}/100 (${c.decision ?? '-'})`,
        `Kondisi pasar: ${c.regime ?? '-'}`,
        // Dinyatakan tegas: skor ini BUKAN peluang untung. Operator yang
        // membacanya sebagai probabilitas akan menaikkan ukuran posisi pada
        // skor tinggi, padahal skor tidak pernah menjanjikan itu.
        '_Skor = kualitas setup menurut aturan, BUKAN peluang untung._',
      );
    }

    const reasons = (report?.explanation?.reasons ?? []).slice(0, 4);
    if (reasons.length) {
      out.push('', '*— Kenapa dinilai layak —*', ...reasons.map((r) => `• ${r}`));
    }

    const risks = (report?.explanation?.risks ?? []).slice(0, 3);
    if (risks.length) {
      out.push('', '*— Yang perlu diwaspadai —*', ...risks.map((r) => `• ${r}`));
    }

    out.push('', '*— Dari mana angkanya —*');

    if (atr && atr > 0) {
      out.push(
        `1. ATR = Rp ${fmtPrice(atr)} (${((atr / price) * 100).toFixed(2)}% dari harga)`,
        `   _gejolak khas per bar; stop lebih rapat dari ini akan kena oleh_`,
        `   _gerakan normal, bukan karena analisanya salah_`,
        `2. Stop = harga − ATR × ${params.atrStopMultiplier} = Rp ${fmtPrice(decision.stopLossPrice)}`,
      );
    } else {
      out.push(
        `1. ATR tidak terbaca, dipakai stop minimum ${params.minStopPercent}%`,
        `2. Stop = Rp ${fmtPrice(decision.stopLossPrice)}`,
      );
    }

    out.push(
      `3. Jarak stop = Rp ${fmtPrice(stopGap)} per koin (${stopPercent.toFixed(2)}%)`,
      `4. Jatah risiko = ${params.riskPerTradePercent}% dari ekuitas = ${idr(decision.riskAmountIdr)}`,
      `5. Ukuran = ${idr(decision.riskAmountIdr)} ÷ Rp ${fmtPrice(stopGap)} = ${decision.quantity.toFixed(6)} koin`,
      `   = ${idr(decision.positionSize)}`,
      '',
      `_Bila stop kena, yang hilang ${idr(decision.riskAmountIdr)} — bukan ${idr(decision.positionSize)}._`,
    );

    return out;
  }

  /** Langkah kedua: eksekusi, setelah memvalidasi ulang. */
  private async onConfirm(arg: string): Promise<string> {
    // Argumennya berbentuk "pair" (kartu lama) atau "pair:id" (kartu berid).
    const [pair, proposalId] = arg.split(':');

    const order = this.pending.get(pair);
    if (!order) {
      return `Tidak ada usulan aktif untuk ${pair.toUpperCase()}. Tekan BUY lagi.`;
    }

    /**
     * Kartu yang sudah digantikan usulan lebih baru ditolak.
     *
     * Tanpa pemeriksaan ini, menekan CONFIRM pada kartu lama mengeksekusi
     * rencana TERBARU sambil menampilkan angka LAMA — operator menyetujui
     * sesuatu yang berbeda dari yang terjadi.
     */
    if (proposalId && order.id && proposalId !== order.id) {
      return [
        `⚠️ *${pair.toUpperCase()} — kartu ini sudah digantikan*`,
        '',
        'Ada usulan yang lebih baru untuk pair ini, jadi angka di kartu',
        'ini bukan lagi rencana yang berlaku.',
        '',
        '_Pakai kartu terbaru, atau tekan BUY lagi._',
      ].join('\n');
    }

    this.pending.delete(pair);

    if (Date.now() - order.createdAt > PENDING_TTL_MS) {
      return `⏱️ Usulan ${pair.toUpperCase()} sudah kedaluwarsa. Tekan BUY lagi untuk perhitungan baru.`;
    }

    // Risiko diperiksa ULANG tepat sebelum eksekusi: antara penawaran dan
    // konfirmasi, posisi lain bisa terbuka, kill switch bisa aktif, atau
    // saldo bisa berubah.
    /**
     * Harga diambil ULANG, dan seluruh pemeriksaan memakai harga itu.
     *
     * Sebelumnya `evaluateEntry` dipanggil dengan `order.price` — harga saat
     * tombol BUY ditekan, yang bisa berumur lima menit. Lebih jauh lagi,
     * eksekusinya memakai penutupan bar tertutup terakhir, yang pada timeframe
     * 60 menit bisa berumur hampir satu jam.
     *
     * Jadi ada TIGA harga berbeda dalam satu alur: yang dilihat operator, yang
     * divalidasi, dan yang dipesan. Untuk uang sungguhan ketiganya harus satu.
     */
    const ticker = await this.indodax.getTicker(pair).catch(() => null);
    if (!ticker?.last) {
      return `Dibatalkan - harga ${pair.toUpperCase()} tidak terbaca saat konfirmasi.`;
    }

    const livePrice = ticker.last;
    const driftPercent = ((livePrice - order.price) / order.price) * 100;

    // Pergeseran melebihi toleransi membatalkan usulan: stop, target, ukuran,
    // dan risiko rupiah seluruhnya diturunkan dari harga saat usulan dibuat.
    // Mengeksekusinya berarti memesan sesuatu yang tidak pernah disetujui.
    if (Math.abs(driftPercent) > MAX_PRICE_DRIFT_PERCENT) {
      return [
        `⚠️ *${pair.toUpperCase()} — harga sudah bergerak*`,
        '',
        '```',
        `  saat usulan  Rp ${fmtPrice(order.price)}`,
        `  sekarang     Rp ${fmtPrice(livePrice)}`,
        `  selisih      ${driftPercent >= 0 ? '+' : ''}${driftPercent.toFixed(2)}%  (batas ${MAX_PRICE_DRIFT_PERCENT}%)`,
        '```',
        'Order dibatalkan. Stop loss, target, dan ukuran posisi dihitung',
        'dari harga lama, jadi tidak lagi menggambarkan trade ini.',
        '',
        '_Tekan BUY lagi untuk perhitungan baru._',
      ].join('\n');
    }

    // Stop digeser mengikuti harga baru agar JARAK risikonya tetap sama dengan
    // yang disetujui operator, bukan jaraknya yang ikut berubah.
    const stopDistance = order.price - order.stopLoss;
    const liveStop = livePrice - stopDistance;

    const recheck = await this.risk.evaluateEntry(pair, livePrice, liveStop, 0);
    if (!recheck.allowed) {
      return `❌ Dibatalkan — kondisi berubah sejak usulan dibuat:\n\n${recheck.reason}`;
    }

    /**
     * Laporan hidup dibuka SEBELUM order dikirim.
     *
     * Order taker diberi waktu 90 detik dan maker sampai 5 menit. Tanpa
     * laporan ini, selama itu operator hanya melihat diam — dan tidak bisa
     * membedakan "sedang menunggu" dari "macet".
     *
     * Angka yang ditampilkan datang dari usulan yang sudah divalidasi ulang
     * tepat di atas, jadi ia memang angka yang dipakai order ini.
     */
    const base: OrderProgressState = {
      pair,
      phase: 'MENGIRIM_ORDER',
      // Angka dari recheck, bukan usulan lama - inilah yang dipesan.
      referencePrice: livePrice,
      positionSizeIdr: recheck.positionSize,
      riskIdr: recheck.riskAmountIdr,
      stopLossPrice: recheck.stopLossPrice,
    };

    const messageId = await this.progress.start(base);

    // Pemanggilan ini memblokir sampai order selesai atau timeout, jadi
    // pembaruan "menunggu" dijadwalkan terpisah agar laporannya tetap hidup.
    const timeoutSeconds = this.config.params().makerEntry
      ? this.config.params().makerFillTimeoutSeconds
      : this.config.params().orderFillTimeoutSeconds;

    const startedAt = Date.now();
    const progressTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const left = Math.max(0, timeoutSeconds - elapsed);
      // Kegagalan memperbarui laporan TIDAK boleh menggagalkan ordernya, dan
      // tidak boleh menjadi rejection tak tertangani yang mematikan proses.
      void this.progress
        .update(messageId, {
          ...base,
          phase: 'MENUNGGU_TERISI',
          secondsLeft: left,
        })
        .catch((err) =>
          this.logger.debug(`Pembaruan progres dilewati: ${(err as Error).message}`),
        );
    }, 15_000);

    try {
      const result = await this.trading.openManualPosition(pair, 'TELEGRAM_CONFIRM', livePrice);

      if (result.success) {
        await this.progress.update(messageId, { ...base, phase: 'TERISI' });
        return `✅ ${result.message}`;
      }

      if (result.missed) {
        // Limit maker memang dikirim, hanya tidak tersentuh harga.
        await this.progress.update(messageId, {
          ...base,
          phase: 'TIDAK_TERISI',
          failedAtPhase: 'MENUNGGU_TERISI',
        });
        return '';
      }

      await this.progress.update(messageId, {
        ...base,
        phase: 'DITOLAK',
        detail: result.message,
        // Penolakan aturan terjadi sebelum ada order yang dikirim; jangan
        // menampilkan "Mengirim ke Indodax" sebagai tercapai.
        failedAtPhase: result.reachedExchange ? 'MENUNGGU_TERISI' : 'MEMERIKSA_RISIKO',
      });
      return '';
    } finally {
      clearInterval(progressTicker);
    }
  }

  private async onCancel(arg: string): Promise<string> {
    const [pair] = arg.split(':');
    this.pending.delete(pair);
    return `Dilewati: ${pair.toUpperCase()}`;
  }
}
