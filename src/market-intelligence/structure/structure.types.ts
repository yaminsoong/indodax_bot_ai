import { Direction, Timeframe } from '../market-intelligence.types';

export type SwingType = 'HIGH' | 'LOW';

/** Label struktur sebuah pivot dibandingkan pivot sejenis sebelumnya. */
export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL' | 'FIRST';

export interface SwingPoint {
  type: SwingType;
  label: SwingLabel;
  price: number;
  /** Waktu candle pivot (epoch detik). */
  time: number;
  /** Indeks pivot pada array candle yang dianalisis. */
  index: number;
  /**
   * Waktu candle saat pivot ini BISA DIKETAHUI.
   *
   * Sebuah pivot baru terkonfirmasi setelah `lookbackRight` candle berikutnya
   * tertutup. Menganggapnya diketahui pada candle pivot itu sendiri adalah
   * look-ahead bias klasik yang membuat backtest terlihat jauh lebih baik
   * daripada kenyataan.
   */
  confirmedAtTime: number;
  confirmedAtIndex: number;
}

export type StructureEventType =
  | 'HIGHER_HIGH'
  | 'HIGHER_LOW'
  | 'LOWER_HIGH'
  | 'LOWER_LOW'
  | 'BOS'
  | 'CHOCH'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'RETEST'
  | 'LIQUIDITY_SWEEP'
  | 'FAILED_BREAKOUT';

/**
 * Satu kejadian struktur pasar.
 *
 * `time` adalah waktu candle saat kejadian TERKONFIRMASI (candle sudah tutup),
 * bukan waktu level yang ditembus. Dengan begitu setiap event aman dipakai
 * backtest tanpa melihat masa depan.
 */
export interface StructureEvent {
  type: StructureEventType;
  direction: Direction;
  price: number;
  timestamp: number;
  timeframe: Timeframe;
  /** 0-1. Gabungan konfirmasi volume, jarak tembus, dan kualitas level. */
  confidence: number;
  /** Penjelasan singkat siap tampil. */
  detail: string;
}

export interface StructureReport {
  timeframe: Timeframe;
  /** Waktu candle terakhir yang dianalisis. */
  barTime: number;
  /** Tren menurut struktur harga (bukan menurut indikator). */
  trend: Direction;
  swings: SwingPoint[];
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  /** Seluruh event, terurut menaik menurut waktu. */
  events: StructureEvent[];
  /** Event terbaru per jenis - jalan pintas untuk Confluence Engine. */
  latest: Partial<Record<StructureEventType, StructureEvent>>;
  /** Event yang terjadi pada candle terakhir saja. */
  onLastBar: StructureEvent[];
}

export interface StructureOptions {
  /** Jumlah candle di kiri-kanan pivot yang harus lebih rendah/tinggi. */
  swingLookback: number;
  /** Berapa candle ke belakang dipakai menilai breakout rentang. */
  rangeLookback: number;
  /** Seberapa dekat harga harus kembali ke level agar dihitung retest (persen). */
  retestTolerancePercent: number;
  /** Batas candle untuk menyatakan breakout gagal setelah tembus. */
  failedBreakoutBars: number;
  /** Jumlah maksimum event yang disimpan (yang terbaru dipertahankan). */
  maxEvents: number;
}

export const DEFAULT_STRUCTURE_OPTIONS: StructureOptions = {
  swingLookback: 2,
  rangeLookback: 20,
  retestTolerancePercent: 0.4,
  failedBreakoutBars: 3,
  maxEvents: 60,
};
