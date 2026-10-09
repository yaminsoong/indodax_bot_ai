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
 * Mean reversion Bollinger + RSI.
 *
 * Pelengkap EMA scalping: strategi tren merugi di pasar sideways, sedangkan
 * strategi ini justru dirancang untuk kondisi itu. Filter regime-nya dibalik —
 * hanya aktif saat ADX rendah / choppiness tinggi.
 */
@Injectable()
export class MeanReversionStrategy implements TradingStrategy {
  readonly name = 'MEAN_REVERSION_BB';
  readonly description = 'Beli saat harga menyentuh Bollinger bawah dengan RSI oversold, khusus pasar sideways';
  readonly minCandles = 60;

  /**
   * Kebalikan dari strategi tren: justru MEMBUTUHKAN pasar tanpa arah, dan
   * hanya masuk saat harga berada di lokasi ekstrem rentang. Tren kuat adalah
   * kondisi terburuk untuk mean reversion - harga tidak kembali ke mean, ia
   * terus berjalan.
   */
  readonly intelligenceProfile: StrategyIntelligenceProfile = {
    favourableRegimes: ['SIDEWAYS', 'ACCUMULATION', 'LOW_VOLATILITY'],
    hostileRegimes: ['BEAR_TREND', 'BREAKDOWN', 'HIGH_VOLATILITY'],
    requires: ['RANGE_CONDITION', 'EXTREME_LOCATION', 'VOLATILITY_ROOM'],
  };

  constructor(private readonly technical: TechnicalService) {}

  evaluate(ctx: StrategyContext): StrategySignal {
    const { candles, params } = ctx;

    if (candles.length < this.minCandles) {
      return this.hold(['Data candle belum cukup'], [], emptySnapshot());
    }

    const ind = this.technical.analyze(candles);
    if (!ind) return this.hold(['Indikator gagal dihitung'], [], emptySnapshot());

    const price = candles[candles.length - 1].close;
    const lastRsi = last(ind.rsi);
    const snapshot = this.snapshot(price, ind, ctx.orderBook?.imbalance ?? 0);

    // Keluar saat harga kembali ke tengah band — target alami mean reversion.
    if (ctx.hasOpenPosition) {
      if (price >= ind.bollinger.middle && lastRsi >= 55) {
        return {
          action: 'SELL',
          strength: 70,
          reasons: ['Harga kembali ke Bollinger tengah', `RSI pulih ke ${lastRsi.toFixed(1)}`],
          blockedBy: [],
          indicators: ind,
          snapshot,
        };
      }
      return this.hold(['Menunggu harga kembali ke mean'], ['Sudah ada posisi terbuka'], snapshot);
    }

    const blockedBy: string[] = [];

    // Kebalikan dari strategi tren: butuh pasar TANPA arah.
    if (ind.adx > 25) blockedBy.push(`ADX ${ind.adx.toFixed(1)} terlalu tinggi (pasar sedang tren)`);
    if (ind.regime === 'VOLATILE') blockedBy.push('Volatilitas ekstrem');
    if (ind.bollinger.widthPercent < 1.5) blockedBy.push('Band terlalu sempit - tidak ada ruang profit');

    // Jangan menangkap pisau jatuh: tolak bila tren HTF menurun tajam.
    if (params.requireHtfTrend && this.htfTrend(ctx) === 'BEARISH') {
      blockedBy.push('Tren HTF bearish - risiko downtrend berlanjut');
    }

    if (ctx.orderBook && ctx.orderBook.spreadPercent > params.maxSpreadPercent) {
      blockedBy.push(`Spread ${ctx.orderBook.spreadPercent.toFixed(2)}% terlalu lebar`);
    }

    const reasons: string[] = [];
    let strength = 0;

    if (price <= ind.bollinger.lower) {
      reasons.push('Harga menyentuh Bollinger bawah');
      strength += 40;
    } else if (price <= ind.bollinger.lower * 1.005) {
      reasons.push('Harga mendekati Bollinger bawah');
      strength += 20;
    }

    if (lastRsi <= 30) {
      reasons.push(`RSI oversold: ${lastRsi.toFixed(1)}`);
      strength += 30;
    } else if (lastRsi <= 40) {
      reasons.push(`RSI rendah: ${lastRsi.toFixed(1)}`);
      strength += 15;
    }

    if (ind.volumeRatio >= 1.5) {
      reasons.push('Lonjakan volume - kemungkinan kapitulasi');
      strength += 15;
    }

    if (ind.choppiness > 55) {
      reasons.push(`Pasar sideways (choppiness ${ind.choppiness.toFixed(0)}) - kondisi ideal`);
      strength += 15;
    }

    strength = clamp(strength, 0, 100);
    if (strength < params.minSignalStrength) {
      blockedBy.push(`Kekuatan sinyal ${strength} < minimum ${params.minSignalStrength}`);
    }

    const stopLoss = Math.min(ind.swingLow * 0.999, price - ind.atr * params.atrStopMultiplier);
    const takeProfit = ind.bollinger.middle;

    if (blockedBy.length === 0) {
      return {
        action: 'BUY',
        strength,
        reasons,
        blockedBy,
        suggestedStopLoss: stopLoss,
        suggestedTakeProfit: takeProfit,
        indicators: ind,
        snapshot,
      };
    }

    return {
      action: 'HOLD',
      strength,
      reasons: reasons.length ? reasons : ['Belum ada kondisi oversold'],
      blockedBy,
      suggestedStopLoss: stopLoss,
      suggestedTakeProfit: takeProfit,
      indicators: ind,
      snapshot,
    };
  }

  private htfTrend(ctx: StrategyContext): string {
    if (!ctx.htfCandles || ctx.htfCandles.length < 55) return 'UNKNOWN';
    const closes = ctx.htfCandles.map((c) => c.close);
    const ema21 = this.technical.calculateEMA(closes, 21);
    const ema50 = this.technical.calculateEMA(closes, 50);
    if (!ema21.length || !ema50.length) return 'UNKNOWN';
    const price = closes[closes.length - 1];
    if (last(ema21) > last(ema50) && price > last(ema50)) return 'BULLISH';
    if (last(ema21) < last(ema50) && price < last(ema50)) return 'BEARISH';
    return 'NEUTRAL';
  }

  private snapshot(price: number, ind: any, obImbalance: number): IndicatorSnapshot {
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
      htfTrend: 'UNKNOWN',
      orderBookImbalance: obImbalance,
    };
  }

  private hold(reasons: string[], blockedBy: string[], snapshot: IndicatorSnapshot): StrategySignal {
    return { action: 'HOLD', strength: 0, reasons, blockedBy, indicators: null, snapshot };
  }
}

function last(arr: number[]): number {
  return arr.length ? arr[arr.length - 1] : 0;
}
