import { Injectable } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { clamp } from '../../common/num';
import { Timeframe } from '../market-intelligence.types';
import { StructureEngineService } from '../structure/structure-engine.service';
import { StructureReport } from '../structure/structure.types';
import {
  DEFAULT_SR_OPTIONS,
  SupportResistanceOptions,
  SupportResistanceReport,
  SupportResistanceZone,
  ZoneOrigin,
  ZoneType,
} from './support-resistance.types';

/** Kandidat level sebelum digabung menjadi zona. */
interface LevelCandidate {
  price: number;
  origin: ZoneOrigin;
  time: number;
  /** Bobot awal menurut asal level. */
  weight: number;
}

/**
 * Support / Resistance Engine.
 *
 * Level dikumpulkan dari lima sumber (bagian 4 spesifikasi): swing high, swing
 * low, penolakan berulang, level yang pernah ditembus, dan konsentrasi volume.
 *
 * Level yang berdekatan DIGABUNG menjadi zona. Ini bukan sekadar kerapian:
 * harga tidak pernah berbalik tepat di satu angka, dan memperlakukan
 * 125.000.000 serta 125.100.000 sebagai dua resistance terpisah menghasilkan
 * daftar panjang berisi level yang sebenarnya satu dan sama.
 *
 * Satu prinsip yang dipegang: level yang PERNAH DITEMBUS berganti peran.
 * Resistance yang jebol menjadi support, dan sebaliknya - itulah sebabnya
 * BROKEN_LEVEL menjadi salah satu asal level.
 */
@Injectable()
export class SupportResistanceService {
  constructor(private readonly structure: StructureEngineService) {}

  analyze(
    timeframe: Timeframe,
    candles: Candle[],
    structureReport?: StructureReport | null,
    options: Partial<SupportResistanceOptions> = {},
  ): SupportResistanceReport | null {
    const opts: SupportResistanceOptions = { ...DEFAULT_SR_OPTIONS, ...options };
    if (candles.length < 20) return null;

    const window = candles.slice(-opts.lookbackBars);
    const lastBar = window[window.length - 1];
    const price = lastBar.close;
    if (!(price > 0)) return null;

    const candidates = this.collectCandidates(window, structureReport, opts);
    if (!candidates.length) {
      return {
        timeframe,
        barTime: lastBar.time,
        price,
        zones: [],
        nearestSupport: null,
        nearestResistance: null,
        positionInRange: null,
      };
    }

    const zones = this.buildZones(candidates, window, price, timeframe, opts);

    const supports = zones.filter((z) => z.priceHigh < price).sort((a, b) => b.price - a.price);
    const resistances = zones.filter((z) => z.priceLow > price).sort((a, b) => a.price - b.price);

    const nearestSupport = supports[0] ?? null;
    const nearestResistance = resistances[0] ?? null;

    let positionInRange: number | null = null;
    if (nearestSupport && nearestResistance) {
      const span = nearestResistance.price - nearestSupport.price;
      if (span > 0) positionInRange = clamp((price - nearestSupport.price) / span, 0, 1);
    }

    return {
      timeframe,
      barTime: lastBar.time,
      price,
      zones,
      nearestSupport,
      nearestResistance,
      positionInRange,
    };
  }

  // --- Pengumpulan level ---------------------------------------------------

  private collectCandidates(
    candles: Candle[],
    structureReport: StructureReport | null | undefined,
    opts: SupportResistanceOptions,
  ): LevelCandidate[] {
    const out: LevelCandidate[] = [];

    // 1-2. Swing high & swing low.
    const swings = this.structure.findSwings(candles, 2);
    for (const s of swings) {
      out.push({
        price: s.price,
        origin: s.type === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW',
        time: s.time,
        // Pivot yang lebih ekstrem (HH / LL) menandai batas rentang yang lebih
        // penting daripada pivot di tengah-tengah.
        weight: s.label === 'HH' || s.label === 'LL' ? 1.2 : 1,
      });
    }

    // 3. Level yang pernah ditembus - berganti peran setelah tembus.
    for (const e of structureReport?.events ?? []) {
      if (e.type === 'BREAKOUT' || e.type === 'BREAKDOWN' || e.type === 'BOS' || e.type === 'CHOCH') {
        out.push({ price: e.price, origin: 'BROKEN_LEVEL', time: e.timestamp, weight: 1.3 });
      }
    }

    // 4. Konsentrasi volume - harga tempat transaksi paling banyak terjadi.
    out.push(...this.volumeConcentration(candles, opts.volumeBuckets));

    return out.filter((c) => Number.isFinite(c.price) && c.price > 0);
  }

  /**
   * Profil volume sederhana: bagi rentang harga menjadi keranjang, jumlahkan
   * volume tiap keranjang, ambil puncaknya.
   *
   * Volume setiap candle dialokasikan ke keranjang harga TENGAHnya, bukan
   * disebar ke seluruh rentang high-low. Penyebaran akan meratakan profil
   * sampai tidak ada puncak yang tersisa untuk dikenali.
   */
  private volumeConcentration(candles: Candle[], buckets: number): LevelCandidate[] {
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));
    if (!(high > low) || buckets < 4) return [];

    const size = (high - low) / buckets;
    const volumes = new Array(buckets).fill(0);
    const lastTime = new Array(buckets).fill(0);

    for (const c of candles) {
      const mid = (c.high + c.low) / 2;
      const idx = clamp(Math.floor((mid - low) / size), 0, buckets - 1);
      volumes[idx] += c.volume;
      lastTime[idx] = Math.max(lastTime[idx], c.time);
    }

    const totalVolume = volumes.reduce((a, b) => a + b, 0);
    if (totalVolume <= 0) return [];

    // Hanya keranjang yang jelas menonjol (>= 1,8x rata-rata) yang dianggap
    // konsentrasi; selebihnya hanya distribusi biasa.
    const avg = totalVolume / buckets;
    const out: LevelCandidate[] = [];
    for (let i = 0; i < buckets; i++) {
      if (volumes[i] >= avg * 1.8) {
        out.push({
          price: low + size * (i + 0.5),
          origin: 'VOLUME_CONCENTRATION',
          time: lastTime[i],
          weight: 1.1,
        });
      }
    }
    return out;
  }

  // --- Penggabungan menjadi zona -------------------------------------------

  private buildZones(
    candidates: LevelCandidate[],
    candles: Candle[],
    price: number,
    timeframe: Timeframe,
    opts: SupportResistanceOptions,
  ): SupportResistanceZone[] {
    const tolerance = price * (opts.clusterTolerancePercent / 100);
    const sorted = [...candidates].sort((a, b) => a.price - b.price);

    const clusters: LevelCandidate[][] = [];
    for (const c of sorted) {
      const current = clusters[clusters.length - 1];
      // Dibandingkan terhadap level PERTAMA klaster, bukan yang terakhir,
      // agar rantai level berjarak kecil tidak menggelinding menjadi satu zona
      // selebar setengah grafik.
      if (current && c.price - current[0].price <= tolerance * 2) {
        current.push(c);
      } else {
        clusters.push([c]);
      }
    }

    const newest = candles[candles.length - 1].time;
    const oldest = candles[0].time;
    const span = Math.max(1, newest - oldest);

    const zones = clusters.map((cluster) => {
      const prices = cluster.map((c) => c.price);
      const priceLow = Math.min(...prices);
      const priceHigh = Math.max(...prices);
      const mid = (priceLow + priceHigh) / 2;

      const touch = this.countTouches(candles, priceLow - tolerance, priceHigh + tolerance);
      const origins = [...new Set(cluster.map((c) => c.origin))];
      const weight = cluster.reduce((s, c) => s + c.weight, 0);
      const lastTouchTime = Math.max(touch.lastTime, ...cluster.map((c) => c.time));

      // Kesegaran: level yang disentuh baru-baru ini lebih relevan daripada
      // level dari ratusan bar lalu yang sudah lama ditinggalkan harga.
      const recency = clamp((lastTouchTime - oldest) / span, 0, 1);

      const strength = clamp(
        Math.round(
          clamp(touch.count / 6, 0, 1) * 45 +
            clamp(weight / 4, 0, 1) * 25 +
            recency * 20 +
            (origins.length >= 2 ? 10 : 0),
        ),
        0,
        100,
      );

      const zone: SupportResistanceZone = {
        priceLow,
        priceHigh,
        price: mid,
        strength,
        touchCount: touch.count,
        timeframe,
        type: this.classify(mid, priceLow, priceHigh, price, strength, opts.strongThreshold),
        origins,
        lastTouchTime,
        distancePercent: ((mid - price) / price) * 100,
      };
      return zone;
    });

    return zones
      .sort((a, b) => b.strength - a.strength)
      .slice(0, opts.maxZones)
      .sort((a, b) => a.price - b.price);
  }

  /** Berapa kali rentang candle menyentuh zona. */
  private countTouches(
    candles: Candle[],
    low: number,
    high: number,
  ): { count: number; lastTime: number } {
    let count = 0;
    let lastTime = 0;
    let insideRun = false;

    for (const c of candles) {
      const touching = c.low <= high && c.high >= low;
      // Sentuhan beruntun beberapa candle dihitung SATU kali. Tanpa ini,
      // harga yang diam di dalam zona selama 30 candle akan tampak seperti
      // 30 penolakan - padahal tidak ada penolakan sama sekali.
      if (touching && !insideRun) {
        count++;
        lastTime = c.time;
      }
      if (touching) lastTime = Math.max(lastTime, c.time);
      insideRun = touching;
    }
    return { count, lastTime };
  }

  private classify(
    mid: number,
    low: number,
    high: number,
    price: number,
    strength: number,
    strongThreshold: number,
  ): ZoneType {
    // Harga sedang berada DI DALAM zona: ia tidak berfungsi sebagai support
    // maupun resistance saat ini.
    if (price >= low && price <= high) return 'PIVOT';
    if (mid < price) return strength >= strongThreshold ? 'STRONG_SUPPORT' : 'SUPPORT';
    return strength >= strongThreshold ? 'STRONG_RESISTANCE' : 'RESISTANCE';
  }
}
