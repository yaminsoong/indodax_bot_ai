import { Injectable, Logger } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { IndodaxService } from '../../indodax/indodax.service';
import { Timeframe, TIMEFRAME_MINUTES } from '../market-intelligence.types';
import { CandleSet } from './mtf.types';
import { aggregateCandles } from './candle-aggregator';

/**
 * Penyedia candle multi-timeframe untuk Market Intelligence.
 *
 * Ini BUKAN market data service kedua: seluruh pengambilan data tetap melewati
 * `IndodaxService` yang sudah ada, lengkap dengan rate limiter, retry, dan
 * pembuangan candle yang belum tutup. Lapisan ini hanya menambahkan dua hal
 * yang memang belum ada:
 *
 *  1. CACHE per (pair, timeframe). Satu siklus menganalisis lima timeframe kali
 *     sekian pair; tanpa cache, jatah rate limit habis hanya untuk mengambil
 *     data yang sama berulang kali.
 *
 *  2. AGREGASI candle harian. Endpoint chart Indodax menolak tf=1440, jadi
 *     candle 1D dibentuk dari enam candle 4H.
 */
@Injectable()
export class MarketDataProvider {
  private readonly logger = new Logger(MarketDataProvider.name);

  /** Cache candle; kunci `pair|timeframe`. */
  private cache = new Map<string, { at: number; candles: Candle[] }>();

  constructor(private readonly indodax: IndodaxService) {}

  /**
   * Umur cache: seperempat panjang candle, minimal 30 detik.
   *
   * Candle 4H tidak berubah selama empat jam; mengambilnya tiap menit hanya
   * membuang jatah rate limit tanpa menambah satu pun informasi baru.
   */
  private ttlMs(tf: Timeframe): number {
    return Math.max(30_000, (TIMEFRAME_MINUTES[tf] * 60_000) / 4);
  }

  /** Ambil candle satu timeframe (dengan cache). */
  async getCandles(pair: string, tf: Timeframe, bars: number): Promise<Candle[]> {
    const key = `${pair.toLowerCase()}|${tf}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs(tf) && hit.candles.length >= bars * 0.9) {
      return hit.candles;
    }

    let candles: Candle[];
    if (tf === '1D') {
      /**
       * Endpoint chart Indodax menolak tf=1440, jadi candle harian dibentuk
       * dari enam candle 4H. Jumlah hari dibatasi 200 supaya permintaannya
       * tidak menjadi 1.800 candle sekaligus - riwayat sepanjang itu tidak
       * menambah kualitas analisis, hanya memperlambat setiap siklus.
       */
      const days = Math.min(bars, 200);
      const source = await this.indodax.getCandles(pair, 240, days * 6 + 12);
      candles = aggregateCandles(source, 1440, 240);
    } else {
      candles = await this.indodax.getCandles(pair, TIMEFRAME_MINUTES[tf], bars);
    }

    this.cache.set(key, { at: Date.now(), candles });
    return candles;
  }

  /**
   * Ambil seluruh timeframe yang diminta.
   *
   * Kegagalan satu timeframe tidak menggagalkan keseluruhan: analisis tetap
   * berjalan dengan timeframe yang tersedia, dan timeframe yang hilang dicatat
   * pada `MtfContext.missing` sehingga operator tahu penilaian dibuat dengan
   * informasi yang tidak lengkap.
   */
  async getCandleSet(pair: string, timeframes: Timeframe[], bars: number): Promise<CandleSet> {
    const set: CandleSet = {};

    const results = await Promise.all(
      timeframes.map(async (tf) => {
        try {
          return { tf, candles: await this.getCandles(pair, tf, bars) };
        } catch (err) {
          this.logger.warn(`Candle ${pair} ${tf} gagal diambil: ${err.message}`);
          return { tf, candles: [] as Candle[] };
        }
      }),
    );

    for (const { tf, candles } of results) {
      if (candles.length) set[tf] = candles;
    }
    return set;
  }

  /** Kosongkan cache - dipakai setelah perubahan konfigurasi timeframe. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Umur data terbaru per timeframe, untuk health monitor. */
  cacheAges(): Array<{ key: string; ageSeconds: number; bars: number }> {
    const now = Date.now();
    return [...this.cache.entries()].map(([key, v]) => ({
      key,
      ageSeconds: Math.round((now - v.at) / 1000),
      bars: v.candles.length,
    }));
  }
}
