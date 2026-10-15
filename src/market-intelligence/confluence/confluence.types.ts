import {
  IntelligenceDecision,
  Reason,
  Timeframe,
  TradeDirection,
} from '../market-intelligence.types';
import { MarketRegimeType } from '../regime/regime.types';

/** Delapan dimensi penilaian (bagian 6 spesifikasi). */
export type ConfluenceDimension =
  | 'TREND_ALIGNMENT'
  | 'MARKET_STRUCTURE'
  | 'MOMENTUM'
  | 'VOLUME'
  | 'SUPPORT_RESISTANCE'
  | 'VOLATILITY'
  | 'ORDER_BOOK'
  | 'RISK_REWARD';

/** Bobot tiap dimensi. Totalnya harus 100. Seluruhnya dapat dikonfigurasi. */
export type ConfluenceWeights = Record<ConfluenceDimension, number>;

export const DEFAULT_WEIGHTS: ConfluenceWeights = {
  TREND_ALIGNMENT: 25,
  MARKET_STRUCTURE: 20,
  MOMENTUM: 15,
  VOLUME: 15,
  SUPPORT_RESISTANCE: 10,
  VOLATILITY: 5,
  ORDER_BOOK: 5,
  RISK_REWARD: 5,
};

export interface DimensionScore {
  dimension: ConfluenceDimension;
  /** 0-100 sebelum dikalikan bobot. */
  raw: number;
  weight: number;
  /** raw x weight / 100 - sumbangan dimensi ini ke skor akhir. */
  contribution: number;
  /**
   * True bila dimensi tidak dapat dinilai (mis. order book tidak tersedia saat
   * backtest). Dimensi seperti ini diberi nilai netral dan bobotnya
   * didistribusikan ulang, bukan dihitung sebagai nol.
   */
  unavailable: boolean;
  notes: string[];
}

/** Setup analitis yang diusulkan Market Intelligence (bagian 9 spesifikasi). */
export interface TradeSetup {
  direction: TradeDirection;
  /** Rentang harga masuk yang wajar. */
  entryLow: number;
  entryHigh: number;
  /** Harga acuan untuk perhitungan (biasanya close terakhir). */
  entryReference: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  /** Risiko per unit (entry - stop untuk LONG). */
  riskPerUnit: number;
  /** Rasio imbalan/risiko terhadap TP2, target acuan. */
  riskReward: number;
  riskRewardTp1: number;
  riskRewardTp3: number;
  atr: number;
  atrPercent: number;
  /** Dasar penentuan stop, untuk ditampilkan ke operator. */
  stopBasis: string;
  targetBasis: string;
}

export interface ConfluenceResult {
  pair: string;
  /** Timeframe acuan setup. */
  timeframe: Timeframe;
  direction: TradeDirection;
  /** 0-100. QUALITY SCORE dari rule engine - BUKAN probabilitas profit. */
  score: number;
  decision: IntelligenceDecision;
  regime: MarketRegimeType;
  dimensions: DimensionScore[];
  /** Skor per dimensi dalam bentuk ringkas, siap disimpan ke database. */
  breakdown: Record<ConfluenceDimension, number>;
  setup: TradeSetup | null;
  reasons: Reason[];
  /** Alasan tegas menolak trade. Bila tidak kosong, decision selalu NO_TRADE. */
  blockers: string[];
  riskFactors: string[];
  /**
   * False bila arah setup tidak dapat dieksekusi oleh sistem ini.
   * Indodax adalah bursa spot: bot hanya bisa BELI lalu JUAL, sehingga setup
   * SHORT hanya bernilai sebagai informasi.
   */
  executable: boolean;
}

/** Ambang yang membentuk No Trade Engine (bagian 8 spesifikasi). */
export interface NoTradeThresholds {
  /** Rasio imbalan/risiko minimum. */
  minRiskReward: number;
  /** Jarak minimum ke resistance terdekat, dalam persen harga. */
  minResistanceDistancePercent: number;
  /** Jarak maksimum ke support terdekat sebelum dianggap terlalu jauh, persen. */
  maxSupportDistancePercent: number;
  /** ATR persen di atas ini dianggap volatilitas ekstrem. */
  maxAtrPercent: number;
  /**
   * ATR persen MINIMUM agar sebuah setup punya ruang profit.
   *
   * Ambang ini sangat bergantung timeframe: ATR 15 menit pada BTC biasanya
   * 0,1-0,4%, sementara fee bolak-balik saja sudah 0,2-0,4%. Nilai yang cocok
   * untuk 4H akan menolak hampir seluruh sinyal 15m — karena itu ia
   * dikonfigurasi, bukan ditanam di kode.
   */
  minAtrPercent: number;
  /**
   * Batas rasio BIAYA PULANG-PERGI terhadap ATR.
   *
   * Ini pengganti yang lebih jujur bagi `minAtrPercent`, yang memakai angka
   * absolut dan karena itu tidak bisa membedakan pair murah dari pair mahal.
   * Diukur pada 2026-10-15: BTC ATR 0,53%/jam dengan biaya 0,40% -> rasio
   * 0,76x, artinya gerakan satu jam penuh hanya menutup tiga per empat
   * biayanya. PAXG lebih buruk lagi: rasio 1,94x, mustahil secara aritmetika.
   * Keduanya LOLOS `minAtrPercent` 0,4%.
   *
   * Sebaliknya ZEREBRO ATR 7,12% dengan biaya 0,76% -> rasio 0,11x: enam
   * menit gerakan normal sudah menutup biayanya.
   *
   * 1,0 berarti gerakan satu bar penuh hanya cukup menutup biaya dan belum
   * menghasilkan apa pun.
   */
  maxCostToAtrRatio: number;
  /** Volume relatif minimum pada timeframe acuan. */
  minRelativeVolume: number;
  /** Posisi harga dalam rentang yang dianggap "di tengah" dan dihindari. */
  midRangeLow: number;
  midRangeHigh: number;
  /** Konflik timeframe berdekatan maksimum sebelum trade ditolak. */
  maxTimeframeConflicts: number;
}

export const DEFAULT_NO_TRADE: NoTradeThresholds = {
  // 1,0 = gerakan satu bar hanya menutup biaya. Di atas itu mustahil.
  maxCostToAtrRatio: 1.0,
  minRiskReward: 1.5,
  minResistanceDistancePercent: 1.0,
  maxSupportDistancePercent: 8.0,
  maxAtrPercent: 6.0,
  minAtrPercent: 0.4,
  minRelativeVolume: 0.5,
  midRangeLow: 0.4,
  midRangeHigh: 0.6,
  maxTimeframeConflicts: 1,
};

/** Metrik order book, bila tersedia. Selalu hanya konfirmasi, bukan sinyal utama. */
export interface OrderBookContext {
  imbalance: number;
  spreadPercent: number;
  bidDepthIdr: number;
  askDepthIdr: number;
}

export interface ConfluenceOptions {
  weights?: Partial<ConfluenceWeights>;
  /**
   * Biaya pulang-pergi dalam persen harga: fee dua sisi + spread.
   *
   * Dipasok pemanggil karena fee bersifat per-pair dan spread datang dari
   * ringkasan pasar; engine ini tidak punya akses ke keduanya. Bila tidak
   * diberikan, penilaian volatilitas kembali memakai ambang ATR absolut -
   * backtest tidak punya data spread historis, dan kehilangan satu dimensi
   * lebih baik daripada memakai biaya yang dikarang.
   */
  roundTripCostPercent?: number;
  noTrade?: Partial<NoTradeThresholds>;
  /** Kelipatan ATR untuk stop loss analitis. */
  atrStopMultiplier?: number;
  /** Kelipatan risiko untuk TP1/TP2/TP3. */
  targetMultiples?: [number, number, number];
  orderBook?: OrderBookContext;
}
