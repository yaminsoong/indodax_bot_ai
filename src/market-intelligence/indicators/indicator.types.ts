import { Direction, Timeframe } from '../market-intelligence.types';

/**
 * Nilai indikator yang belum bisa dihitung dikembalikan sebagai `null`, bukan 0.
 *
 * EMA 200 pada data 120 candle tidak "bernilai nol" — nilainya belum ada.
 * Mengembalikan 0 membuat perbandingan `harga > ema200` selalu benar dan
 * menghasilkan sinyal bullish palsu pada pair yang riwayatnya pendek.
 */
export type MaybeNumber = number | null;

export interface TrendIndicators {
  ema9: MaybeNumber;
  ema21: MaybeNumber;
  ema50: MaybeNumber;
  ema200: MaybeNumber;
  sma50: MaybeNumber;
  sma200: MaybeNumber;
  /** Susunan EMA 9/21/50: naik berurutan = BULLISH, turun berurutan = BEARISH. */
  emaStack: Direction;
  /** Jarak harga terhadap EMA 200 dalam persen; null bila EMA 200 belum ada. */
  priceVsEma200Percent: MaybeNumber;
  /** SMA50 di atas SMA200 (golden cross) atau di bawahnya (death cross). */
  maCross: 'GOLDEN' | 'DEATH' | 'NONE';
}

export interface MomentumIndicators {
  rsi14: MaybeNumber;
  macd: { macd: MaybeNumber; signal: MaybeNumber; histogram: MaybeNumber };
  /** Histogram MACD candle sebelumnya — untuk melihat momentum menguat/melemah. */
  macdHistogramPrev: MaybeNumber;
  stochastic: { k: MaybeNumber; d: MaybeNumber };
  adx: MaybeNumber;
  plusDi: MaybeNumber;
  minusDi: MaybeNumber;
}

export interface VolatilityIndicators {
  atr14: MaybeNumber;
  /** ATR sebagai persen harga — satu-satunya bentuk ATR yang bisa dibandingkan antar pair. */
  atrPercent: MaybeNumber;
  /** ATR relatif terhadap rata-rata ATR 50 bar; > 1 berarti volatilitas di atas normal. */
  atrRatio: MaybeNumber;
  bollinger: {
    upper: MaybeNumber;
    middle: MaybeNumber;
    lower: MaybeNumber;
    widthPercent: MaybeNumber;
    /** Posisi harga dalam band: 0 = lower, 1 = upper. */
    percentB: MaybeNumber;
  };
  /** Lebar band di persentil terbawah riwayatnya — sering mendahului ekspansi. */
  squeeze: boolean;
  state: 'EXPANDING' | 'CONTRACTING' | 'STABLE';
}

export interface VolumeIndicators {
  volume: number;
  volumeMa20: MaybeNumber;
  /** Volume dibagi rata-ratanya. 1,0 = persis rata-rata. */
  relativeVolume: MaybeNumber;
  /** Lonjakan volume (>= ambang, default 2x rata-rata). */
  spike: boolean;
  state: 'EXPANDING' | 'CONTRACTING' | 'STABLE';
}

export interface PriceIndicators {
  close: number;
  high: number;
  low: number;
  /** VWAP sesi berjalan (dihitung ulang tiap batas hari UTC). */
  vwap: MaybeNumber;
  vwapDistancePercent: MaybeNumber;
}

/** Seluruh indikator untuk SATU timeframe pada SATU titik waktu. */
export interface IndicatorReport {
  timeframe: Timeframe;
  /** Waktu pembukaan candle terakhir yang SUDAH TERTUTUP (epoch detik). */
  barTime: number;
  bars: number;
  trend: TrendIndicators;
  momentum: MomentumIndicators;
  volatility: VolatilityIndicators;
  volume: VolumeIndicators;
  price: PriceIndicators;
  /** Indikator yang tidak bisa dihitung karena data kurang. */
  unavailable: string[];
}
