import { Candle } from '../../indodax/indodax.types';
import { Direction, Timeframe } from '../market-intelligence.types';
import { IndicatorReport } from '../indicators/indicator.types';
import { StructureReport } from '../structure/structure.types';
import { SupportResistanceReport } from '../levels/support-resistance.types';
import { RegimeReport } from '../regime/regime.types';

/** Hasil analisis lengkap untuk SATU timeframe. */
export interface TimeframeAnalysis {
  timeframe: Timeframe;
  /** Peran timeframe ini dalam hierarki (macro trend, setup, dsb). */
  role: string;
  bars: number;
  barTime: number;
  indicators: IndicatorReport;
  structure: StructureReport | null;
  levels: SupportResistanceReport | null;
  regime: RegimeReport;
  /** Arah yang disimpulkan dari timeframe ini. */
  bias: Direction;
  /** Seberapa yakin bias ini (0-1). */
  biasConfidence: number;
  biasReasons: string[];
}

export interface TimeframeAlignment {
  /**
   * -1 (seluruh timeframe bearish) hingga +1 (seluruh timeframe bullish),
   * tertimbang menurut kepentingan timeframe.
   */
  score: number;
  direction: Direction;
  /** Timeframe yang searah dengan arah dominan. */
  aligned: Timeframe[];
  /** Timeframe yang berlawanan arah. */
  conflicting: Timeframe[];
  /** Penjelasan konflik yang penting, mis. "4H dan 1H bertentangan". */
  conflicts: string[];
}

export interface MtfContext {
  pair: string;
  /** Waktu analisis dibuat (epoch detik) - diambil dari candle, bukan jam sistem. */
  asOf: number;
  /** Analisis per timeframe yang datanya tersedia. */
  timeframes: Partial<Record<Timeframe, TimeframeAnalysis>>;
  /** Timeframe yang diminta tetapi datanya tidak memadai. */
  missing: Timeframe[];
  alignment: TimeframeAlignment;
  /** Timeframe yang dipakai sebagai acuan setup (default 1H, turun bila tidak ada). */
  primaryTimeframe: Timeframe;
  /** Timeframe eksekusi (default 5m, naik bila tidak ada). */
  executionTimeframe: Timeframe;
}

/** Candle per timeframe; nilai harus berupa candle yang SUDAH TERTUTUP. */
export type CandleSet = Partial<Record<Timeframe, Candle[]>>;
