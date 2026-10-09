import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ChartBuilderService } from './chart-builder.service';
import { AnalysisService } from '../analysis/analysis.service';
import { TradingService } from '../trading/trading.service';
import { RiskService } from '../trading/risk.service';
import { BotConfigService } from '../config/bot-config.service';
import { MarketIntelligenceService } from '../market-intelligence/market-intelligence.service';
import { IndodaxService } from '../indodax/indodax.service';
import { fmtPrice, idr } from '../common/num';

interface PendingOrder {
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

    this.pending.set(pair, {
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
      '',
      `_Usulan ini berlaku 5 menit._`,
    ].join('\n');

    await this.notification.sendWithButtons(text, [
      [
        { label: '✅ CONFIRM', data: `confirm:${pair}` },
        { label: '❌ CANCEL', data: `cancel:${pair}` },
      ],
    ]);
    return '';
  }

  /** Langkah kedua: eksekusi, setelah memvalidasi ulang. */
  private async onConfirm(pair: string): Promise<string> {
    const order = this.pending.get(pair);
    if (!order) {
      return `Tidak ada usulan aktif untuk ${pair.toUpperCase()}. Tekan BUY lagi.`;
    }

    this.pending.delete(pair);

    if (Date.now() - order.createdAt > PENDING_TTL_MS) {
      return `⏱️ Usulan ${pair.toUpperCase()} sudah kedaluwarsa. Tekan BUY lagi untuk perhitungan baru.`;
    }

    // Risiko diperiksa ULANG tepat sebelum eksekusi: antara penawaran dan
    // konfirmasi, posisi lain bisa terbuka, kill switch bisa aktif, atau
    // saldo bisa berubah.
    const recheck = await this.risk.evaluateEntry(pair, order.price, order.stopLoss, order.takeProfit);
    if (!recheck.allowed) {
      return `❌ Dibatalkan — kondisi berubah sejak usulan dibuat:\n\n${recheck.reason}`;
    }

    const result = await this.trading.openManualPosition(pair, 'TELEGRAM_CONFIRM');
    return result.success
      ? `✅ ${result.message}`
      : `❌ Order ${pair.toUpperCase()} gagal: ${result.message}`;
  }

  private async onCancel(pair: string): Promise<string> {
    this.pending.delete(pair);
    return `Dilewati: ${pair.toUpperCase()}`;
  }
}
