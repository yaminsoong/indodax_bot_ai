import { Injectable } from '@nestjs/common';
import { BotConfigService } from '../config/bot-config.service';
import { Timeframe, TIMEFRAMES } from './market-intelligence.types';
import {
  ConfluenceWeights,
  DEFAULT_NO_TRADE,
  DEFAULT_WEIGHTS,
  NoTradeThresholds,
} from './confluence/confluence.types';

/** Seluruh parameter Market Intelligence dalam satu tempat. */
export interface MarketIntelligenceParams {
  enabled: boolean;
  /**
   * Bila true, keputusan NO_TRADE dan skor di bawah minimum benar-benar
   * MENOLAK entry. Bila false, analisis tetap dihitung, dicatat, dan
   * ditampilkan - tetapi tidak memblokir apa pun.
   *
   * Mode tanpa penegakan berguna untuk mengumpulkan data: jalankan beberapa
   * minggu, lalu bandingkan hasil trade menurut bucket skor sebelum
   * mempercayai skor tersebut. Lihat bagian 15 spesifikasi.
   */
  enforce: boolean;
  timeframes: Timeframe[];
  /** Jumlah candle yang diambil per timeframe. */
  barsPerTimeframe: number;
  weights: ConfluenceWeights;
  noTrade: NoTradeThresholds;
  /** Skor minimum per strategi; kunci berupa nama strategi. */
  minScoreByStrategy: Record<string, number>;
  /** Skor minimum bila strategi tidak punya nilai khusus. */
  defaultMinScore: number;
  /** Simpan setiap analisis ke tabel signal_analysis. */
  auditEnabled: boolean;
  /** Kirim alert Telegram untuk setup berkualitas tinggi. */
  alertEnabled: boolean;
  /** Skor minimum sebelum alert dikirim. */
  alertMinScore: number;
  /** Volume 24 jam minimum (IDR) agar sebuah pair layak dipindai. */
  scannerMinVolumeIdr: number;
  /** Batas pair yang dianalisis penuh per pemindaian. */
  scannerMaxPairs: number;
  /** Skor minimum agar sebuah hasil pindai dilaporkan ke Telegram. */
  scannerAlertMinScore: number;
  /**
   * Gerbang FOMO menolak entry yang mengejar gerakan yang sudah terjadi.
   *
   * Dibaca di sini — bukan hanya di BotParams — karena Market Intelligence
   * memakai konfigurasinya sendiri, dan gerbangnya hidup di lapisan ini.
   */
  fomoGuardEnabled: boolean;
}

/** Skor minimum bawaan per strategi (bagian 7 spesifikasi). */
const DEFAULT_MIN_SCORE: Record<string, number> = {
  EMA_SCALPING_V2: 65,
  MEAN_REVERSION_BB: 70,
  DONCHIAN_BREAKOUT: 70,
};

/**
 * Konfigurasi Market Intelligence.
 *
 * Membaca dari sistem konfigurasi yang SUDAH ADA (BotConfigService), sehingga
 * seluruh nilai bisa diubah lewat dashboard atau Telegram saat bot berjalan dan
 * tetap bertahan setelah restart - tidak ada satu pun ambang yang di-hardcode.
 */
@Injectable()
export class MarketIntelligenceConfigService {
  constructor(private readonly config: BotConfigService) {}

  params(): MarketIntelligenceParams {
    return {
      enabled: this.config.bool('MI_ENABLED', true),
      enforce: this.config.bool('MI_ENFORCE', true),
      timeframes: this.timeframes(),
      barsPerTimeframe: this.config.num('MI_BARS_PER_TIMEFRAME', 300),
      weights: this.weights(),
      noTrade: this.noTrade(),
      minScoreByStrategy: this.minScores(),
      defaultMinScore: this.config.num('MI_MIN_SCORE_DEFAULT', 65),
      auditEnabled: this.config.bool('MI_AUDIT_ENABLED', true),
      alertEnabled: this.config.bool('MI_ALERT_ENABLED', true),
      alertMinScore: this.config.num('MI_ALERT_MIN_SCORE', 80),
      scannerMinVolumeIdr: this.config.num('SCANNER_MIN_VOLUME_IDR', 500_000_000),
      scannerMaxPairs: this.config.num('SCANNER_MAX_PAIRS', 25),
      scannerAlertMinScore: this.config.num('SCANNER_ALERT_MIN_SCORE', 70),
      fomoGuardEnabled: this.config.bool('FOMO_GUARD_ENABLED', true),
    };
  }

  /** Skor minimum untuk satu strategi. */
  minScoreFor(strategy: string): number {
    const key = `MI_MIN_SCORE_${strategy.toUpperCase()}`;
    const fallback = DEFAULT_MIN_SCORE[strategy] ?? this.config.num('MI_MIN_SCORE_DEFAULT', 65);
    return this.config.num(key, fallback);
  }

  private timeframes(): Timeframe[] {
    const raw = this.config.str('MI_TIMEFRAMES', '5m,15m,1H,4H,1D');
    const wanted = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const valid = wanted.filter((t): t is Timeframe => (TIMEFRAMES as string[]).includes(t));
    // Konfigurasi yang salah ketik tidak boleh membuat analisis diam-diam kosong.
    return valid.length ? valid : [...TIMEFRAMES];
  }

  private weights(): ConfluenceWeights {
    return {
      TREND_ALIGNMENT: this.config.num('MI_WEIGHT_TREND', DEFAULT_WEIGHTS.TREND_ALIGNMENT),
      MARKET_STRUCTURE: this.config.num('MI_WEIGHT_STRUCTURE', DEFAULT_WEIGHTS.MARKET_STRUCTURE),
      MOMENTUM: this.config.num('MI_WEIGHT_MOMENTUM', DEFAULT_WEIGHTS.MOMENTUM),
      VOLUME: this.config.num('MI_WEIGHT_VOLUME', DEFAULT_WEIGHTS.VOLUME),
      SUPPORT_RESISTANCE: this.config.num('MI_WEIGHT_SR', DEFAULT_WEIGHTS.SUPPORT_RESISTANCE),
      VOLATILITY: this.config.num('MI_WEIGHT_VOLATILITY', DEFAULT_WEIGHTS.VOLATILITY),
      ORDER_BOOK: this.config.num('MI_WEIGHT_ORDERBOOK', DEFAULT_WEIGHTS.ORDER_BOOK),
      RISK_REWARD: this.config.num('MI_WEIGHT_RISK_REWARD', DEFAULT_WEIGHTS.RISK_REWARD),
    };
  }

  private noTrade(): NoTradeThresholds {
    return {
      minRiskReward: this.config.num('MI_MIN_RISK_REWARD', DEFAULT_NO_TRADE.minRiskReward),
      minResistanceDistancePercent: this.config.num(
        'MI_MIN_RESISTANCE_DISTANCE_PERCENT',
        DEFAULT_NO_TRADE.minResistanceDistancePercent,
      ),
      maxSupportDistancePercent: this.config.num(
        'MI_MAX_SUPPORT_DISTANCE_PERCENT',
        DEFAULT_NO_TRADE.maxSupportDistancePercent,
      ),
      maxAtrPercent: this.config.num('MI_MAX_ATR_PERCENT', DEFAULT_NO_TRADE.maxAtrPercent),
      minAtrPercent: this.config.num('MI_MIN_ATR_PERCENT', DEFAULT_NO_TRADE.minAtrPercent),
      minRelativeVolume: this.config.num(
        'MI_MIN_RELATIVE_VOLUME',
        DEFAULT_NO_TRADE.minRelativeVolume,
      ),
      midRangeLow: this.config.num('MI_MID_RANGE_LOW', DEFAULT_NO_TRADE.midRangeLow),
      midRangeHigh: this.config.num('MI_MID_RANGE_HIGH', DEFAULT_NO_TRADE.midRangeHigh),
      maxTimeframeConflicts: this.config.num(
        'MI_MAX_TIMEFRAME_CONFLICTS',
        DEFAULT_NO_TRADE.maxTimeframeConflicts,
      ),
    };
  }

  private minScores(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of Object.keys(DEFAULT_MIN_SCORE)) out[name] = this.minScoreFor(name);
    return out;
  }

  /**
   * Peringatan konfigurasi yang layak ditampilkan ke operator.
   * Bobot yang tidak berjumlah 100 tetap bekerja (dinormalisasi), tetapi
   * hampir selalu berarti salah ketik.
   */
  warnings(): string[] {
    const out: string[] = [];
    const weights = this.weights();
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.01) {
      out.push(
        `Total bobot confluence ${total} (seharusnya 100). Skor tetap dinormalisasi, ` +
          `tetapi periksa kembali nilai MI_WEIGHT_*.`,
      );
    }
    const params = this.params();
    if (params.enabled && !params.enforce) {
      out.push(
        'MI_ENFORCE=false - Market Intelligence hanya mengamati dan mencatat, ' +
          'tidak menolak entry apa pun.',
      );
    }
    return out;
  }
}
