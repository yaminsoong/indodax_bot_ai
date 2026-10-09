import { Injectable } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { TechnicalService } from '../../indicators/technical.service';
import { clamp, mean } from '../../common/num';
import { Direction, Timeframe } from '../market-intelligence.types';
import {
  DEFAULT_STRUCTURE_OPTIONS,
  StructureEvent,
  StructureEventType,
  StructureOptions,
  StructureReport,
  SwingLabel,
  SwingPoint,
} from './structure.types';

/** Level yang sedang "aktif" ditembus, dipantau untuk retest / kegagalan. */
interface PendingBreak {
  direction: Direction;
  level: number;
  brokenAtIndex: number;
  retested: boolean;
  failed: boolean;
}

/**
 * Market Structure Engine.
 *
 * Membaca struktur harga apa adanya: swing, HH/HL/LH/LL, BOS, CHOCH, breakout,
 * retest, liquidity sweep, dan failed breakout.
 *
 * Dua aturan yang menentukan kebenaran seluruh lapisan ini:
 *
 *  1. KONFIRMASI MEMAKAI CLOSE. Sumbu (wick) yang menembus level bukan
 *     breakout - justru sering kebalikannya, yaitu likuiditas yang disapu
 *     sebelum harga berbalik. Karena itu wick yang menembus lalu close kembali
 *     ke dalam dicatat sebagai LIQUIDITY_SWEEP, bukan BREAKOUT.
 *
 *  2. TANPA LOOK-AHEAD. Pivot baru dianggap ada setelah `swingLookback` candle
 *     berikutnya tertutup, dan pemindaian dilakukan maju bar demi bar memakai
 *     hanya pivot yang sudah terkonfirmasi pada bar tersebut. Inilah yang
 *     membuat event di sini aman dipakai backtest.
 */
@Injectable()
export class StructureEngineService {
  constructor(private readonly technical: TechnicalService) {}

  // --- Pivot ---------------------------------------------------------------

  /**
   * Temukan seluruh pivot swing pada deret candle.
   *
   * Pivot high pada indeks i berarti high[i] lebih tinggi daripada `lookback`
   * candle di kiri DAN kanannya. Konsekuensinya pivot paling baru yang mungkin
   * ada berada di indeks `length - 1 - lookback`.
   */
  findSwings(candles: Candle[], lookback = DEFAULT_STRUCTURE_OPTIONS.swingLookback): SwingPoint[] {
    const swings: SwingPoint[] = [];
    if (candles.length < lookback * 2 + 1) return swings;

    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high < candles[i + j].high) {
          isHigh = false;
        }
        if (candles[i].low >= candles[i - j].low || candles[i].low > candles[i + j].low) {
          isLow = false;
        }
        if (!isHigh && !isLow) break;
      }

      const confirmedAtIndex = i + lookback;
      if (isHigh) {
        swings.push({
          type: 'HIGH',
          label: 'FIRST',
          price: candles[i].high,
          time: candles[i].time,
          index: i,
          confirmedAtIndex,
          confirmedAtTime: candles[confirmedAtIndex].time,
        });
      } else if (isLow) {
        swings.push({
          type: 'LOW',
          label: 'FIRST',
          price: candles[i].low,
          time: candles[i].time,
          index: i,
          confirmedAtIndex,
          confirmedAtTime: candles[confirmedAtIndex].time,
        });
      }
    }

    return this.labelSwings(swings);
  }

  /** Beri label HH/HL/LH/LL dengan membandingkan pivot sejenis sebelumnya. */
  private labelSwings(swings: SwingPoint[]): SwingPoint[] {
    let lastHigh: SwingPoint | null = null;
    let lastLow: SwingPoint | null = null;

    for (const s of swings) {
      let label: SwingLabel = 'FIRST';
      if (s.type === 'HIGH') {
        if (lastHigh) label = s.price > lastHigh.price ? 'HH' : 'LH';
        lastHigh = s;
      } else {
        if (lastLow) label = s.price > lastLow.price ? 'HL' : 'LL';
        lastLow = s;
      }
      s.label = label;
    }
    return swings;
  }

  /**
   * Arah tren menurut struktur.
   *
   * Butuh DUA pasang label searah (mis. HH + HL) sebelum menyatakan arah.
   * Satu higher high saja bisa muncul di tengah downtrend mana pun.
   */
  structureTrend(swings: SwingPoint[]): Direction {
    const recent = swings.slice(-4);
    const bull = recent.filter((s) => s.label === 'HH' || s.label === 'HL').length;
    const bear = recent.filter((s) => s.label === 'LH' || s.label === 'LL').length;
    if (bull >= 2 && bull > bear) return 'BULLISH';
    if (bear >= 2 && bear > bull) return 'BEARISH';
    return 'NEUTRAL';
  }

  // --- Analisis penuh ------------------------------------------------------

  analyze(
    timeframe: Timeframe,
    candles: Candle[],
    options: Partial<StructureOptions> = {},
  ): StructureReport | null {
    const opts: StructureOptions = { ...DEFAULT_STRUCTURE_OPTIONS, ...options };
    if (candles.length < opts.swingLookback * 2 + 5) return null;

    const swings = this.findSwings(candles, opts.swingLookback);
    const events: StructureEvent[] = [];

    const atrSeries = this.technical.calculateATRSeries(candles, 14);
    /** ATR pada bar i; dipakai menormalkan "seberapa jauh" harga menembus level. */
    const atrAt = (i: number): number => {
      // atrSeries[0] berpadanan dengan candles[14]; sebelum itu belum ada nilai.
      const pos = i - 14;
      if (pos < 0 || !atrSeries.length) return 0;
      return atrSeries[Math.min(pos, atrSeries.length - 1)];
    };

    const volAt = (i: number): number => {
      const from = Math.max(0, i - 20);
      const window = candles.slice(from, i).map((c) => c.volume);
      return window.length ? mean(window) : 0;
    };

    // Pivot dikelompokkan menurut bar tempat ia terkonfirmasi, supaya pemindaian
    // maju hanya pernah melihat pivot yang memang sudah bisa diketahui.
    const confirmedAt = new Map<number, SwingPoint[]>();
    for (const s of swings) {
      const list = confirmedAt.get(s.confirmedAtIndex) ?? [];
      list.push(s);
      confirmedAt.set(s.confirmedAtIndex, list);
    }

    const known: SwingPoint[] = [];
    let lastHigh: SwingPoint | null = null;
    let lastLow: SwingPoint | null = null;
    let trend: Direction = 'NEUTRAL';
    const pendingBreaks: PendingBreak[] = [];

    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      const atr = atrAt(i);
      const avgVol = volAt(i);
      const relVol = avgVol > 0 ? bar.volume / avgVol : 1;

      // -- 1. Pivot yang baru terkonfirmasi pada bar ini --------------------
      for (const s of confirmedAt.get(i) ?? []) {
        known.push(s);
        if (s.type === 'HIGH') lastHigh = s;
        else lastLow = s;

        const map: Record<SwingLabel, StructureEventType | null> = {
          HH: 'HIGHER_HIGH',
          HL: 'HIGHER_LOW',
          LH: 'LOWER_HIGH',
          LL: 'LOWER_LOW',
          FIRST: null,
        };
        const type = map[s.label];
        if (type) {
          events.push({
            type,
            direction: s.label === 'HH' || s.label === 'HL' ? 'BULLISH' : 'BEARISH',
            price: s.price,
            timestamp: bar.time,
            timeframe,
            confidence: 0.6,
            detail: `${s.label} terkonfirmasi di ${fmt(s.price)}`,
          });
        }
        trend = this.structureTrend(known);
      }

      // -- 2. Sapuan likuiditas: wick menembus, close kembali ke dalam ------
      if (lastHigh && bar.high > lastHigh.price && bar.close <= lastHigh.price) {
        events.push({
          type: 'LIQUIDITY_SWEEP',
          direction: 'BEARISH',
          price: lastHigh.price,
          timestamp: bar.time,
          timeframe,
          confidence: this.sweepConfidence(bar.high - lastHigh.price, atr, relVol),
          detail:
            `Wick menembus swing high ${fmt(lastHigh.price)} tetapi close ${fmt(bar.close)} ` +
            `kembali di bawahnya - likuiditas disapu, bukan breakout`,
        });
      }
      if (lastLow && bar.low < lastLow.price && bar.close >= lastLow.price) {
        events.push({
          type: 'LIQUIDITY_SWEEP',
          direction: 'BULLISH',
          price: lastLow.price,
          timestamp: bar.time,
          timeframe,
          confidence: this.sweepConfidence(lastLow.price - bar.low, atr, relVol),
          detail:
            `Wick menembus swing low ${fmt(lastLow.price)} tetapi close ${fmt(bar.close)} ` +
            `kembali di atasnya - likuiditas disapu`,
        });
      }

      // -- 3. BOS / CHOCH: konfirmasi CLOSE terhadap swing terakhir ---------
      if (lastHigh && bar.close > lastHigh.price) {
        const isChoch = trend === 'BEARISH';
        events.push({
          type: isChoch ? 'CHOCH' : 'BOS',
          direction: 'BULLISH',
          price: lastHigh.price,
          timestamp: bar.time,
          timeframe,
          confidence: this.breakConfidence(bar.close - lastHigh.price, atr, relVol, known.length),
          detail: isChoch
            ? `Close ${fmt(bar.close)} menembus swing high ${fmt(lastHigh.price)} saat struktur masih bearish - perubahan karakter`
            : `Close ${fmt(bar.close)} menembus swing high ${fmt(lastHigh.price)} - struktur naik berlanjut`,
        });
        pendingBreaks.push({
          direction: 'BULLISH',
          level: lastHigh.price,
          brokenAtIndex: i,
          retested: false,
          failed: false,
        });
        // Level sudah ditembus; menahannya akan menghasilkan BOS berulang
        // pada setiap candle berikutnya.
        lastHigh = null;
        if (trend !== 'BULLISH') trend = 'BULLISH';
      }

      if (lastLow && bar.close < lastLow.price) {
        const isChoch = trend === 'BULLISH';
        events.push({
          type: isChoch ? 'CHOCH' : 'BOS',
          direction: 'BEARISH',
          price: lastLow.price,
          timestamp: bar.time,
          timeframe,
          confidence: this.breakConfidence(lastLow.price - bar.close, atr, relVol, known.length),
          detail: isChoch
            ? `Close ${fmt(bar.close)} menembus swing low ${fmt(lastLow.price)} saat struktur masih bullish - perubahan karakter`
            : `Close ${fmt(bar.close)} menembus swing low ${fmt(lastLow.price)} - struktur turun berlanjut`,
        });
        pendingBreaks.push({
          direction: 'BEARISH',
          level: lastLow.price,
          brokenAtIndex: i,
          retested: false,
          failed: false,
        });
        lastLow = null;
        if (trend !== 'BEARISH') trend = 'BEARISH';
      }

      // -- 4. Breakout / breakdown rentang ---------------------------------
      if (i >= opts.rangeLookback) {
        const window = candles.slice(i - opts.rangeLookback, i);
        const rangeHigh = Math.max(...window.map((c) => c.high));
        const rangeLow = Math.min(...window.map((c) => c.low));
        const prevClose = candles[i - 1].close;

        if (bar.close > rangeHigh && prevClose <= rangeHigh) {
          events.push({
            type: 'BREAKOUT',
            direction: 'BULLISH',
            price: rangeHigh,
            timestamp: bar.time,
            timeframe,
            confidence: this.breakConfidence(bar.close - rangeHigh, atr, relVol, opts.rangeLookback),
            detail: `Close ${fmt(bar.close)} keluar dari puncak rentang ${opts.rangeLookback} bar (${fmt(rangeHigh)})`,
          });
          pendingBreaks.push({
            direction: 'BULLISH',
            level: rangeHigh,
            brokenAtIndex: i,
            retested: false,
            failed: false,
          });
        }

        if (bar.close < rangeLow && prevClose >= rangeLow) {
          events.push({
            type: 'BREAKDOWN',
            direction: 'BEARISH',
            price: rangeLow,
            timestamp: bar.time,
            timeframe,
            confidence: this.breakConfidence(rangeLow - bar.close, atr, relVol, opts.rangeLookback),
            detail: `Close ${fmt(bar.close)} jatuh dari dasar rentang ${opts.rangeLookback} bar (${fmt(rangeLow)})`,
          });
          pendingBreaks.push({
            direction: 'BEARISH',
            level: rangeLow,
            brokenAtIndex: i,
            retested: false,
            failed: false,
          });
        }
      }

      // -- 5. Retest & breakout gagal --------------------------------------
      for (const brk of pendingBreaks) {
        if (brk.failed || brk.brokenAtIndex >= i) continue;
        const age = i - brk.brokenAtIndex;
        const tolerance = brk.level * (opts.retestTolerancePercent / 100);

        if (brk.direction === 'BULLISH') {
          // Gagal: harga close kembali di bawah level yang ditembus.
          if (bar.close < brk.level && age <= opts.failedBreakoutBars) {
            brk.failed = true;
            events.push({
              type: 'FAILED_BREAKOUT',
              direction: 'BEARISH',
              price: brk.level,
              timestamp: bar.time,
              timeframe,
              confidence: clamp(0.5 + relVol * 0.2, 0, 0.95),
              detail: `Close kembali di bawah ${fmt(brk.level)} hanya ${age} bar setelah tembus - breakout gagal`,
            });
            continue;
          }
          // Retest: harga turun menyentuh level lalu close tetap di atasnya.
          if (!brk.retested && bar.low <= brk.level + tolerance && bar.close >= brk.level) {
            brk.retested = true;
            events.push({
              type: 'RETEST',
              direction: 'BULLISH',
              price: brk.level,
              timestamp: bar.time,
              timeframe,
              confidence: clamp(0.55 + (atr > 0 ? 0.15 : 0), 0, 0.9),
              detail: `Harga kembali menguji ${fmt(brk.level)} dan bertahan di atasnya`,
            });
          }
        } else {
          if (bar.close > brk.level && age <= opts.failedBreakoutBars) {
            brk.failed = true;
            events.push({
              type: 'FAILED_BREAKOUT',
              direction: 'BULLISH',
              price: brk.level,
              timestamp: bar.time,
              timeframe,
              confidence: clamp(0.5 + relVol * 0.2, 0, 0.95),
              detail: `Close kembali di atas ${fmt(brk.level)} hanya ${age} bar setelah jebol - breakdown gagal`,
            });
            continue;
          }
          if (!brk.retested && bar.high >= brk.level - tolerance && bar.close <= brk.level) {
            brk.retested = true;
            events.push({
              type: 'RETEST',
              direction: 'BEARISH',
              price: brk.level,
              timestamp: bar.time,
              timeframe,
              confidence: clamp(0.55 + (atr > 0 ? 0.15 : 0), 0, 0.9),
              detail: `Harga kembali menguji ${fmt(brk.level)} dan tertahan di bawahnya`,
            });
          }
        }
      }

      // Buang break yang sudah terlalu tua agar daftar tidak tumbuh tanpa batas.
      for (let k = pendingBreaks.length - 1; k >= 0; k--) {
        if (i - pendingBreaks[k].brokenAtIndex > opts.rangeLookback * 2) {
          pendingBreaks.splice(k, 1);
        }
      }
    }

    const trimmed = events.slice(-opts.maxEvents);
    const latest: Partial<Record<StructureEventType, StructureEvent>> = {};
    for (const e of trimmed) latest[e.type] = e;

    const lastBar = candles[candles.length - 1];
    const finalHighs = known.filter((s) => s.type === 'HIGH');
    const finalLows = known.filter((s) => s.type === 'LOW');

    return {
      timeframe,
      barTime: lastBar.time,
      trend,
      swings: known.slice(-20),
      lastSwingHigh: finalHighs.length ? finalHighs[finalHighs.length - 1] : null,
      lastSwingLow: finalLows.length ? finalLows[finalLows.length - 1] : null,
      events: trimmed,
      latest,
      onLastBar: trimmed.filter((e) => e.timestamp === lastBar.time),
    };
  }

  // --- Skor keyakinan ------------------------------------------------------

  /**
   * Keyakinan sebuah penembusan.
   *
   * Tiga bahan, semuanya bisa diverifikasi dari data:
   *  - seberapa jauh close melewati level, diukur dalam ATR (tembusan sejauh
   *    0,05 ATR praktis tidak berbeda dari kebisingan);
   *  - volume relatif terhadap rata-rata (partisipasi);
   *  - berapa banyak struktur yang sudah terbentuk (konteks).
   *
   * Sengaja dibatasi maksimum 0,95: tidak ada penembusan yang pasti.
   */
  private breakConfidence(distance: number, atr: number, relVol: number, context: number): number {
    const atrScore = atr > 0 ? clamp(distance / (atr * 0.5), 0, 1) : 0.4;
    const volScore = clamp((relVol - 0.8) / 1.2, 0, 1);
    const contextScore = clamp(context / 6, 0, 1);
    const raw = atrScore * 0.5 + volScore * 0.3 + contextScore * 0.2;
    return Number(clamp(0.35 + raw * 0.6, 0, 0.95).toFixed(3));
  }

  /** Sapuan makin meyakinkan bila wick-nya panjang dan volumenya besar. */
  private sweepConfidence(wickDistance: number, atr: number, relVol: number): number {
    const atrScore = atr > 0 ? clamp(wickDistance / (atr * 0.4), 0, 1) : 0.4;
    const volScore = clamp((relVol - 0.8) / 1.2, 0, 1);
    return Number(clamp(0.4 + (atrScore * 0.65 + volScore * 0.35) * 0.5, 0, 0.9).toFixed(3));
  }
}

/** Format ringkas untuk teks penjelasan (bukan untuk perhitungan). */
function fmt(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString('id-ID');
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(8).replace(/0+$/, '');
}
