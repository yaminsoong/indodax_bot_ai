import { Injectable } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { TechnicalService } from '../../indicators/technical.service';
import { mean } from '../../common/num';
import { Direction, Timeframe } from '../market-intelligence.types';
import {
  IndicatorReport,
  MaybeNumber,
  MomentumIndicators,
  PriceIndicators,
  TrendIndicators,
  VolatilityIndicators,
  VolumeIndicators,
} from './indicator.types';

/** Ambang default; semuanya bisa ditimpa lewat konfigurasi pemanggil. */
export interface IndicatorThresholds {
  /** Kelipatan rata-rata volume yang dianggap lonjakan. */
  volumeSpikeRatio: number;
  /** Perubahan minimum (rasio) sebelum volume/volatilitas disebut melebar atau menyempit. */
  expansionRatio: number;
  /** Persentil lebar Bollinger yang dianggap squeeze. */
  squeezePercentile: number;
}

export const DEFAULT_THRESHOLDS: IndicatorThresholds = {
  volumeSpikeRatio: 2.0,
  expansionRatio: 1.2,
  squeezePercentile: 0.25,
};

/**
 * Indicator Engine.
 *
 * Aturan yang dipegang lapisan ini (bagian 1 spesifikasi):
 *  - deterministik: input candle yang sama selalu menghasilkan output sama;
 *  - tidak melakukan panggilan API sendiri - candle selalu dipasok pemanggil;
 *  - tidak tahu apa-apa soal UI, database, maupun order;
 *  - indikator yang sudah ada di TechnicalService DIPAKAI ULANG, tidak disalin.
 *    Hanya indikator yang belum ada (Stochastic, VWAP, analitik volume) yang
 *    diimplementasikan di sini.
 *
 * Kontrak penting: candle yang masuk harus SUDAH TERTUTUP. Menghitung indikator
 * pada candle berjalan membuat nilainya berubah-ubah dalam satu periode
 * (repainting) dan membuat hasil backtest tidak bisa direproduksi.
 */
@Injectable()
export class IndicatorEngineService {
  constructor(private readonly technical: TechnicalService) {}

  // --- Indikator baru (belum ada di TechnicalService) ----------------------

  /**
   * Stochastic Oscillator %K/%D.
   *
   * %K = posisi close dalam rentang high-low `period` bar terakhir.
   * %D = SMA dari %K sepanjang `smoothD`.
   */
  calculateStochastic(
    candles: Candle[],
    period = 14,
    smoothK = 3,
    smoothD = 3,
  ): { k: MaybeNumber; d: MaybeNumber } {
    if (candles.length < period + smoothK + smoothD) return { k: null, d: null };

    const rawK: number[] = [];
    for (let i = period - 1; i < candles.length; i++) {
      const window = candles.slice(i - period + 1, i + 1);
      const high = Math.max(...window.map((c) => c.high));
      const low = Math.min(...window.map((c) => c.low));
      const range = high - low;
      // Rentang nol (harga benar-benar datar) tidak bisa dinormalisasi;
      // 50 adalah titik netral yang jujur, bukan 0 atau 100.
      rawK.push(range === 0 ? 50 : ((candles[i].close - low) / range) * 100);
    }

    const smoothedK = this.technical.calculateSMA(rawK, smoothK);
    if (!smoothedK.length) return { k: null, d: null };

    const dSeries = this.technical.calculateSMA(smoothedK, smoothD);

    return {
      k: smoothedK[smoothedK.length - 1],
      d: dSeries.length ? dSeries[dSeries.length - 1] : null,
    };
  }

  /**
   * VWAP sesi berjalan, direset pada batas hari UTC.
   *
   * VWAP yang dihitung dari seluruh riwayat candle tidak bermakna: ia menjadi
   * rata-rata bertahun-tahun yang tidak pernah disentuh harga. Yang berguna bagi
   * trader adalah VWAP sejak pembukaan sesi berjalan.
   */
  calculateVWAP(candles: Candle[]): MaybeNumber {
    if (!candles.length) return null;

    const lastTime = candles[candles.length - 1].time;
    const dayStart = Math.floor(lastTime / 86400) * 86400;
    const session = candles.filter((c) => c.time >= dayStart);
    if (!session.length) return null;

    let pv = 0;
    let vol = 0;
    for (const c of session) {
      const typical = (c.high + c.low + c.close) / 3;
      pv += typical * c.volume;
      vol += c.volume;
    }
    // Sesi tanpa volume sama sekali (pair sepi) tidak punya VWAP yang sahih.
    if (vol <= 0) return null;
    return pv / vol;
  }

  /** Rata-rata volume `period` bar terakhir. */
  calculateVolumeMa(candles: Candle[], period = 20): MaybeNumber {
    if (candles.length < period) return null;
    return mean(candles.slice(-period).map((c) => c.volume));
  }

  /**
   * Volume sedang melebar atau menyempit.
   *
   * Dibandingkan rata-rata paruh terakhir terhadap paruh sebelumnya, bukan satu
   * candle terhadap rata-rata - satu candle terlalu berisik untuk menyatakan
   * arah partisipasi pasar.
   */
  volumeState(
    candles: Candle[],
    period = 20,
    expansionRatio = DEFAULT_THRESHOLDS.expansionRatio,
  ): 'EXPANDING' | 'CONTRACTING' | 'STABLE' {
    if (candles.length < period * 2) return 'STABLE';
    const recent = mean(candles.slice(-period).map((c) => c.volume));
    const prior = mean(candles.slice(-period * 2, -period).map((c) => c.volume));
    if (prior <= 0) return 'STABLE';

    const ratio = recent / prior;
    if (ratio >= expansionRatio) return 'EXPANDING';
    if (ratio <= 1 / expansionRatio) return 'CONTRACTING';
    return 'STABLE';
  }

  // --- Laporan lengkap satu timeframe --------------------------------------

  /**
   * Hitung seluruh indikator untuk satu timeframe.
   *
   * @param candles candle yang SUDAH TERTUTUP, urut menaik menurut waktu.
   */
  analyze(
    timeframe: Timeframe,
    candles: Candle[],
    thresholds: IndicatorThresholds = DEFAULT_THRESHOLDS,
  ): IndicatorReport | null {
    if (!candles.length) return null;

    const unavailable: string[] = [];
    const closes = candles.map((c) => c.close);
    const lastBar = candles[candles.length - 1];
    const price = lastBar.close;

    const need = (name: string, minBars: number): boolean => {
      if (candles.length < minBars) {
        unavailable.push(`${name} (butuh ${minBars} bar, tersedia ${candles.length})`);
        return false;
      }
      return true;
    };

    const emaOf = (period: number): MaybeNumber => {
      if (!need(`EMA${period}`, period)) return null;
      const series = this.technical.calculateEMA(closes, period);
      return series.length ? series[series.length - 1] : null;
    };
    const smaOf = (period: number): MaybeNumber => {
      if (!need(`SMA${period}`, period)) return null;
      const series = this.technical.calculateSMA(closes, period);
      return series.length ? series[series.length - 1] : null;
    };

    // -- Tren --------------------------------------------------------------
    const ema9 = emaOf(9);
    const ema21 = emaOf(21);
    const ema50 = emaOf(50);
    const ema200 = emaOf(200);
    const sma50 = smaOf(50);
    const sma200 = smaOf(200);

    let emaStack: Direction = 'NEUTRAL';
    if (ema9 !== null && ema21 !== null && ema50 !== null) {
      if (ema9 > ema21 && ema21 > ema50) emaStack = 'BULLISH';
      else if (ema9 < ema21 && ema21 < ema50) emaStack = 'BEARISH';
    }

    const trend: TrendIndicators = {
      ema9,
      ema21,
      ema50,
      ema200,
      sma50,
      sma200,
      emaStack,
      priceVsEma200Percent: ema200 !== null && ema200 > 0 ? ((price - ema200) / ema200) * 100 : null,
      maCross: sma50 !== null && sma200 !== null ? (sma50 > sma200 ? 'GOLDEN' : 'DEATH') : 'NONE',
    };

    // -- Momentum ----------------------------------------------------------
    const rsiSeries = need('RSI14', 15) ? this.technical.calculateRSI(closes, 14) : [];
    const macdRaw = need('MACD', 35)
      ? this.technical.calculateMACD(closes)
      : { macd: [], signal: [], histogram: [] };
    // ADX Wilder butuh 2 x period + 1 bar sebelum nilainya bermakna.
    const hasDmi = need('ADX', 29);
    const dmi = hasDmi
      ? this.technical.calculateDMI(candles, 14)
      : { adx: 0, plusDi: 0, minusDi: 0 };

    const momentum: MomentumIndicators = {
      rsi14: tail(rsiSeries),
      macd: {
        macd: tail(macdRaw.macd),
        signal: tail(macdRaw.signal),
        histogram: tail(macdRaw.histogram),
      },
      macdHistogramPrev: tail(macdRaw.histogram, 2),
      stochastic: this.calculateStochastic(candles),
      adx: hasDmi ? dmi.adx : null,
      plusDi: hasDmi ? dmi.plusDi : null,
      minusDi: hasDmi ? dmi.minusDi : null,
    };

    // -- Volatilitas -------------------------------------------------------
    const atrSeries = need('ATR14', 15) ? this.technical.calculateATRSeries(candles, 14) : [];
    const atr14 = tail(atrSeries);
    const atrAvg = atrSeries.length >= 50 ? mean(atrSeries.slice(-50)) : null;

    const bbReady = need('Bollinger', 20);
    const bb = bbReady
      ? this.technical.calculateBollinger(closes, 20, 2)
      : { upper: 0, middle: 0, lower: 0, widthPercent: 0 };

    const widthHistory = bbReady ? this.bollingerWidthHistory(closes, 20, 2, 100) : [];
    const squeeze =
      widthHistory.length >= 20 &&
      bb.widthPercent <= percentile(widthHistory, thresholds.squeezePercentile);

    const volatility: VolatilityIndicators = {
      atr14,
      atrPercent: atr14 !== null && price > 0 ? (atr14 / price) * 100 : null,
      atrRatio: atr14 !== null && atrAvg !== null && atrAvg > 0 ? atr14 / atrAvg : null,
      bollinger: {
        upper: bbReady ? bb.upper : null,
        middle: bbReady ? bb.middle : null,
        lower: bbReady ? bb.lower : null,
        widthPercent: bbReady ? bb.widthPercent : null,
        percentB: bbReady && bb.upper > bb.lower ? (price - bb.lower) / (bb.upper - bb.lower) : null,
      },
      squeeze,
      state: this.volatilityState(atrSeries, thresholds.expansionRatio),
    };

    // -- Volume ------------------------------------------------------------
    const volumeMa20 = this.calculateVolumeMa(candles, 20);
    if (volumeMa20 === null) unavailable.push('VolumeMA20 (butuh 20 bar)');
    const relativeVolume = volumeMa20 !== null && volumeMa20 > 0 ? lastBar.volume / volumeMa20 : null;

    const volume: VolumeIndicators = {
      volume: lastBar.volume,
      volumeMa20,
      relativeVolume,
      spike: relativeVolume !== null && relativeVolume >= thresholds.volumeSpikeRatio,
      state: this.volumeState(candles, 20, thresholds.expansionRatio),
    };

    // -- Harga -------------------------------------------------------------
    const vwap = this.calculateVWAP(candles);
    const priceInd: PriceIndicators = {
      close: price,
      high: lastBar.high,
      low: lastBar.low,
      vwap,
      vwapDistancePercent: vwap !== null && vwap > 0 ? ((price - vwap) / vwap) * 100 : null,
    };

    return {
      timeframe,
      barTime: lastBar.time,
      bars: candles.length,
      trend,
      momentum,
      volatility,
      volume,
      price: priceInd,
      unavailable,
    };
  }

  // --- Utilitas internal ---------------------------------------------------

  /** Deret lebar Bollinger untuk menilai apakah band sedang menyempit. */
  private bollingerWidthHistory(
    closes: number[],
    period: number,
    mult: number,
    lookback: number,
  ): number[] {
    const out: number[] = [];
    const start = Math.max(period, closes.length - lookback);
    for (let i = start; i <= closes.length; i++) {
      const bb = this.technical.calculateBollinger(closes.slice(0, i), period, mult);
      out.push(bb.widthPercent);
    }
    return out;
  }

  private volatilityState(
    atrSeries: number[],
    expansionRatio: number,
  ): 'EXPANDING' | 'CONTRACTING' | 'STABLE' {
    if (atrSeries.length < 20) return 'STABLE';
    const recent = mean(atrSeries.slice(-10));
    const prior = mean(atrSeries.slice(-20, -10));
    if (prior <= 0) return 'STABLE';
    const ratio = recent / prior;
    if (ratio >= expansionRatio) return 'EXPANDING';
    if (ratio <= 1 / expansionRatio) return 'CONTRACTING';
    return 'STABLE';
  }
}

/** Nilai ke-`fromEnd` dari belakang; null bila tidak ada. */
function tail(series: number[], fromEnd = 1): MaybeNumber {
  return series.length >= fromEnd ? series[series.length - fromEnd] : null;
}

/** Persentil sederhana (pembulatan ke indeks terdekat) pada deret belum terurut. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}
