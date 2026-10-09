import { Injectable } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { clamp } from '../../common/num';
import { Direction, Timeframe, TIMEFRAMES, TIMEFRAME_ROLE } from '../market-intelligence.types';
import { IndicatorEngineService } from '../indicators/indicator-engine.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { SupportResistanceService } from '../levels/support-resistance.service';
import { RegimeEngineService } from '../regime/regime-engine.service';
import { CandleSet, MtfContext, TimeframeAlignment, TimeframeAnalysis } from './mtf.types';

/**
 * Bobot hierarki timeframe (bagian 2 spesifikasi).
 *
 * Timeframe besar menentukan arah, timeframe kecil menentukan waktu masuk.
 * Karena itu 1D dan 4H membawa lebih dari separuh bobot: melawan tren 4H
 * karena satu sinyal 5m adalah cara paling umum kehilangan modal.
 */
export const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
  '1D': 0.3,
  '4H': 0.28,
  '1H': 0.2,
  '15m': 0.14,
  '5m': 0.08,
};

/** Minimum candle agar sebuah timeframe layak dianalisis. */
const MIN_BARS = 30;

@Injectable()
export class MultiTimeframeService {
  constructor(
    private readonly indicators: IndicatorEngineService,
    private readonly structure: StructureEngineService,
    private readonly levels: SupportResistanceService,
    private readonly regime: RegimeEngineService,
  ) {}

  /**
   * Bangun konteks multi-timeframe dari candle yang sudah disediakan pemanggil.
   *
   * Tidak ada panggilan API di sini: fungsi ini murni, sehingga backtest dapat
   * memanggilnya dengan potongan candle historis dan mendapat hasil yang sama
   * persis dengan mode live.
   */
  build(pair: string, candleSet: CandleSet): MtfContext {
    const timeframes: Partial<Record<Timeframe, TimeframeAnalysis>> = {};
    const missing: Timeframe[] = [];

    for (const tf of TIMEFRAMES) {
      const candles = candleSet[tf];
      if (!candles || candles.length < MIN_BARS) {
        missing.push(tf);
        continue;
      }
      const analysis = this.analyzeTimeframe(tf, candles);
      if (analysis) timeframes[tf] = analysis;
      else missing.push(tf);
    }

    const present = Object.values(timeframes) as TimeframeAnalysis[];
    const asOf = present.length ? Math.max(...present.map((t) => t.barTime)) : 0;

    return {
      pair,
      asOf,
      timeframes,
      missing,
      alignment: this.alignment(timeframes),
      primaryTimeframe: this.pick(timeframes, ['1H', '4H', '15m', '1D', '5m']),
      executionTimeframe: this.pick(timeframes, ['5m', '15m', '1H', '4H', '1D']),
    };
  }

  /** Analisis penuh satu timeframe. */
  analyzeTimeframe(tf: Timeframe, candles: Candle[]): TimeframeAnalysis | null {
    const indicators = this.indicators.analyze(tf, candles);
    if (!indicators) return null;

    const structure = this.structure.analyze(tf, candles);
    const levels = this.levels.analyze(tf, candles, structure);
    const regime = this.regime.analyze(tf, indicators, structure, candles);
    const bias = this.biasOf(indicators, structure?.trend ?? 'NEUTRAL', regime.regime);

    return {
      timeframe: tf,
      role: TIMEFRAME_ROLE[tf],
      bars: candles.length,
      barTime: indicators.barTime,
      indicators,
      structure,
      levels,
      regime,
      bias: bias.direction,
      biasConfidence: bias.confidence,
      biasReasons: bias.reasons,
    };
  }

  // --- Bias per timeframe --------------------------------------------------

  /**
   * Arah satu timeframe, dari tiga sumber yang harus saling mendukung:
   * susunan EMA, struktur harga, dan regime.
   *
   * Dipakai suara terbanyak, bukan satu indikator. Bila ketiganya berbeda,
   * hasilnya NEUTRAL - dan NEUTRAL memang jawaban yang benar untuk pasar yang
   * tidak sedang menyatakan apa pun.
   */
  private biasOf(
    indicators: ReturnType<IndicatorEngineService['analyze']>,
    structureTrend: Direction,
    regime: string,
  ): { direction: Direction; confidence: number; reasons: string[] } {
    if (!indicators) return { direction: 'NEUTRAL', confidence: 0, reasons: [] };

    const reasons: string[] = [];
    let bullVotes = 0;
    let bearVotes = 0;

    if (indicators.trend.emaStack === 'BULLISH') {
      bullVotes++;
      reasons.push('EMA 9/21/50 tersusun naik');
    } else if (indicators.trend.emaStack === 'BEARISH') {
      bearVotes++;
      reasons.push('EMA 9/21/50 tersusun turun');
    }

    if (structureTrend === 'BULLISH') {
      bullVotes++;
      reasons.push('Struktur HH/HL');
    } else if (structureTrend === 'BEARISH') {
      bearVotes++;
      reasons.push('Struktur LH/LL');
    }

    if (regime === 'BULL_TREND' || regime === 'BREAKOUT' || regime === 'ACCUMULATION') {
      bullVotes++;
      reasons.push(`Regime ${regime}`);
    } else if (regime === 'BEAR_TREND' || regime === 'BREAKDOWN' || regime === 'DISTRIBUTION') {
      bearVotes++;
      reasons.push(`Regime ${regime}`);
    }

    // Harga terhadap EMA200 hanya sebagai pemecah seri, bukan suara penuh:
    // satu rata-rata panjang tidak setara dengan struktur harga.
    const vsEma200 = indicators.trend.priceVsEma200Percent;
    if (bullVotes === bearVotes && vsEma200 !== null) {
      if (vsEma200 > 0) {
        bullVotes += 0.5;
        reasons.push('Harga di atas EMA200');
      } else if (vsEma200 < 0) {
        bearVotes += 0.5;
        reasons.push('Harga di bawah EMA200');
      }
    }

    const total = bullVotes + bearVotes;
    if (total === 0 || bullVotes === bearVotes) {
      return { direction: 'NEUTRAL', confidence: 0.2, reasons };
    }

    const direction: Direction = bullVotes > bearVotes ? 'BULLISH' : 'BEARISH';
    const confidence = clamp(Math.abs(bullVotes - bearVotes) / 3, 0.2, 1);
    return { direction, confidence: Number(confidence.toFixed(3)), reasons };
  }

  // --- Keselarasan antar timeframe ----------------------------------------

  /**
   * Skor keselarasan tertimbang.
   *
   * Nilai +1 berarti seluruh timeframe yang tersedia bullish; -1 seluruhnya
   * bearish; 0 berarti saling meniadakan. Bobot dinormalisasi terhadap
   * timeframe yang benar-benar ada, sehingga hilangnya data 1D tidak diam-diam
   * membuat skor terlihat lemah.
   */
  alignment(timeframes: Partial<Record<Timeframe, TimeframeAnalysis>>): TimeframeAlignment {
    const present = Object.values(timeframes) as TimeframeAnalysis[];
    if (!present.length) {
      return { score: 0, direction: 'NEUTRAL', aligned: [], conflicting: [], conflicts: [] };
    }

    const totalWeight = present.reduce((s, t) => s + TIMEFRAME_WEIGHT[t.timeframe], 0);
    let weighted = 0;
    for (const t of present) {
      const sign = t.bias === 'BULLISH' ? 1 : t.bias === 'BEARISH' ? -1 : 0;
      weighted += sign * TIMEFRAME_WEIGHT[t.timeframe] * t.biasConfidence;
    }
    const score = totalWeight > 0 ? clamp(weighted / totalWeight, -1, 1) : 0;

    const direction: Direction = score > 0.15 ? 'BULLISH' : score < -0.15 ? 'BEARISH' : 'NEUTRAL';

    const aligned = present.filter((t) => t.bias === direction).map((t) => t.timeframe);
    const conflicting = present
      .filter((t) => t.bias !== 'NEUTRAL' && t.bias !== direction)
      .map((t) => t.timeframe);

    // Konflik antar timeframe yang berdekatan dalam hierarki adalah yang paling
    // merusak: ia berarti tren induk dan tren anak sedang bertolak belakang.
    const conflicts: string[] = [];
    const order: Timeframe[] = ['1D', '4H', '1H', '15m', '5m'];
    for (let i = 0; i < order.length - 1; i++) {
      const a = timeframes[order[i]];
      const b = timeframes[order[i + 1]];
      if (!a || !b) continue;
      if (a.bias !== 'NEUTRAL' && b.bias !== 'NEUTRAL' && a.bias !== b.bias) {
        conflicts.push(`${order[i]} ${a.bias} bertentangan dengan ${order[i + 1]} ${b.bias}`);
      }
    }

    return { score: Number(score.toFixed(3)), direction, aligned, conflicting, conflicts };
  }

  /** Timeframe pertama dari daftar preferensi yang datanya tersedia. */
  private pick(
    timeframes: Partial<Record<Timeframe, TimeframeAnalysis>>,
    preference: Timeframe[],
  ): Timeframe {
    return preference.find((tf) => timeframes[tf]) ?? preference[preference.length - 1];
  }
}
