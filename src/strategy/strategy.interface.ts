import { Candle } from '../indodax/indodax.types';
import { IndicatorSet, OrderBookMetrics } from '../indicators/technical.service';
import { BotParams } from '../config/bot-config.service';

/** Semua yang dibutuhkan strategi untuk mengambil keputusan pada satu pair. */
export interface StrategyContext {
  pair: string;
  /** Candle timeframe utama, sudah tertutup (tanpa candle berjalan). */
  candles: Candle[];
  /** Candle timeframe lebih tinggi untuk filter arah tren; kosong bila tidak tersedia. */
  htfCandles: Candle[];
  /** Metrik order book; undefined saat backtest (tidak ada data historis). */
  orderBook?: OrderBookMetrics;
  /** Volume 24 jam dalam IDR; dipakai sebagai filter likuiditas. */
  volumeIdr24h?: number;
  params: BotParams;
  /** Apakah sudah ada posisi terbuka pada pair ini. */
  hasOpenPosition: boolean;
}

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface StrategySignal {
  action: SignalAction;
  /** 0-100. Dibandingkan dengan params.minSignalStrength sebelum dieksekusi. */
  strength: number;
  reasons: string[];
  /** Alasan sinyal ditolak filter — berguna untuk diagnosa mengapa bot pasif. */
  blockedBy: string[];
  /**
   * Zona harga tempat entry masih dianggap sah.
   *
   * Satu harga tunggal memaksa bot mengejar: pada saat order benar-benar
   * terkirim, harga sinyal sudah lewat. Zona menyatakan batas — di atas
   * `suggestedEntryHigh`, setup yang sama sudah bukan setup yang sama lagi.
   */
  suggestedEntryLow?: number;
  suggestedEntryHigh?: number;
  /** Harga stop loss usulan strategi (berbasis ATR/struktur), bukan persen tetap. */
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  indicators: IndicatorSet | null;
  /** Ringkasan indikator siap simpan ke database. */
  snapshot: IndicatorSnapshot;
}

export interface IndicatorSnapshot {
  price: number;
  ema5: number;
  ema13: number;
  ema21: number;
  ema50: number;
  rsi: number;
  macdHistogram: number;
  atr: number;
  atrPercent: number;
  adx: number;
  choppiness: number;
  volume: number;
  volumeAvg: number;
  volumeRatio: number;
  trend: string;
  regime: string;
  htfTrend: string;
  orderBookImbalance: number;
}

/**
 * Syarat tambahan yang diminta sebuah strategi kepada Market Intelligence.
 *
 * Dipakai sebagai KONFIRMASI, bukan pengganti logika strategi. Strategi tetap
 * menghasilkan sinyalnya sendiri persis seperti sebelumnya; profil ini hanya
 * menyatakan kondisi pasar seperti apa yang membuat sinyal itu layak dipercaya.
 */
export interface StrategyIntelligenceProfile {
  /** Regime pasar yang mendukung strategi ini. */
  favourableRegimes: string[];
  /** Regime yang membuat strategi ini secara struktural tidak cocok. */
  hostileRegimes: string[];
  /** Konfirmasi wajib sebelum entry diteruskan ke Risk Engine. */
  requires: IntelligenceRequirement[];
}

export type IntelligenceRequirement =
  /** Timeframe besar harus searah. */
  | 'TREND_ALIGNMENT'
  /** Volume harus mengonfirmasi (di atas rata-rata). */
  | 'VOLUME_CONFIRMATION'
  /** Harus ada BOS / breakout terkonfirmasi lewat close. */
  | 'STRUCTURE_BREAK'
  /** Pasar harus benar-benar sedang tanpa arah. */
  | 'RANGE_CONDITION'
  /** Harga harus berada di lokasi ekstrem rentang, bukan di tengah. */
  | 'EXTREME_LOCATION'
  /** Volatilitas harus cukup untuk memberi ruang profit. */
  | 'VOLATILITY_ROOM';

export interface TradingStrategy {
  /** Identitas unik, dipakai untuk atribusi performa per strategi. */
  readonly name: string;
  readonly description: string;
  /** Minimum candle yang dibutuhkan agar indikator valid. */
  readonly minCandles: number;
  /**
   * Konfirmasi Market Intelligence yang diminta strategi ini.
   * Opsional: strategi tanpa profil berjalan persis seperti sebelumnya.
   */
  readonly intelligenceProfile?: StrategyIntelligenceProfile;
  evaluate(ctx: StrategyContext): StrategySignal;
}

export function emptySnapshot(price = 0): IndicatorSnapshot {
  return {
    price,
    ema5: 0,
    ema13: 0,
    ema21: 0,
    ema50: 0,
    rsi: 50,
    macdHistogram: 0,
    atr: 0,
    atrPercent: 0,
    adx: 0,
    choppiness: 50,
    volume: 0,
    volumeAvg: 0,
    volumeRatio: 0,
    trend: 'NEUTRAL',
    regime: 'RANGING',
    htfTrend: 'UNKNOWN',
    orderBookImbalance: 0,
  };
}
