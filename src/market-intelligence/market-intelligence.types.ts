/**
 * Tipe bersama untuk Market Intelligence Engine.
 *
 * Lapisan ini HANYA menganalisis. Ia tidak pernah mengirim order, tidak pernah
 * menentukan ukuran posisi, dan tidak memiliki akses ke kredensial exchange.
 * Hasilnya berupa keputusan analitis yang kemudian dipakai oleh strategi yang
 * sudah ada, lalu tetap melewati Risk Engine dan Execution Engine seperti biasa.
 */

/** Timeframe yang dipakai analisis multi-timeframe. */
export type Timeframe = '5m' | '15m' | '1H' | '4H' | '1D';

export const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1H', '4H', '1D'];

/**
 * Menit per timeframe.
 *
 * Perhatikan 1D = 1440 menit TIDAK diterima endpoint chart Indodax
 * (hanya 1, 5, 15, 30, 60, 240 yang valid). Candle harian karena itu
 * DIAGREGASI dari candle 4H — lihat `aggregateCandles`.
 */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '5m': 5,
  '15m': 15,
  '1H': 60,
  '4H': 240,
  '1D': 1440,
};

/** Peran tiap timeframe dalam hierarki analisis (bagian 2 spesifikasi). */
export const TIMEFRAME_ROLE: Record<Timeframe, string> = {
  '1D': 'MACRO_TREND',
  '4H': 'PRIMARY_TREND',
  '1H': 'SETUP',
  '15m': 'CONFIRMATION',
  '5m': 'EXECUTION_TIMING',
};

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type TradeDirection = 'LONG' | 'SHORT' | 'NONE';

/** Keputusan akhir Confluence Engine. */
export type IntelligenceDecision = 'NO_TRADE' | 'WATCH' | 'TRADE_SETUP' | 'HIGH_QUALITY_SETUP';

export interface ScoreBand {
  decision: IntelligenceDecision;
  min: number;
  max: number;
}

/**
 * Ambang skor. Skor adalah QUALITY SCORE dari rule engine —
 * BUKAN probabilitas profit. Lihat bagian 6 spesifikasi.
 */
export const SCORE_BANDS: ScoreBand[] = [
  { decision: 'NO_TRADE', min: 0, max: 49 },
  { decision: 'WATCH', min: 50, max: 64 },
  { decision: 'TRADE_SETUP', min: 65, max: 79 },
  { decision: 'HIGH_QUALITY_SETUP', min: 80, max: 100 },
];

export function decisionForScore(score: number): IntelligenceDecision {
  const band = SCORE_BANDS.find((b) => score >= b.min && score <= b.max);
  return band?.decision ?? 'NO_TRADE';
}

/** Alasan terstruktur — dipakai untuk penjelasan sinyal dan audit. */
export interface Reason {
  /** Dimensi yang menghasilkan alasan ini (TREND, STRUCTURE, MOMENTUM, ...). */
  dimension: string;
  /** Kalimat siap tampil. */
  text: string;
  /** POSITIVE menambah keyakinan, RISK adalah peringatan, BLOCKER menolak trade. */
  kind: 'POSITIVE' | 'RISK' | 'BLOCKER';
}
