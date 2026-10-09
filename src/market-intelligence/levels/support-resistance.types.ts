import { Timeframe } from '../market-intelligence.types';

export type ZoneType =
  | 'STRONG_SUPPORT'
  | 'SUPPORT'
  | 'PIVOT'
  | 'RESISTANCE'
  | 'STRONG_RESISTANCE';

/** Dari mana sebuah level berasal - dipakai untuk menjelaskan zona ke operator. */
export type ZoneOrigin =
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'BROKEN_LEVEL'
  | 'VOLUME_CONCENTRATION';

export interface SupportResistanceZone {
  /** Batas bawah zona. */
  priceLow: number;
  /** Batas atas zona. */
  priceHigh: number;
  /** Titik tengah zona - dipakai untuk mengukur jarak ke harga. */
  price: number;
  /** 0-100. Gabungan jumlah sentuhan, kesegaran, volume, dan lebar zona. */
  strength: number;
  /** Berapa kali harga menyentuh zona ini. */
  touchCount: number;
  timeframe: Timeframe;
  type: ZoneType;
  origins: ZoneOrigin[];
  /** Waktu sentuhan terakhir (epoch detik). */
  lastTouchTime: number;
  /** Jarak dari harga sekarang, dalam persen (negatif = zona di bawah harga). */
  distancePercent: number;
}

export interface SupportResistanceReport {
  timeframe: Timeframe;
  barTime: number;
  price: number;
  zones: SupportResistanceZone[];
  /** Zona support terdekat di BAWAH harga. */
  nearestSupport: SupportResistanceZone | null;
  /** Zona resistance terdekat di ATAS harga. */
  nearestResistance: SupportResistanceZone | null;
  /**
   * Posisi harga di antara support dan resistance terdekat (0 = di support,
   * 1 = di resistance). Harga di tengah rentang adalah lokasi entry terburuk:
   * ruang naik terbatas, ruang turun juga terbatas.
   */
  positionInRange: number | null;
}

export interface SupportResistanceOptions {
  /** Toleransi penggabungan level sebagai persen harga. */
  clusterTolerancePercent: number;
  /** Berapa candle ke belakang dipakai mengumpulkan level. */
  lookbackBars: number;
  /** Jumlah zona maksimum yang dikembalikan (terkuat dipertahankan). */
  maxZones: number;
  /** Jumlah keranjang harga untuk profil volume. */
  volumeBuckets: number;
  /** Ambang kekuatan sebelum zona disebut STRONG. */
  strongThreshold: number;
}

export const DEFAULT_SR_OPTIONS: SupportResistanceOptions = {
  clusterTolerancePercent: 0.5,
  lookbackBars: 200,
  maxZones: 12,
  volumeBuckets: 24,
  strongThreshold: 65,
};
