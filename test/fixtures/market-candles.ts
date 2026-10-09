import { Candle } from '../../src/indodax/indodax.types';
import { CandleSet } from '../../src/market-intelligence/mtf/mtf.types';
import { Timeframe, TIMEFRAME_MINUTES } from '../../src/market-intelligence/market-intelligence.types';

/**
 * Pembangkit candle sintetis untuk pengujian Market Intelligence.
 *
 * Dibuat deterministik (tanpa Math.random) supaya kegagalan test selalu bisa
 * diulang. Gerakan acak ditiru dengan deret pseudo-acak berbenih tetap.
 */

/** Pseudo-acak sederhana, berbenih tetap - hasilnya selalu sama. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export interface SeriesOptions {
  bars: number;
  start?: number;
  /** Perubahan harga rata-rata per bar dalam persen. */
  driftPercent?: number;
  /** Amplitudo kebisingan per bar dalam persen. */
  noisePercent?: number;
  volume?: number;
  /** Detik per bar. */
  stepSeconds?: number;
  startTime?: number;
  seed?: number;
}

/** Deret candle dengan arah dan kebisingan yang bisa diatur. */
export function makeSeries(opts: SeriesOptions): Candle[] {
  const {
    bars,
    start = 100_000_000,
    driftPercent = 0,
    noisePercent = 0.3,
    volume = 100,
    stepSeconds = 3600,
    startTime = 1_700_000_000,
    seed = 42,
  } = opts;

  const rnd = seededRandom(seed);
  const out: Candle[] = [];
  let price = start;

  for (let i = 0; i < bars; i++) {
    const drift = price * (driftPercent / 100);
    const noise = price * (noisePercent / 100) * (rnd() - 0.5) * 2;
    const open = price;
    const close = Math.max(1, price + drift + noise);
    const spread = Math.abs(close - open) + price * (noisePercent / 200);
    const high = Math.max(open, close) + spread * rnd();
    const low = Math.min(open, close) - spread * rnd();

    out.push({
      // Waktu diselaraskan ke kelipatan stepSeconds agar agregasi harian rapi.
      time: startTime + i * stepSeconds,
      open,
      high,
      low,
      close,
      volume: volume * (0.7 + rnd() * 0.6),
    });
    price = close;
  }
  return out;
}

/** Tren naik yang mulus dan meyakinkan pada seluruh timeframe. */
export function bullishSet(bars = 260): CandleSet {
  const set: CandleSet = {};
  for (const tf of ['5m', '15m', '1H', '4H', '1D'] as Timeframe[]) {
    set[tf] = makeSeries({
      bars,
      driftPercent: 0.25,
      noisePercent: 0.15,
      stepSeconds: TIMEFRAME_MINUTES[tf] * 60,
      seed: 7 + TIMEFRAME_MINUTES[tf],
      volume: 120,
    });
  }
  return set;
}

/** Tren turun pada seluruh timeframe. */
export function bearishSet(bars = 260): CandleSet {
  const set: CandleSet = {};
  for (const tf of ['5m', '15m', '1H', '4H', '1D'] as Timeframe[]) {
    set[tf] = makeSeries({
      bars,
      driftPercent: -0.25,
      noisePercent: 0.15,
      stepSeconds: TIMEFRAME_MINUTES[tf] * 60,
      seed: 11 + TIMEFRAME_MINUTES[tf],
      volume: 120,
    });
  }
  return set;
}

/** Pasar datar tanpa arah. */
export function sidewaysSet(bars = 260): CandleSet {
  const set: CandleSet = {};
  for (const tf of ['5m', '15m', '1H', '4H', '1D'] as Timeframe[]) {
    set[tf] = makeSeries({
      bars,
      driftPercent: 0,
      noisePercent: 0.4,
      stepSeconds: TIMEFRAME_MINUTES[tf] * 60,
      seed: 23 + TIMEFRAME_MINUTES[tf],
      volume: 100,
    });
  }
  return set;
}

/** Timeframe besar bullish tetapi timeframe kecil berbalik turun. */
export function conflictingSet(bars = 260): CandleSet {
  return {
    '1D': makeSeries({ bars, driftPercent: 0.3, noisePercent: 0.15, stepSeconds: 86400, seed: 3 }),
    '4H': makeSeries({ bars, driftPercent: 0.3, noisePercent: 0.15, stepSeconds: 14400, seed: 5 }),
    '1H': makeSeries({ bars, driftPercent: -0.3, noisePercent: 0.15, stepSeconds: 3600, seed: 9 }),
    '15m': makeSeries({ bars, driftPercent: -0.3, noisePercent: 0.15, stepSeconds: 900, seed: 13 }),
    '5m': makeSeries({ bars, driftPercent: -0.3, noisePercent: 0.15, stepSeconds: 300, seed: 17 }),
  };
}
