import { Injectable } from '@nestjs/common';
import { TechnicalService } from '../indicators/technical.service';
import { clamp } from '../common/num';
import { BotParams } from '../config/bot-config.service';
import {
  StrategyContext,
  StrategySignal,
  TradingStrategy,
  IndicatorSnapshot,
  StrategyIntelligenceProfile,
  emptySnapshot,
} from './strategy.interface';

/**
 * Scalping EMA 5/13/21 dengan penyaringan berlapis.
 *
 * Perbedaan dengan versi awal bot:
 *  - Entry wajib searah tren timeframe lebih tinggi (filter HTF).
 *  - Kondisi sideways ditolak lewat ADX + Choppiness Index. Crossover EMA
 *    menghasilkan sinyal palsu beruntun di pasar tanpa arah, dan inilah
 *    penyebab utama rentetan kerugian pada sistem EMA.
 *  - Stop loss & target berbasis ATR dan struktur harga (swing low), bukan
 *    persentase tetap yang sama untuk semua koin.
 *  - Sinyal SELL benar-benar dipakai untuk keluar posisi, bukan sekadar dicatat.
 */
@Injectable()
export class EmaScalpingStrategy implements TradingStrategy {
  readonly name = 'EMA_SCALPING_V2';
  readonly description = 'EMA 5/13/21 + RSI + volume, disaring tren HTF, ADX/Choppiness, dan order book';
  readonly minCandles = 60;

  /**
   * Strategi mengikuti tren: butuh tren yang nyata, momentum, dan volume.
   * Pasar sideways adalah pembunuh utama sistem EMA crossover - karena itu
   * SIDEWAYS dan DISTRIBUTION masuk daftar regime yang ditolak.
   */
  readonly intelligenceProfile: StrategyIntelligenceProfile = {
    favourableRegimes: ['BULL_TREND', 'BREAKOUT'],
    hostileRegimes: ['SIDEWAYS', 'BEAR_TREND', 'BREAKDOWN', 'DISTRIBUTION', 'HIGH_VOLATILITY'],
    requires: ['TREND_ALIGNMENT', 'VOLUME_CONFIRMATION', 'VOLATILITY_ROOM'],
  };

  constructor(private readonly technical: TechnicalService) {}

  evaluate(ctx: StrategyContext): StrategySignal {
    const { candles, params } = ctx;

    if (candles.length < this.minCandles) {
      return this.hold(['Data candle belum cukup'], [], null, emptySnapshot());
    }

    const ind = this.technical.analyze(candles);
    if (!ind) {
      return this.hold(['Indikator gagal dihitung'], [], null, emptySnapshot());
    }

    const price = candles[candles.length - 1].close;
    const htfTrend = this.higherTimeframeTrend(ctx);
    const snapshot = this.buildSnapshot(price, ind, htfTrend, ctx.orderBook?.imbalance ?? 0);

    // ── Sinyal keluar untuk posisi yang sedang terbuka ────────────────────
    if (ctx.hasOpenPosition) {
      const exit = this.evaluateExit(ctx, ind, snapshot);
      if (exit) return exit;
    }

    // ── Filter masuk ──────────────────────────────────────────────────────
    const blockedBy = this.entryFilters(ctx, ind, htfTrend);

    const lastEma5 = last(ind.ema5);
    const lastEma13 = last(ind.ema13);
    const lastEma21 = last(ind.ema21);
    const lastRsi = last(ind.rsi);
    const macdHist = last(ind.macd.histogram);

    const crossover = this.technical.detectCrossover(ind.ema5, ind.ema13);
    const barsSinceGolden = this.technical.barsSinceCrossover(ind.ema5, ind.ema13, 'GOLDEN', 5);

    const reasons: string[] = [];
    let strength = 0;

    // Crossover baru bernilai lebih tinggi daripada crossover yang sudah basi.
    if (crossover === 'GOLDEN') {
      reasons.push('EMA5 golden cross EMA13 (candle ini)');
      strength += 35;
    } else if (barsSinceGolden >= 0 && barsSinceGolden <= 3) {
      reasons.push(`Golden cross ${barsSinceGolden} candle lalu (masih valid)`);
      strength += 20;
    }

    if (ind.trend === 'BULLISH') {
      reasons.push('EMA tersusun bullish (5>13>21)');
      strength += 20;
    }

    if (htfTrend === 'BULLISH') {
      reasons.push(`Tren HTF ${params.htfTimeframe}m juga bullish`);
      strength += 15;
    }

    if (lastRsi >= 45 && lastRsi <= 68) {
      reasons.push(`RSI di zona sehat: ${lastRsi.toFixed(1)}`);
      strength += 15;
    } else if (lastRsi > 68) {
      reasons.push(`RSI sudah tinggi (${lastRsi.toFixed(1)}) - risiko entry telat`);
      strength -= 10;
    }

    if (ind.volumeRatio >= 1.3) {
      reasons.push(`Volume ${(ind.volumeRatio * 100).toFixed(0)}% dari rata-rata`);
      strength += 10;
    } else if (ind.volumeRatio < 0.6) {
      reasons.push('Volume sepi - konfirmasi lemah');
      strength -= 10;
    }

    if (macdHist > 0) {
      reasons.push('Histogram MACD positif');
      strength += 10;
    }

    if (price > lastEma21) {
      reasons.push('Harga di atas EMA21');
      strength += 5;
    }

    if (ind.regime === 'TRENDING') {
      reasons.push(`Pasar sedang tren (ADX ${ind.adx.toFixed(0)})`);
      strength += 10;
    }

    if (ctx.orderBook && ctx.orderBook.imbalance > 0.15) {
      reasons.push(`Order book condong beli (${(ctx.orderBook.imbalance * 100).toFixed(0)}%)`);
      strength += 5;
    }

    strength = clamp(strength, 0, 100);

    const exits = this.calculateExits(price, ind, params);

    // Butuh alignment EMA bullish sebagai syarat minimum struktural.
    const structurallyValid = lastEma5 > lastEma13 && lastEma13 > lastEma21;

    if (!structurallyValid) blockedBy.push('EMA belum tersusun bullish');
    if (strength < params.minSignalStrength) {
      blockedBy.push(`Kekuatan sinyal ${strength} < minimum ${params.minSignalStrength}`);
    }

    if (blockedBy.length === 0) {
      return {
        action: 'BUY',
        strength,
        reasons,
        blockedBy,
        suggestedEntryLow: exits.entryLow,
        suggestedEntryHigh: exits.entryHigh,
        suggestedStopLoss: exits.stopLoss,
        suggestedTakeProfit: exits.takeProfit,
        indicators: ind,
        snapshot,
      };
    }

    return {
      action: 'HOLD',
      strength,
      reasons: reasons.length ? reasons : ['Belum ada konfirmasi'],
      blockedBy,
      suggestedEntryLow: exits.entryLow,
      suggestedEntryHigh: exits.entryHigh,
      suggestedStopLoss: exits.stopLoss,
      suggestedTakeProfit: exits.takeProfit,
      indicators: ind,
      snapshot,
    };
  }

  // ─── Filter masuk ────────────────────────────────────────────────────────

  private entryFilters(
    ctx: StrategyContext,
    ind: ReturnType<TechnicalService['analyze']>,
    htfTrend: string,
  ): string[] {
    const { params } = ctx;
    const blocked: string[] = [];

    if (ctx.hasOpenPosition) blocked.push('Sudah ada posisi terbuka di pair ini');

    if (params.requireHtfTrend && htfTrend === 'BEARISH') {
      blocked.push(`Tren HTF ${params.htfTimeframe}m bearish`);
    }

    // Pasar sideways adalah pembunuh utama strategi EMA crossover.
    if (ind.adx < params.minAdx) {
      blocked.push(`ADX ${ind.adx.toFixed(1)} < ${params.minAdx} (pasar tanpa tren)`);
    }
    if (ind.choppiness > params.maxChoppiness) {
      blocked.push(`Choppiness ${ind.choppiness.toFixed(1)} > ${params.maxChoppiness} (sideways)`);
    }

    if (ind.regime === 'VOLATILE') {
      blocked.push(`Volatilitas ekstrem (ATR ${ind.atrPercent.toFixed(1)}% dari harga)`);
    }

    if (ctx.orderBook) {
      if (ctx.orderBook.spreadPercent > params.maxSpreadPercent) {
        blocked.push(
          `Spread ${ctx.orderBook.spreadPercent.toFixed(2)}% > ${params.maxSpreadPercent}% (likuiditas tipis)`,
        );
      }
      if (ctx.orderBook.imbalance < params.minOrderBookImbalance) {
        blocked.push(`Order book condong jual (${(ctx.orderBook.imbalance * 100).toFixed(0)}%)`);
      }
    }

    if (ctx.volumeIdr24h !== undefined && ctx.volumeIdr24h < params.minVolumeIdr24h) {
      blocked.push(
        `Volume 24h ${(ctx.volumeIdr24h / 1e6).toFixed(0)} juta < minimum ${(params.minVolumeIdr24h / 1e6).toFixed(0)} juta IDR`,
      );
    }

    return blocked;
  }

  // ─── Sinyal keluar ───────────────────────────────────────────────────────

  /**
   * Sinyal keluar berbasis strategi (di luar stop loss / take profit).
   * Versi lama menghitung sinyal SELL tetapi tidak pernah memakainya untuk
   * menutup posisi, sehingga death cross diabaikan sepenuhnya.
   */
  private evaluateExit(
    ctx: StrategyContext,
    ind: NonNullable<ReturnType<TechnicalService['analyze']>>,
    snapshot: IndicatorSnapshot,
  ): StrategySignal | null {
    const reasons: string[] = [];
    let strength = 0;

    const crossover = this.technical.detectCrossover(ind.ema5, ind.ema13);
    const lastRsi = last(ind.rsi);

    if (crossover === 'DEATH') {
      reasons.push('EMA5 death cross EMA13');
      strength += 50;
    }
    if (ind.trend === 'BEARISH') {
      // Susunan EMA yang sepenuhnya terbalik adalah pernyataan tren yang kuat.
      // Bobotnya dibuat cukup agar bersama konfirmasi momentum sudah memicu
      // keluar: menahan posisi sepanjang downtrend yang terkonfirmasi
      // bertentangan dengan premis strategi mengikuti tren, dan menyerahkan
      // seluruh beban keluar kepada stop loss.
      reasons.push('EMA berbalik bearish (5<13<21)');
      strength += 35;
    }
    if (lastRsi >= 78) {
      reasons.push(`RSI overbought ekstrem: ${lastRsi.toFixed(1)}`);
      strength += 25;
    }
    if (last(ind.macd.histogram) < 0 && ind.trend !== 'BULLISH') {
      reasons.push('Momentum MACD berbalik negatif');
      strength += 15;
    }
    if (ctx.orderBook && ctx.orderBook.imbalance < -0.35) {
      reasons.push(`Tekanan jual kuat di order book (${(ctx.orderBook.imbalance * 100).toFixed(0)}%)`);
      strength += 10;
    }

    if (strength >= 50) {
      return {
        action: 'SELL',
        strength: clamp(strength, 0, 100),
        reasons,
        blockedBy: [],
        indicators: ind,
        snapshot,
      };
    }
    return null;
  }

  // ─── Level exit ──────────────────────────────────────────────────────────

  /**
   * Stop loss diambil dari yang lebih ketat antara jarak ATR dan swing low,
   * lalu dibatasi rentang min/max agar tidak absurd pada koin sangat volatil.
   */
  private calculateExits(
    price: number,
    ind: NonNullable<ReturnType<TechnicalService['analyze']>>,
    params: BotParams,
  ): { stopLoss: number; takeProfit: number; entryLow: number; entryHigh: number } {
    const atrStop = price - ind.atr * params.atrStopMultiplier;
    // Sedikit di bawah swing low agar tidak tersapu noise tepat di titik pivot.
    const structuralStop = ind.swingLow * 0.999;

    let stopLoss = Math.max(atrStop, structuralStop);

    const minStop = price * (1 - params.maxStopPercent / 100);
    const maxStop = price * (1 - params.minStopPercent / 100);
    stopLoss = clamp(stopLoss, minStop, maxStop);

    const riskDistance = price - stopLoss;
    const takeProfit = price + riskDistance * (params.atrTargetMultiplier / params.atrStopMultiplier);

    // Zona entry dipatok pada volatilitas, bukan persentase tetap: pada koin
    // bergerak lambat zona sempit sudah cukup, pada yang liar zona sempit akan
    // menolak hampir semua entry yang sebenarnya masih sah.
    const band = ind.atr * params.entryZoneAtrMultiplier;

    return {
      stopLoss,
      takeProfit,
      entryLow: price - band,
      entryHigh: price + band,
    };
  }

  // ─── Utilitas ────────────────────────────────────────────────────────────

  /** Arah tren pada timeframe lebih tinggi, dari susunan EMA-nya. */
  private higherTimeframeTrend(ctx: StrategyContext): string {
    if (!ctx.htfCandles || ctx.htfCandles.length < 55) return 'UNKNOWN';
    const closes = ctx.htfCandles.map((c) => c.close);
    const ema21 = this.technical.calculateEMA(closes, 21);
    const ema50 = this.technical.calculateEMA(closes, 50);
    if (!ema21.length || !ema50.length) return 'UNKNOWN';

    const price = closes[closes.length - 1];
    const e21 = last(ema21);
    const e50 = last(ema50);

    if (e21 > e50 && price > e50) return 'BULLISH';
    if (e21 < e50 && price < e50) return 'BEARISH';
    return 'NEUTRAL';
  }

  private buildSnapshot(
    price: number,
    ind: NonNullable<ReturnType<TechnicalService['analyze']>>,
    htfTrend: string,
    obImbalance: number,
  ): IndicatorSnapshot {
    return {
      price,
      ema5: last(ind.ema5),
      ema13: last(ind.ema13),
      ema21: last(ind.ema21),
      ema50: last(ind.ema50),
      rsi: last(ind.rsi),
      macdHistogram: last(ind.macd.histogram),
      atr: ind.atr,
      atrPercent: ind.atrPercent,
      adx: ind.adx,
      choppiness: ind.choppiness,
      volume: ind.currentVolume,
      volumeAvg: ind.volumeAvg,
      volumeRatio: ind.volumeRatio,
      trend: ind.trend,
      regime: ind.regime,
      htfTrend,
      orderBookImbalance: obImbalance,
    };
  }

  private hold(
    reasons: string[],
    blockedBy: string[],
    indicators: any,
    snapshot: IndicatorSnapshot,
  ): StrategySignal {
    return { action: 'HOLD', strength: 0, reasons, blockedBy, indicators, snapshot };
  }
}

function last(arr: number[]): number {
  return arr.length ? arr[arr.length - 1] : 0;
}
