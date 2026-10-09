import { mean, stdev } from '../common/num';
import { BacktestTrade, PerformanceSlice } from './backtest.types';

/**
 * Ringkas sekumpulan trade menjadi satu irisan performa.
 *
 * Dipakai bersama oleh BacktestService (irisan dalam satu backtest) dan
 * OptimizerService (irisan gabungan lintas jendela walk-forward). Satu
 * implementasi saja: dua rumus ekspektasi yang berbeda akan menghasilkan dua
 * kesimpulan yang berbeda tentang data yang sama.
 *
 * `expectancyStdErrorR` sengaja selalu disertakan. Ekspektasi 0,8R dari enam
 * trade dan 0,8R dari tiga ratus trade adalah dua pernyataan yang sama sekali
 * berbeda, dan tanpa galat baku keduanya terlihat identik di layar.
 */
export function slicePerformance(label: string, trades: BacktestTrade[]): PerformanceSlice {
  if (!trades.length) {
    return {
      label,
      trades: 0,
      winRate: 0,
      expectancyR: 0,
      expectancyStdErrorR: 0,
      netProfit: 0,
      profitFactor: null,
      avgHoldingBars: 0,
    };
  }

  const rMultiples = trades.map((t) => t.rMultiple);
  const wins = trades.filter((t) => t.profitLoss > 0);
  const grossProfit = wins.reduce((s, t) => s + t.profitLoss, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.profitLoss <= 0).reduce((s, t) => s + t.profitLoss, 0),
  );

  return {
    label,
    trades: trades.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    expectancyR: Number(mean(rMultiples).toFixed(4)),
    expectancyStdErrorR:
      trades.length > 1 ? Number((stdev(rMultiples) / Math.sqrt(trades.length)).toFixed(4)) : 0,
    netProfit: Math.round(grossProfit - grossLoss),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null,
    avgHoldingBars: Number(mean(trades.map((t) => t.holdingBars)).toFixed(1)),
  };
}

/** Bucket skor standar yang dipakai di seluruh laporan. */
export const SCORE_BUCKETS: Array<[string, number, number]> = [
  ['0-49', 0, 49],
  ['50-64', 50, 64],
  ['65-69', 65, 69],
  ['70-79', 70, 79],
  ['80-89', 80, 89],
  ['90-100', 90, 100],
];

/** Pecah trade menurut bucket skor Market Intelligence. */
export function sliceByScore(trades: BacktestTrade[]): PerformanceSlice[] {
  const scored = trades.filter(
    (t) => t.intelligenceScore !== null && t.intelligenceScore !== undefined,
  );
  if (!scored.length) return [];

  return SCORE_BUCKETS.map(([label, min, max]) =>
    slicePerformance(
      label,
      scored.filter((t) => t.intelligenceScore! >= min && t.intelligenceScore! <= max),
    ),
  ).filter((s) => s.trades > 0);
}

/** Pecah trade menurut regime pasar saat entry. */
export function sliceByRegime(trades: BacktestTrade[]): PerformanceSlice[] {
  const withRegime = trades.filter((t) => t.marketRegime);
  if (!withRegime.length) return [];

  const regimes = [...new Set(withRegime.map((t) => t.marketRegime!))];
  return regimes
    .map((regime) => slicePerformance(regime, withRegime.filter((t) => t.marketRegime === regime)))
    .sort((a, b) => b.trades - a.trades);
}
