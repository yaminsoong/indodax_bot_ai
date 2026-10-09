import { Injectable } from '@nestjs/common';
import { TechnicalService } from '../indicators/technical.service';
import { clamp } from '../common/num';
import { BotParams } from '../config/bot-config.service';
import { Candle } from '../indodax/indodax.types';
import {
  StrategyContext,
  StrategySignal,
  TradingStrategy,
  IndicatorSnapshot,
  StrategyIntelligenceProfile,
  emptySnapshot,
} from './strategy.interface';

/** Periode kanal masuk & keluar. Sengaja sedikit dan bulat — lihat catatan kelas. */
const ENTRY_LOOKBACK = 20;
const EXIT_LOOKBACK = 10;

/**
 * Donchian channel breakout — beli saat harga menembus tertinggi N bar.
 *
 * Dipilih justru karena SEDERHANA. Strategi EMA sebelumnya punya belasan
 * ambang yang bisa disetel, dan makin banyak yang bisa disetel makin mudah
 * sebuah sistem terlihat bagus pada data historis semata-mata karena kebetulan.
 * Di sini hanya ada dua angka: panjang kanal masuk dan kanal keluar. Sedikitnya
 * derajat kebebasan membuat hasil backtest jauh lebih layak dipercaya.
 *
 * Karakternya juga cocok dengan masalah biaya yang terukur di bot ini:
 * breakout menghasilkan trade jarang dengan target lebar, sehingga fee yang
 * tetap ~0,2-0,4% per putaran menggerus porsi profit yang jauh lebih kecil
 * dibanding scalping.
 *
 * Yang harus dipahami sebelum memakainya: win rate breakout memang RENDAH
 * (sering 30-40%). Sistem ini hidup dari sedikit trade besar yang menutup
 * banyak kerugian kecil. Menilainya dari win rate akan menyesatkan — yang
 * relevan adalah ekspektasi R.
 */
@Injectable()
export class DonchianBreakoutStrategy implements TradingStrategy {
  readonly name = 'DONCHIAN_BREAKOUT';
  readonly description =
    'Tembus tertinggi 20 bar dengan stop ATR dan keluar di terendah 10 bar; sedikit parameter, trade jarang, fee drag rendah';
  readonly minCandles = 60;

  /**
   * Strategi breakout: yang menentukan bukan arah tren jangka panjang melainkan
   * apakah penembusan benar-benar terjadi dan didukung volume. Breakout tanpa
   * volume adalah pola paling sering gagal di pasar kripto - itu sebabnya
   * STRUCTURE_BREAK dan VOLUME_CONFIRMATION keduanya wajib.
   */
  readonly intelligenceProfile: StrategyIntelligenceProfile = {
    favourableRegimes: ['BREAKOUT', 'BULL_TREND', 'ACCUMULATION'],
    hostileRegimes: ['BREAKDOWN', 'BEAR_TREND', 'DISTRIBUTION', 'HIGH_VOLATILITY'],
    requires: ['STRUCTURE_BREAK', 'VOLUME_CONFIRMATION', 'VOLATILITY_ROOM'],
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
    const snapshot = this.snapshot(price, ind, ctx.orderBook?.imbalance ?? 0);

    // Kanal dihitung dari bar SEBELUM bar terakhir, agar bar yang sedang
    // dievaluasi tidak ikut membentuk levelnya sendiri (itu akan membuat
    // "tembus tertinggi" selalu benar secara sepele).
    const prior = candles.slice(0, -1);
    const entryChannel = highestHigh(prior, ENTRY_LOOKBACK);
    const exitChannel = lowestLow(prior, EXIT_LOOKBACK);

    // ── Keluar: harga jatuh menembus kanal bawah ─────────────────────────
    if (ctx.hasOpenPosition) {
      if (price <= exitChannel) {
        return {
          action: 'SELL',
          strength: 80,
          reasons: [
            `Harga menembus terendah ${EXIT_LOOKBACK} bar (${exitChannel.toFixed(0)})`,
            'Struktur breakout gagal — keluar',
          ],
          blockedBy: [],
          indicators: ind,
          snapshot,
        };
      }
      return this.hold(
        [`Breakout masih berjalan; keluar bila tembus ${exitChannel.toFixed(0)}`],
        ['Sudah ada posisi terbuka'],
        snapshot,
      );
    }

    // ── Filter masuk ──────────────────────────────────────────────────────
    const blockedBy: string[] = [];

    // Breakout di pasar tanpa arah hampir selalu palsu.
    if (ind.regime === 'VOLATILE') {
      blockedBy.push(`Volatilitas ekstrem (ATR ${ind.atrPercent.toFixed(1)}%)`);
    }
    if (ind.adx < params.minAdx) {
      blockedBy.push(`ADX ${ind.adx.toFixed(1)} < ${params.minAdx} (tidak ada tren)`);
    }

    if (params.requireHtfTrend) {
      const htf = this.htfTrend(ctx);
      if (htf === 'BEARISH') blockedBy.push(`Tren HTF ${params.htfTimeframe}m bearish`);
      snapshot.htfTrend = htf;
    }

    if (ctx.orderBook && ctx.orderBook.spreadPercent > params.maxSpreadPercent) {
      blockedBy.push(`Spread ${ctx.orderBook.spreadPercent.toFixed(2)}% terlalu lebar`);
    }
    if (ctx.volumeIdr24h !== undefined && ctx.volumeIdr24h < params.minVolumeIdr24h) {
      blockedBy.push(
        `Volume 24h ${(ctx.volumeIdr24h / 1e6).toFixed(0)} juta di bawah minimum`,
      );
    }

    // ── Penilaian sinyal ──────────────────────────────────────────────────
    const reasons: string[] = [];
    let strength = 0;

    const brokeOut = price > entryChannel;
    if (brokeOut) {
      const excessPercent = ((price - entryChannel) / entryChannel) * 100;
      reasons.push(
        `Tembus tertinggi ${ENTRY_LOOKBACK} bar (${entryChannel.toFixed(0)}) sebesar ${excessPercent.toFixed(2)}%`,
      );
      strength += 55;
    } else {
      blockedBy.push(
        `Belum menembus kanal atas (${entryChannel.toFixed(0)}); harga ${price.toFixed(0)}`,
      );
    }

    // Volume mengonfirmasi bahwa breakout didukung partisipasi nyata.
    if (ind.volumeRatio >= 1.2) {
      reasons.push(`Volume ${(ind.volumeRatio * 100).toFixed(0)}% dari rata-rata`);
      strength += 20;
    } else if (ind.volumeRatio < 0.7) {
      reasons.push('Volume sepi — breakout rawan palsu');
      strength -= 15;
    }

    if (ind.adx >= 25) {
      reasons.push(`Tren kuat (ADX ${ind.adx.toFixed(0)})`);
      strength += 15;
    }

    if (price > last(ind.ema50)) {
      reasons.push('Harga di atas EMA50');
      strength += 10;
    }

    strength = clamp(strength, 0, 100);
    if (strength < params.minSignalStrength) {
      blockedBy.push(`Kekuatan sinyal ${strength} < minimum ${params.minSignalStrength}`);
    }

    const exits = this.calculateExits(price, ind, params);

    if (blockedBy.length === 0) {
      return {
        action: 'BUY',
        strength,
        reasons,
        blockedBy,
        suggestedStopLoss: exits.stopLoss,
        suggestedTakeProfit: exits.takeProfit,
        indicators: ind,
        snapshot,
      };
    }

    return {
      action: 'HOLD',
      strength,
      reasons: reasons.length ? reasons : ['Menunggu breakout'],
      blockedBy,
      suggestedStopLoss: exits.stopLoss,
      suggestedTakeProfit: exits.takeProfit,
      indicators: ind,
      snapshot,
    };
  }

  /**
   * Stop di bawah kanal keluar atau sejarak ATR, mana yang lebih ketat,
   * lalu dibatasi rentang min/max. Target dibuat lebar: sistem breakout
   * bergantung pada sedikit trade besar, sehingga memotong profit terlalu
   * cepat justru menghapus sumber keuntungannya.
   */
  private calculateExits(
    price: number,
    ind: NonNullable<ReturnType<TechnicalService['analyze']>>,
    params: BotParams,
  ): { stopLoss: number; takeProfit: number } {
    const atrStop = price - ind.atr * params.atrStopMultiplier;
    const structuralStop = ind.swingLow * 0.999;

    let stopLoss = Math.max(atrStop, structuralStop);
    stopLoss = clamp(
      stopLoss,
      price * (1 - params.maxStopPercent / 100),
      price * (1 - params.minStopPercent / 100),
    );

    const risk = price - stopLoss;
    const takeProfit = price + risk * (params.atrTargetMultiplier / params.atrStopMultiplier);

    return { stopLoss, takeProfit };
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

function highestHigh(candles: Candle[], lookback: number): number {
  const window = candles.slice(-lookback);
  return window.length ? Math.max(...window.map((c) => c.high)) : Infinity;
}

function lowestLow(candles: Candle[], lookback: number): number {
  const window = candles.slice(-lookback);
  return window.length ? Math.min(...window.map((c) => c.low)) : 0;
}

function last(arr: number[]): number {
  return arr.length ? arr[arr.length - 1] : 0;
}
