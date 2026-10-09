import { Injectable } from '@nestjs/common';
import { Candle, OrderBook } from '../indodax/indodax.types';
import { mean, stdev } from '../common/num';

export type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type Crossover = 'GOLDEN' | 'DEATH' | 'NONE';
export type Regime = 'TRENDING' | 'RANGING' | 'VOLATILE';

export interface IndicatorSet {
  ema5: number[];
  ema13: number[];
  ema21: number[];
  ema50: number[];
  rsi: number[];
  macd: { macd: number[]; signal: number[]; histogram: number[] };
  bollinger: { upper: number; middle: number; lower: number; widthPercent: number };
  adx: number;
  choppiness: number;
  atr: number;
  atrPercent: number;
  volumeAvg: number;
  currentVolume: number;
  volumeRatio: number;
  /** Swing low terakhir — dipakai sebagai kandidat stop loss struktural. */
  swingLow: number;
  swingHigh: number;
  trend: Trend;
  regime: Regime;
}

export interface OrderBookMetrics {
  /** > 0 berarti sisi beli lebih tebal, < 0 sisi jual lebih tebal. Rentang -1..1 */
  imbalance: number;
  spreadPercent: number;
  /** Total nilai IDR pada 10 level teratas tiap sisi. */
  bidDepthIdr: number;
  askDepthIdr: number;
}

@Injectable()
export class TechnicalService {
  // ─── Moving Averages ──────────────────────────────────────────────────────

  /**
   * EMA dengan seed SMA.
   *
   * Panjang hasil = prices.length - period + 1, sehingga elemen ke-i berpadanan
   * dengan prices[i + period - 1]. Gunakan `alignTail` bila perlu menyamakan
   * indeks antar dua EMA berbeda periode.
   */
  calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const k = 2 / (period + 1);
    const ema: number[] = [];

    const seed = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    ema.push(seed);

    for (let i = period; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
    }
    return ema;
  }

  calculateSMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const out: number[] = [];
    let sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum / period);
    for (let i = period; i < prices.length; i++) {
      sum += prices[i] - prices[i - period];
      out.push(sum / period);
    }
    return out;
  }

  /** Ambil N nilai terakhir dari beberapa seri sekaligus (menyamakan panjang). */
  private tail(series: number[], n = 1): number {
    return series.length >= n ? series[series.length - n] : NaN;
  }

  // ─── RSI (Wilder) ─────────────────────────────────────────────────────────

  calculateRSI(prices: number[], period = 14): number[] {
    if (prices.length < period + 1) return [];

    const rsi: number[] = [];
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return rsi;
  }

  // ─── MACD ─────────────────────────────────────────────────────────────────

  calculateMACD(
    prices: number[],
    fast = 12,
    slow = 26,
    signalPeriod = 9,
  ): { macd: number[]; signal: number[]; histogram: number[] } {
    const emaFast = this.calculateEMA(prices, fast);
    const emaSlow = this.calculateEMA(prices, slow);
    if (!emaFast.length || !emaSlow.length) return { macd: [], signal: [], histogram: [] };

    // Samakan indeks: EMA cepat punya lebih banyak nilai di depan.
    const offset = emaFast.length - emaSlow.length;
    const macd = emaSlow.map((slowVal, i) => emaFast[i + offset] - slowVal);

    const signal = this.calculateEMA(macd, signalPeriod);
    const sigOffset = macd.length - signal.length;
    const histogram = signal.map((s, i) => macd[i + sigOffset] - s);

    return { macd, signal, histogram };
  }

  // ─── Bollinger Bands ──────────────────────────────────────────────────────

  calculateBollinger(
    prices: number[],
    period = 20,
    mult = 2,
  ): { upper: number; middle: number; lower: number; widthPercent: number } {
    const window = prices.slice(-period);
    if (window.length < period) {
      const last = prices[prices.length - 1] ?? 0;
      return { upper: last, middle: last, lower: last, widthPercent: 0 };
    }
    const middle = mean(window);
    const sd = stdev(window);
    const upper = middle + mult * sd;
    const lower = middle - mult * sd;
    return {
      upper,
      middle,
      lower,
      widthPercent: middle > 0 ? ((upper - lower) / middle) * 100 : 0,
    };
  }

  // ─── ATR ──────────────────────────────────────────────────────────────────

  /** True Range per candle (indeks 0 berpadanan dengan candles[1]). */
  private trueRanges(candles: Candle[]): number[] {
    const tr: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      tr.push(
        Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        ),
      );
    }
    return tr;
  }

  /**
   * Deret ATR dengan smoothing Wilder (bukan SMA sederhana).
   *
   * Elemen terakhir adalah ATR terkini. Deret dibutuhkan Market Intelligence
   * untuk melihat volatilitas MELEBAR atau MENYEMPIT — satu nilai skalar tidak
   * bisa membedakan keduanya.
   */
  calculateATRSeries(candles: Candle[], period = 14): number[] {
    if (candles.length < period + 1) return [];
    const tr = this.trueRanges(candles);

    const out: number[] = [];
    let atr = mean(tr.slice(0, period));
    out.push(atr);
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
      out.push(atr);
    }
    return out;
  }

  /** ATR terkini (nilai terakhir dari `calculateATRSeries`). */
  calculateATR(candles: Candle[], period = 14): number {
    const series = this.calculateATRSeries(candles, period);
    return series.length ? series[series.length - 1] : 0;
  }

  // ─── ADX (kekuatan tren) ──────────────────────────────────────────────────

  /**
   * ADX Wilder. Di bawah ~20 pasar dianggap tanpa tren — kondisi di mana
   * strategi EMA crossover menghasilkan sinyal palsu beruntun.
   */
  calculateADX(candles: Candle[], period = 14): number {
    return this.calculateDMI(candles, period).adx;
  }

  /**
   * ADX beserta +DI dan −DI.
   *
   * ADX hanya menyatakan SEBERAPA KUAT tren, bukan arahnya; arah datang dari
   * selisih +DI/−DI. Market Intelligence membutuhkan keduanya untuk memisahkan
   * BULL_TREND dari BEAR_TREND — dengan ADX saja keduanya terlihat identik.
   */
  calculateDMI(
    candles: Candle[],
    period = 14,
  ): { adx: number; plusDi: number; minusDi: number } {
    if (candles.length < period * 2 + 1) return { adx: 0, plusDi: 0, minusDi: 0 };

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr = this.trueRanges(candles);

    for (let i = 1; i < candles.length; i++) {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const wilder = (values: number[]): number[] => {
      const out: number[] = [];
      let acc = values.slice(0, period).reduce((a, b) => a + b, 0);
      out.push(acc);
      for (let i = period; i < values.length; i++) {
        acc = acc - acc / period + values[i];
        out.push(acc);
      }
      return out;
    };

    const trS = wilder(tr);
    const plusS = wilder(plusDM);
    const minusS = wilder(minusDM);

    const dx: number[] = [];
    let lastPlusDi = 0;
    let lastMinusDi = 0;
    for (let i = 0; i < trS.length; i++) {
      if (trS[i] === 0) {
        dx.push(0);
        continue;
      }
      const plusDI = (plusS[i] / trS[i]) * 100;
      const minusDI = (minusS[i] / trS[i]) * 100;
      lastPlusDi = plusDI;
      lastMinusDi = minusDI;
      const sum = plusDI + minusDI;
      dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
    }

    if (dx.length < period) return { adx: mean(dx), plusDi: lastPlusDi, minusDi: lastMinusDi };

    let adx = mean(dx.slice(0, period));
    for (let i = period; i < dx.length; i++) {
      adx = (adx * (period - 1) + dx[i]) / period;
    }
    return { adx, plusDi: lastPlusDi, minusDi: lastMinusDi };
  }

  // ─── Choppiness Index ─────────────────────────────────────────────────────

  /**
   * Choppiness Index 0-100. Di atas ~61,8 pasar dianggap sideways;
   * di bawah ~38,2 sedang tren kuat.
   */
  calculateChoppiness(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 50;

    const window = candles.slice(-(period + 1));
    const tr = this.trueRanges(window);
    const atrSum = tr.reduce((a, b) => a + b, 0);

    const highs = window.slice(1).map((c) => c.high);
    const lows = window.slice(1).map((c) => c.low);
    const range = Math.max(...highs) - Math.min(...lows);

    if (range <= 0 || atrSum <= 0) return 50;
    return (100 * Math.log10(atrSum / range)) / Math.log10(period);
  }

  // ─── Struktur harga ───────────────────────────────────────────────────────

  /** Swing low terakhir (pivot dengan `lookback` candle lebih tinggi di kiri-kanan). */
  findSwingLow(candles: Candle[], lookback = 2, searchDepth = 30): number {
    const start = Math.max(lookback, candles.length - searchDepth);
    for (let i = candles.length - 1 - lookback; i >= start; i--) {
      let isPivot = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) {
          isPivot = false;
          break;
        }
      }
      if (isPivot) return candles[i].low;
    }
    return Math.min(...candles.slice(-searchDepth).map((c) => c.low));
  }

  findSwingHigh(candles: Candle[], lookback = 2, searchDepth = 30): number {
    const start = Math.max(lookback, candles.length - searchDepth);
    for (let i = candles.length - 1 - lookback; i >= start; i--) {
      let isPivot = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) {
          isPivot = false;
          break;
        }
      }
      if (isPivot) return candles[i].high;
    }
    return Math.max(...candles.slice(-searchDepth).map((c) => c.high));
  }

  // ─── Tren & crossover ─────────────────────────────────────────────────────

  detectTrend(ema5: number[], ema13: number[], ema21: number[]): Trend {
    const a = this.tail(ema5);
    const b = this.tail(ema13);
    const c = this.tail(ema21);
    if (a > b && b > c) return 'BULLISH';
    if (a < b && b < c) return 'BEARISH';
    return 'NEUTRAL';
  }

  detectCrossover(fast: number[], slow: number[]): Crossover {
    if (fast.length < 2 || slow.length < 2) return 'NONE';
    // Samakan indeks — seri cepat lebih panjang karena periodenya lebih kecil.
    const offset = fast.length - slow.length;
    if (offset < 0) return 'NONE';

    const prevDiff = fast[fast.length - 2] - slow[slow.length - 2];
    const currDiff = fast[fast.length - 1] - slow[slow.length - 1];

    if (prevDiff <= 0 && currDiff > 0) return 'GOLDEN';
    if (prevDiff >= 0 && currDiff < 0) return 'DEATH';
    return 'NONE';
  }

  /** Berapa candle lalu crossover terjadi; -1 bila tidak ada dalam `maxBars`. */
  barsSinceCrossover(fast: number[], slow: number[], type: 'GOLDEN' | 'DEATH', maxBars = 10): number {
    const n = Math.min(fast.length, slow.length);
    for (let back = 1; back < Math.min(maxBars + 1, n); back++) {
      const prevDiff = fast[fast.length - back - 1] - slow[slow.length - back - 1];
      const currDiff = fast[fast.length - back] - slow[slow.length - back];
      const golden = prevDiff <= 0 && currDiff > 0;
      const death = prevDiff >= 0 && currDiff < 0;
      if ((type === 'GOLDEN' && golden) || (type === 'DEATH' && death)) return back - 1;
    }
    return -1;
  }

  detectRegime(adx: number, choppiness: number, atrPercent: number): Regime {
    if (atrPercent > 5) return 'VOLATILE';
    if (adx >= 22 && choppiness < 55) return 'TRENDING';
    return 'RANGING';
  }

  // ─── Order book ───────────────────────────────────────────────────────────

  /**
   * Metrik kedalaman order book. Imbalance bid/ask adalah sinyal jangka pendek
   * yang kuat sekaligus penyaring pair yang likuiditasnya terlalu tipis.
   */
  analyzeOrderBook(book: OrderBook, levels = 10): OrderBookMetrics {
    const bids = (book.buy || []).slice(0, levels);
    const asks = (book.sell || []).slice(0, levels);

    const bidDepthIdr = bids.reduce((s, [p, a]) => s + p * a, 0);
    const askDepthIdr = asks.reduce((s, [p, a]) => s + p * a, 0);
    const total = bidDepthIdr + askDepthIdr;

    const bestBid = bids[0]?.[0] ?? 0;
    const bestAsk = asks[0]?.[0] ?? 0;

    return {
      imbalance: total > 0 ? (bidDepthIdr - askDepthIdr) / total : 0,
      spreadPercent: bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0,
      bidDepthIdr,
      askDepthIdr,
    };
  }

  // ─── Analisis lengkap ─────────────────────────────────────────────────────

  analyze(candles: Candle[]): IndicatorSet | null {
    if (candles.length < 50) return null;

    const closes = candles.map((c) => c.close);
    const lastPrice = closes[closes.length - 1];

    const ema5 = this.calculateEMA(closes, 5);
    const ema13 = this.calculateEMA(closes, 13);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);
    const rsi = this.calculateRSI(closes, 14);
    const macd = this.calculateMACD(closes);
    const bollinger = this.calculateBollinger(closes, 20, 2);

    const atr = this.calculateATR(candles, 14);
    const atrPercent = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
    const adx = this.calculateADX(candles, 14);
    const choppiness = this.calculateChoppiness(candles, 14);

    const volumeAvg = mean(candles.slice(-20).map((c) => c.volume));
    const currentVolume = candles[candles.length - 1].volume;

    return {
      ema5,
      ema13,
      ema21,
      ema50,
      rsi,
      macd,
      bollinger,
      adx,
      choppiness,
      atr,
      atrPercent,
      volumeAvg,
      currentVolume,
      volumeRatio: volumeAvg > 0 ? currentVolume / volumeAvg : 0,
      swingLow: this.findSwingLow(candles),
      swingHigh: this.findSwingHigh(candles),
      trend: this.detectTrend(ema5, ema13, ema21),
      regime: this.detectRegime(adx, choppiness, atrPercent),
    };
  }
}
