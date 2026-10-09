import { Timeframe } from '../market-intelligence.types';

export type MarketRegimeType =
  | 'BULL_TREND'
  | 'BEAR_TREND'
  | 'SIDEWAYS'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'ACCUMULATION'
  | 'DISTRIBUTION';

/** Sumbu volatilitas berdiri sendiri: tren kuat bisa sekaligus sangat volatil. */
export type VolatilityRegime = 'HIGH_VOLATILITY' | 'NORMAL_VOLATILITY' | 'LOW_VOLATILITY';

export interface RegimeCandidate {
  regime: MarketRegimeType;
  /** 0-1. Seberapa kuat bukti yang mendukung regime ini. */
  score: number;
  /** Bukti yang dipakai - selalu lebih dari satu indikator. */
  evidence: string[];
}

export interface RegimeReport {
  timeframe: Timeframe;
  barTime: number;
  /** Regime utama - kandidat dengan skor tertinggi. */
  regime: MarketRegimeType;
  /** Regime pendukung, bila ada yang mendekati. */
  secondary: MarketRegimeType | null;
  confidence: number;
  volatility: VolatilityRegime;
  candidates: RegimeCandidate[];
  evidence: string[];
  /** Posisi harga dalam rentang N bar terakhir (0 = dasar, 1 = puncak). */
  positionInRange: number | null;
}
