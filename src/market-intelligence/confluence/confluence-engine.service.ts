import { Injectable } from '@nestjs/common';
import { clamp } from '../../common/num';
import {
  Direction,
  Reason,
  TradeDirection,
  decisionForScore,
} from '../market-intelligence.types';
import { MtfContext, TimeframeAnalysis } from '../mtf/mtf.types';
import { SupportResistanceZone } from '../levels/support-resistance.types';
import {
  ConfluenceDimension,
  ConfluenceOptions,
  ConfluenceResult,
  ConfluenceWeights,
  DEFAULT_NO_TRADE,
  DEFAULT_WEIGHTS,
  DimensionScore,
  NoTradeThresholds,
  TradeSetup,
} from './confluence.types';

/** Nilai netral untuk dimensi yang tidak dapat dinilai. */
const NEUTRAL = 50;

/**
 * Confluence Score Engine + No Trade Engine.
 *
 * Menggabungkan seluruh lapisan analisis menjadi satu angka 0-100 beserta
 * keputusan NO_TRADE / WATCH / TRADE_SETUP / HIGH_QUALITY_SETUP.
 *
 * Tiga hal yang perlu dipahami sebelum membaca kodenya:
 *
 *  1. SKOR BUKAN PROBABILITAS PROFIT. Ia adalah nilai kualitas menurut aturan
 *     yang ditulis di sini. Apakah skor tinggi benar-benar lebih menguntungkan
 *     HARUS dibuktikan dengan data (lihat evaluasi per bucket skor di
 *     walk-forward) - jangan pernah diasumsikan.
 *
 *  2. BLOCKER MENGALAHKAN SKOR. Setup dengan skor 88 yang resistance-nya hanya
 *     0,5% di atas entry tetap NO_TRADE. Skor tinggi tidak membeli izin untuk
 *     mengabaikan risiko yang jelas terlihat.
 *
 *  3. DIMENSI YANG TIDAK TERSEDIA TIDAK DIHITUNG NOL. Order book tidak ada
 *     saat backtest; menilainya nol akan membuat setiap backtest kehilangan 5
 *     poin dan hasilnya tidak sebanding dengan mode live. Bobotnya
 *     didistribusikan ulang ke dimensi yang bisa dinilai.
 */
@Injectable()
export class ConfluenceEngineService {
  evaluate(
    mtf: MtfContext,
    direction: TradeDirection,
    options: ConfluenceOptions = {},
  ): ConfluenceResult {
    const weights: ConfluenceWeights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
    const noTrade: NoTradeThresholds = { ...DEFAULT_NO_TRADE, ...(options.noTrade ?? {}) };

    const primary = mtf.timeframes[mtf.primaryTimeframe];
    const reasons: Reason[] = [];
    const blockers: string[] = [];
    const riskFactors: string[] = [];

    if (!primary) {
      return this.emptyResult(mtf, direction, weights, [
        'Tidak ada timeframe dengan data yang memadai untuk dianalisis',
      ]);
    }

    const setup = this.buildSetup(mtf, primary, direction, options);

    const dimensions: DimensionScore[] = [
      this.scoreTrendAlignment(mtf, direction, weights, reasons, riskFactors),
      this.scoreStructure(mtf, primary, direction, weights, reasons, riskFactors),
      this.scoreMomentum(primary, direction, weights, reasons, riskFactors),
      this.scoreVolume(primary, weights, reasons, riskFactors),
      this.scoreSupportResistance(primary, direction, weights, reasons, riskFactors),
      this.scoreVolatility(primary, options, weights, reasons, riskFactors),
      this.scoreOrderBook(options, direction, weights, reasons, riskFactors),
      this.scoreRiskReward(setup, noTrade, weights, reasons, riskFactors),
    ];

    const score = this.combine(dimensions);

    // -- No Trade Engine ---------------------------------------------------
    blockers.push(
      ...this.findBlockers(mtf, primary, direction, setup, noTrade, options.roundTripCostPercent),
    );

    const decision = blockers.length ? 'NO_TRADE' : decisionForScore(score);

    const breakdown = {} as Record<ConfluenceDimension, number>;
    for (const d of dimensions) breakdown[d.dimension] = Number(d.raw.toFixed(1));

    return {
      pair: mtf.pair,
      timeframe: mtf.primaryTimeframe,
      direction,
      score,
      decision,
      regime: primary.regime.regime,
      dimensions,
      breakdown,
      setup,
      reasons,
      blockers,
      riskFactors,
      // Bursa spot: hanya arah LONG yang bisa dieksekusi bot ini.
      executable: direction === 'LONG',
    };
  }

  // --- Penggabungan skor ---------------------------------------------------

  /**
   * Gabungkan dimensi menjadi satu skor 0-100.
   *
   * Bobot dimensi yang tidak tersedia dibagikan ulang secara proporsional ke
   * dimensi lain, sehingga skor tetap berada pada skala yang sama entah order
   * book tersedia atau tidak.
   */
  private combine(dimensions: DimensionScore[]): number {
    const usable = dimensions.filter((d) => !d.unavailable);
    const usableWeight = usable.reduce((s, d) => s + d.weight, 0);
    if (usableWeight <= 0) return 0;

    let total = 0;
    for (const d of dimensions) {
      if (d.unavailable) {
        d.contribution = 0;
        continue;
      }
      const normalized = (d.weight / usableWeight) * 100;
      d.contribution = Number(((d.raw * normalized) / 100).toFixed(2));
      total += d.contribution;
    }
    return Math.round(clamp(total, 0, 100));
  }

  // --- Dimensi 1: keselarasan tren (25%) -----------------------------------

  private scoreTrendAlignment(
    mtf: MtfContext,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const notes: string[] = [];
    const wanted: Direction = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    const sign = direction === 'LONG' ? 1 : -1;

    // alignment.score berada di -1..+1; diproyeksikan ke 0..100 searah trade.
    const raw = clamp(((mtf.alignment.score * sign + 1) / 2) * 100, 0, 100);

    for (const tf of mtf.alignment.aligned) {
      const a = mtf.timeframes[tf]!;
      if (a.bias === wanted) {
        reasons.push({
          dimension: 'TREND',
          kind: 'POSITIVE',
          text: `${tf} (${a.role}) ${a.bias.toLowerCase()} - searah setup`,
        });
      }
    }

    for (const conflict of mtf.alignment.conflicts) {
      notes.push(conflict);
      riskFactors.push(conflict);
      reasons.push({ dimension: 'TREND', kind: 'RISK', text: conflict });
    }

    if (mtf.missing.length) {
      notes.push(`Timeframe tanpa data: ${mtf.missing.join(', ')}`);
    }

    return this.dim('TREND_ALIGNMENT', raw, weights, false, notes);
  }

  // --- Dimensi 2: struktur pasar (20%) -------------------------------------

  private scoreStructure(
    mtf: MtfContext,
    primary: TimeframeAnalysis,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const notes: string[] = [];
    const structure = primary.structure;
    if (!structure) {
      return this.dim('MARKET_STRUCTURE', NEUTRAL, weights, true, ['Struktur tidak dapat dihitung']);
    }

    const wanted: Direction = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    const opposite: Direction = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
    let raw = NEUTRAL;

    if (structure.trend === wanted) {
      raw += 20;
      reasons.push({
        dimension: 'STRUCTURE',
        kind: 'POSITIVE',
        text: `Struktur ${primary.timeframe} ${structure.trend.toLowerCase()}`,
      });
    } else if (structure.trend === opposite) {
      raw -= 25;
      riskFactors.push(`Struktur ${primary.timeframe} berlawanan arah (${structure.trend})`);
    }

    // Event terbaru: BOS/CHOCH searah menambah, yang berlawanan mengurangi.
    const bos = structure.latest.BOS ?? structure.latest.CHOCH;
    if (bos) {
      const contribution = Math.round(bos.confidence * 25);
      if (bos.direction === wanted) {
        raw += contribution;
        reasons.push({
          dimension: 'STRUCTURE',
          kind: 'POSITIVE',
          text: `${bos.type} ${bos.direction.toLowerCase()} terkonfirmasi (keyakinan ${(bos.confidence * 100).toFixed(0)}%)`,
        });
      } else {
        raw -= contribution;
        riskFactors.push(`${bos.type} berlawanan arah pada ${primary.timeframe}`);
      }
    }

    const retest = structure.latest.RETEST;
    if (retest && retest.direction === wanted) {
      raw += 10;
      reasons.push({
        dimension: 'STRUCTURE',
        kind: 'POSITIVE',
        text: `Harga menguji ulang zona ${retest.price.toFixed(0)} dan bertahan`,
      });
    }

    const failed = structure.latest.FAILED_BREAKOUT;
    if (failed && failed.direction === opposite) {
      raw -= 20;
      riskFactors.push('Breakout terakhir gagal - struktur belum meyakinkan');
      reasons.push({
        dimension: 'STRUCTURE',
        kind: 'RISK',
        text: 'Breakout sebelumnya gagal dan harga kembali ke dalam rentang',
      });
    }

    const sweep = structure.onLastBar.find((e) => e.type === 'LIQUIDITY_SWEEP');
    if (sweep) {
      if (sweep.direction === wanted) {
        raw += 8;
        reasons.push({
          dimension: 'STRUCTURE',
          kind: 'POSITIVE',
          text: 'Likuiditas di sisi berlawanan baru saja disapu',
        });
      } else {
        raw -= 12;
        riskFactors.push('Sumbu candle terakhir menyapu likuiditas searah posisi - rawan pembalikan');
      }
    }

    return this.dim('MARKET_STRUCTURE', clamp(raw, 0, 100), weights, false, notes);
  }

  // --- Dimensi 3: momentum (15%) -------------------------------------------

  private scoreMomentum(
    primary: TimeframeAnalysis,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const m = primary.indicators.momentum;
    const notes: string[] = [];
    let raw = NEUTRAL;
    let measured = 0;

    if (m.rsi14 !== null) {
      measured++;
      if (direction === 'LONG') {
        if (m.rsi14 >= 50 && m.rsi14 <= 70) {
          raw += 15;
          reasons.push({ dimension: 'MOMENTUM', kind: 'POSITIVE', text: `RSI ${m.rsi14.toFixed(0)} sehat` });
        } else if (m.rsi14 > 75) {
          raw -= 15;
          riskFactors.push(`RSI ${m.rsi14.toFixed(0)} overbought - risiko entry terlambat`);
        } else if (m.rsi14 < 40) {
          raw -= 10;
          notes.push(`RSI ${m.rsi14.toFixed(0)} lemah untuk arah naik`);
        }
      } else {
        if (m.rsi14 <= 50 && m.rsi14 >= 30) raw += 15;
        else if (m.rsi14 < 25) raw -= 15;
        else if (m.rsi14 > 60) raw -= 10;
      }
    }

    if (m.macd.histogram !== null && m.macdHistogramPrev !== null) {
      measured++;
      const rising = m.macd.histogram > m.macdHistogramPrev;
      const positive = m.macd.histogram > 0;
      const favourable = direction === 'LONG' ? positive : !positive;
      const strengthening = direction === 'LONG' ? rising : !rising;

      if (favourable && strengthening) {
        raw += 20;
        reasons.push({ dimension: 'MOMENTUM', kind: 'POSITIVE', text: 'Histogram MACD searah dan menguat' });
      } else if (favourable) {
        raw += 8;
      } else if (strengthening) {
        raw -= 5;
      } else {
        raw -= 15;
        riskFactors.push('Momentum MACD berlawanan arah dan melemah');
      }
    }

    if (m.stochastic.k !== null && m.stochastic.d !== null) {
      measured++;
      const k = m.stochastic.k;
      if (direction === 'LONG') {
        if (k > 80) {
          raw -= 10;
          riskFactors.push(`Stochastic ${k.toFixed(0)} sudah jenuh beli`);
        } else if (k > m.stochastic.d && k < 80) {
          raw += 10;
          reasons.push({ dimension: 'MOMENTUM', kind: 'POSITIVE', text: 'Stochastic menyilang naik' });
        }
      } else {
        if (k < 20) raw -= 10;
        else if (k < m.stochastic.d && k > 20) raw += 10;
      }
    }

    if (m.adx !== null) {
      measured++;
      if (m.adx >= 25) {
        raw += 10;
        reasons.push({ dimension: 'MOMENTUM', kind: 'POSITIVE', text: `ADX ${m.adx.toFixed(0)} - tren punya tenaga` });
      } else if (m.adx < 15) {
        raw -= 10;
        riskFactors.push(`ADX ${m.adx.toFixed(0)} sangat rendah - pasar tanpa tenaga`);
      }
    }

    if (measured === 0) {
      return this.dim('MOMENTUM', NEUTRAL, weights, true, ['Indikator momentum belum bisa dihitung']);
    }

    return this.dim('MOMENTUM', clamp(raw, 0, 100), weights, false, notes);
  }

  // --- Dimensi 4: volume (15%) ---------------------------------------------

  private scoreVolume(
    primary: TimeframeAnalysis,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const v = primary.indicators.volume;
    if (v.relativeVolume === null) {
      return this.dim('VOLUME', NEUTRAL, weights, true, ['Volume rata-rata belum bisa dihitung']);
    }

    let raw = NEUTRAL;
    const rel = v.relativeVolume;

    if (rel >= 2) {
      raw += 30;
      reasons.push({ dimension: 'VOLUME', kind: 'POSITIVE', text: `Lonjakan volume ${(rel * 100).toFixed(0)}% dari rata-rata` });
    } else if (rel >= 1.3) {
      raw += 20;
      reasons.push({ dimension: 'VOLUME', kind: 'POSITIVE', text: `Volume di atas rata-rata (${(rel * 100).toFixed(0)}%)` });
    } else if (rel >= 0.8) {
      raw += 5;
    } else {
      raw -= 20;
      riskFactors.push(`Volume hanya ${(rel * 100).toFixed(0)}% dari rata-rata - konfirmasi lemah`);
    }

    if (v.state === 'EXPANDING') {
      raw += 15;
      reasons.push({ dimension: 'VOLUME', kind: 'POSITIVE', text: 'Partisipasi pasar sedang melebar' });
    } else if (v.state === 'CONTRACTING') {
      raw -= 10;
      riskFactors.push('Volume sedang menyusut - minat pasar berkurang');
    }

    return this.dim('VOLUME', clamp(raw, 0, 100), weights, false, []);
  }

  // --- Dimensi 5: support / resistance (10%) -------------------------------

  private scoreSupportResistance(
    primary: TimeframeAnalysis,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const levels = primary.levels;
    if (!levels) {
      return this.dim('SUPPORT_RESISTANCE', NEUTRAL, weights, true, ['Zona belum bisa dihitung']);
    }

    let raw = NEUTRAL;
    const notes: string[] = [];

    const ahead = direction === 'LONG' ? levels.nearestResistance : levels.nearestSupport;
    const behind = direction === 'LONG' ? levels.nearestSupport : levels.nearestResistance;

    if (ahead) {
      const room = Math.abs(ahead.distancePercent);
      if (room >= 3) {
        raw += 25;
        reasons.push({
          dimension: 'SUPPORT_RESISTANCE',
          kind: 'POSITIVE',
          text: `Ruang ${room.toFixed(1)}% sebelum ${ahead.type.toLowerCase().replace('_', ' ')}`,
        });
      } else if (room >= 1.5) {
        raw += 10;
      } else {
        raw -= 25;
        riskFactors.push(
          `${ahead.type.replace('_', ' ')} hanya ${room.toFixed(1)}% dari harga - ruang gerak sempit`,
        );
      }
    } else {
      notes.push('Tidak ada zona di depan harga - ruang terbuka');
      raw += 10;
    }

    if (behind) {
      const distance = Math.abs(behind.distancePercent);
      if (distance <= 2 && behind.strength >= 50) {
        raw += 20;
        reasons.push({
          dimension: 'SUPPORT_RESISTANCE',
          kind: 'POSITIVE',
          text: `${behind.type.replace('_', ' ')} kuat ${distance.toFixed(1)}% di belakang harga`,
        });
      } else if (distance > 6) {
        raw -= 15;
        riskFactors.push(`Perlindungan terdekat ${distance.toFixed(1)}% jauhnya - stop terpaksa lebar`);
      }
    }

    if (levels.positionInRange !== null) {
      if (levels.positionInRange > 0.4 && levels.positionInRange < 0.6) {
        raw -= 15;
        riskFactors.push('Harga berada di tengah rentang - lokasi entry terburuk');
      }
    }

    return this.dim('SUPPORT_RESISTANCE', clamp(raw, 0, 100), weights, false, notes);
  }

  // --- Dimensi 6: volatilitas (5%) -----------------------------------------

  /**
   * Volatilitas dinilai RELATIF TERHADAP BIAYA, bukan terhadap ambang absolut.
   *
   * Versi sebelumnya memakai pita ATR tetap: 0,8-3% dianggap baik, di bawah
   * 0,5% dihukum, di atas 5% dihukum. Pita itu tidak pernah menanyakan hal
   * yang sesungguhnya menentukan: APAKAH GERAKAN KHAS PAIR INI SANGGUP
   * MENUTUP BIAYANYA?
   *
   * Diukur pada 2026-10-15 dengan spread nyata:
   *
   *   ZEREBRO  ATR 7,12%  biaya 0,76%  -> 0,11x   6 menit menutup biaya
   *   ARC      ATR 6,99%  biaya 0,95%  -> 0,14x   8 menit
   *   HYPE     ATR 1,07%  biaya 0,43%  -> 0,41x  24 menit
   *   BTC      ATR 0,53%  biaya 0,40%  -> 0,76x  46 menit
   *   XAUT     ATR 0,32%  biaya 0,40%  -> 1,25x  75 menit
   *   PAXG     ATR 0,53%  biaya 1,04%  -> 1,94x 116 menit
   *
   * Pita lama memberi BTC nilai tertinggi dan menghukum ZEREBRO - padahal
   * secara ekonomi urutannya justru terbalik. Rasio di atas 1,0 berarti
   * gerakan satu bar penuh belum menutup biayanya: mustahil secara
   * aritmetika, berapa pun bagusnya polanya.
   *
   * ATR ekstrem TIDAK dihukum di sini. Ia memang masalah, tetapi masalah
   * UKURAN POSISI - dan sudah ditangani `maxAtrPercent` sebagai penolak tegas
   * serta risk engine lewat batas jarak stop. Menghukumnya dua kali membuat
   * dimensi ini menilai hal yang sama dengan gerbang di atasnya.
   */
  private scoreVolatility(
    primary: TimeframeAnalysis,
    options: ConfluenceOptions,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const vol = primary.indicators.volatility;
    if (vol.atrPercent === null) {
      return this.dim('VOLATILITY', NEUTRAL, weights, true, ['ATR belum bisa dihitung']);
    }

    let raw = NEUTRAL;
    const cost = options.roundTripCostPercent;

    if (cost !== undefined && cost > 0 && vol.atrPercent > 0) {
      const ratio = cost / vol.atrPercent;
      const menit = Math.round(ratio * 60);

      if (ratio <= 0.25) {
        raw += 30;
        reasons.push({
          dimension: 'VOLATILITY',
          kind: 'POSITIVE',
          text:
            `Biaya hanya ${(ratio * 100).toFixed(0)}% dari gerakan satu jam ` +
            `(~${menit} menit untuk menutupnya)`,
        });
      } else if (ratio <= 0.5) {
        raw += 15;
        reasons.push({
          dimension: 'VOLATILITY',
          kind: 'POSITIVE',
          text: `Biaya ${(ratio * 100).toFixed(0)}% dari gerakan satu jam (~${menit} menit)`,
        });
      } else if (ratio <= 1) {
        raw -= 20;
        riskFactors.push(
          `Biaya ${(ratio * 100).toFixed(0)}% dari gerakan satu jam - butuh ~${menit} menit ` +
            'hanya untuk kembali ke titik nol',
        );
      } else {
        raw -= 35;
        riskFactors.push(
          `Gerakan satu jam TIDAK menutup biaya (rasio ${ratio.toFixed(2)}x, ~${menit} menit)`,
        );
      }
    } else {
      // Tanpa data biaya (backtest: tidak ada spread historis), kembali ke
      // pita ATR absolut. Lebih baik satu dimensi kurang tajam daripada
      // memakai biaya yang dikarang.
      if (vol.atrPercent >= 0.8 && vol.atrPercent <= 3) {
        raw += 30;
        reasons.push({ dimension: 'VOLATILITY', kind: 'POSITIVE', text: `ATR ${vol.atrPercent.toFixed(2)}% - volatilitas normal` });
      } else if (vol.atrPercent < 0.5) {
        raw -= 20;
        riskFactors.push(`ATR hanya ${vol.atrPercent.toFixed(2)}% - ruang profit terlalu sempit`);
      }
    }

    if (vol.squeeze) {
      raw += 10;
      reasons.push({ dimension: 'VOLATILITY', kind: 'POSITIVE', text: 'Bollinger squeeze - ekspansi sering menyusul' });
    }

    if (vol.atrRatio !== null && vol.atrRatio > 2) {
      raw -= 15;
      riskFactors.push(`ATR ${vol.atrRatio.toFixed(1)}x lebih tinggi dari normal`);
    }

    return this.dim('VOLATILITY', clamp(raw, 0, 100), weights, false, []);
  }

  // --- Dimensi 7: order book (5%) ------------------------------------------

  /**
   * Order book HANYA konfirmasi.
   *
   * Dinding bid besar tidak dianggap bukti kuat: spoofing - memasang order
   * besar lalu menariknya sebelum tersentuh - adalah praktik umum. Karena itu
   * sumbangan maksimum dimensi ini sengaja kecil dan bobotnya hanya 5%.
   */
  private scoreOrderBook(
    options: ConfluenceOptions,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    const ob = options.orderBook;
    if (!ob) {
      return this.dim('ORDER_BOOK', NEUTRAL, weights, true, [
        'Order book tidak tersedia (normal saat backtest - tidak ada data historis)',
      ]);
    }

    let raw = NEUTRAL;
    const favourable = direction === 'LONG' ? ob.imbalance : -ob.imbalance;

    if (favourable > 0.25) {
      raw += 25;
      reasons.push({
        dimension: 'ORDER_BOOK',
        kind: 'POSITIVE',
        text: `Buku order condong searah (${(ob.imbalance * 100).toFixed(0)}%) - konfirmasi, bukan sinyal utama`,
      });
    } else if (favourable > 0.1) {
      raw += 10;
    } else if (favourable < -0.25) {
      raw -= 25;
      riskFactors.push(`Buku order condong berlawanan (${(ob.imbalance * 100).toFixed(0)}%)`);
    }

    if (ob.spreadPercent > 0.6) {
      raw -= 20;
      riskFactors.push(`Spread ${ob.spreadPercent.toFixed(2)}% lebar - biaya masuk-keluar membengkak`);
    } else if (ob.spreadPercent < 0.15) {
      raw += 10;
    }

    return this.dim('ORDER_BOOK', clamp(raw, 0, 100), weights, false, []);
  }

  // --- Dimensi 8: risk / reward (5%) ---------------------------------------

  private scoreRiskReward(
    setup: TradeSetup | null,
    noTrade: NoTradeThresholds,
    weights: ConfluenceWeights,
    reasons: Reason[],
    riskFactors: string[],
  ): DimensionScore {
    if (!setup || !(setup.riskPerUnit > 0)) {
      return this.dim('RISK_REWARD', NEUTRAL, weights, true, ['Setup tidak dapat dihitung']);
    }

    const rr = setup.riskReward;
    let raw: number;

    if (rr >= 3) raw = 100;
    else if (rr >= 2) raw = 80;
    else if (rr >= noTrade.minRiskReward) raw = 60;
    else if (rr >= 1) raw = 35;
    else raw = 10;

    if (rr >= noTrade.minRiskReward) {
      reasons.push({ dimension: 'RISK_REWARD', kind: 'POSITIVE', text: `Rasio imbalan/risiko 1:${rr.toFixed(1)}` });
    } else {
      riskFactors.push(`Rasio imbalan/risiko hanya 1:${rr.toFixed(1)} - di bawah minimum ${noTrade.minRiskReward}`);
    }

    return this.dim('RISK_REWARD', raw, weights, false, []);
  }

  // --- No Trade Engine -----------------------------------------------------

  /**
   * Kondisi yang menolak trade apa pun skornya (bagian 8 spesifikasi).
   *
   * Dipisahkan dari skor dengan sengaja. Skor adalah penilaian bertingkat;
   * blocker adalah garis yang tidak boleh dilewati. Mencampur keduanya
   * membuat risiko besar bisa "dibayar" oleh dimensi lain yang kebetulan bagus.
   */
  private findBlockers(
    mtf: MtfContext,
    primary: TimeframeAnalysis,
    direction: TradeDirection,
    setup: TradeSetup | null,
    t: NoTradeThresholds,
    roundTripCostPercent?: number,
  ): string[] {
    const blockers: string[] = [];

    if (direction === 'NONE') {
      blockers.push('Tidak ada arah yang jelas');
      return blockers;
    }

    // 1. Konflik antar timeframe.
    if (mtf.alignment.conflicts.length > t.maxTimeframeConflicts) {
      blockers.push(
        `Timeframe saling bertentangan: ${mtf.alignment.conflicts.slice(0, 2).join('; ')}`,
      );
    }

    // 2. Arah setup melawan keselarasan timeframe.
    const wanted: Direction = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    if (mtf.alignment.direction !== 'NEUTRAL' && mtf.alignment.direction !== wanted) {
      blockers.push(
        `Arah ${direction} melawan keselarasan timeframe yang ${mtf.alignment.direction}`,
      );
    }

    // 3. Volume terlalu sepi.
    const rel = primary.indicators.volume.relativeVolume;
    if (rel !== null && rel < t.minRelativeVolume) {
      blockers.push(`Volume hanya ${(rel * 100).toFixed(0)}% dari rata-rata - tidak ada partisipasi`);
    }

    // 4. Volatilitas ekstrem.
    const atrPercent = primary.indicators.volatility.atrPercent;
    if (atrPercent !== null && atrPercent > t.maxAtrPercent) {
      blockers.push(`Volatilitas ekstrem: ATR ${atrPercent.toFixed(1)}% > batas ${t.maxAtrPercent}%`);
    }

    /**
     * 4b. Biaya tidak tertutup oleh gerakan khas pair ini.
     *
     * Penolak yang paling tidak terlihat sebelumnya, dan paling mahal. Pair
     * yang tenang DAN mahal lolos setiap pemeriksaan lain: volumenya besar,
     * spreadnya di bawah batas, polanya bisa rapi. Yang tidak pernah
     * ditanyakan adalah apakah gerakannya SANGGUP membayar biaya masuk-keluar.
     *
     * Diukur: PAXG butuh 116 menit gerakan normal hanya untuk kembali ke titik
     * nol, XAUT 75 menit. Strategi yang keluar dalam satu bar 60 menit kalah
     * secara aritmetika di pair itu - berapa kali pun dicoba, dan sebagus apa
     * pun analisanya.
     */
    if (
      roundTripCostPercent !== undefined &&
      roundTripCostPercent > 0 &&
      atrPercent !== null &&
      atrPercent > 0
    ) {
      const ratio = roundTripCostPercent / atrPercent;
      if (ratio > t.maxCostToAtrRatio) {
        blockers.push(
          `Biaya masuk-keluar ${roundTripCostPercent.toFixed(2)}% melebihi gerakan khas ` +
            `${atrPercent.toFixed(2)}%/bar (rasio ${ratio.toFixed(2)}x, batas ` +
            `${t.maxCostToAtrRatio}x) - butuh ~${Math.round(ratio * 60)} menit hanya untuk ` +
            'kembali ke titik nol',
        );
      }
    }

    // 5. Rasio imbalan/risiko.
    if (setup && setup.riskReward < t.minRiskReward) {
      blockers.push(
        `Rasio imbalan/risiko 1:${setup.riskReward.toFixed(1)} di bawah minimum 1:${t.minRiskReward}`,
      );
    }

    // 6. Harga di tengah rentang.
    const pos = primary.levels?.positionInRange;
    if (pos !== null && pos !== undefined && pos > t.midRangeLow && pos < t.midRangeHigh) {
      blockers.push(
        `Harga di tengah rentang (${(pos * 100).toFixed(0)}%) - ruang naik dan turun sama-sama terbatas`,
      );
    }

    // 7. Zona di depan terlalu dekat.
    const ahead = direction === 'LONG' ? primary.levels?.nearestResistance : primary.levels?.nearestSupport;
    if (ahead) {
      const room = Math.abs(ahead.distancePercent);
      if (room < t.minResistanceDistancePercent) {
        blockers.push(
          `${ahead.type.replace('_', ' ')} hanya ${room.toFixed(2)}% dari entry (minimum ${t.minResistanceDistancePercent}%)`,
        );
      }
    }

    // 8. Perlindungan terlalu jauh.
    const behind = direction === 'LONG' ? primary.levels?.nearestSupport : primary.levels?.nearestResistance;
    if (behind) {
      const distance = Math.abs(behind.distancePercent);
      if (distance > t.maxSupportDistancePercent) {
        blockers.push(
          `${behind.type.replace('_', ' ')} terdekat ${distance.toFixed(1)}% jauhnya - stop terlalu lebar`,
        );
      }
    }

    // 9. Breakout belum terkonfirmasi (hanya sumbu yang menembus).
    const sweepAgainst = primary.structure?.onLastBar.find(
      (e) => e.type === 'LIQUIDITY_SWEEP' && e.direction !== wanted,
    );
    if (sweepAgainst) {
      blockers.push(
        'Candle terakhir hanya menembus lewat sumbu lalu ditolak - breakout belum terkonfirmasi',
      );
    }

    return blockers;
  }

  // --- Trade Setup ---------------------------------------------------------

  /**
   * Setup analitis: entry, stop, dan tiga target.
   *
   * Ini USULAN, bukan perintah. Risk Engine yang sudah ada tetap menjadi
   * otoritas tunggal untuk ukuran posisi - tidak ada perhitungan sizing di
   * sini, dan memang tidak boleh ada (bagian 9 spesifikasi).
   */
  buildSetup(
    mtf: MtfContext,
    primary: TimeframeAnalysis,
    direction: TradeDirection,
    options: ConfluenceOptions,
  ): TradeSetup | null {
    if (direction === 'NONE') return null;

    const atr = primary.indicators.volatility.atr14;
    const atrPercent = primary.indicators.volatility.atrPercent ?? 0;
    const price = primary.indicators.price.close;
    if (!atr || atr <= 0 || !(price > 0)) return null;

    const atrStopMultiplier = options.atrStopMultiplier ?? 1.5;
    const [m1, m2, m3] = options.targetMultiples ?? [1.5, 2.5, 4];

    // Zona entry: sedikit di bawah harga untuk LONG (menunggu harga datang),
    // sedikit di atas untuk SHORT.
    const entryLow = direction === 'LONG' ? price - atr * 0.3 : price - atr * 0.1;
    const entryHigh = direction === 'LONG' ? price + atr * 0.1 : price + atr * 0.3;

    // Stop: yang lebih jauh antara jarak ATR dan struktur, supaya stop tidak
    // diletakkan tepat di titik yang paling mungkin tersapu.
    let stopLoss: number;
    let stopBasis: string;

    if (direction === 'LONG') {
      const atrStop = price - atr * atrStopMultiplier;
      const structural = this.structuralStop(primary, 'LONG');
      if (structural !== null && structural < price) {
        // Diberi bantalan 0,15 ATR di bawah level agar tidak tersentuh noise.
        const buffered = structural - atr * 0.15;
        stopLoss = Math.min(atrStop, buffered);
        stopBasis =
          stopLoss === buffered
            ? `Di bawah struktur ${structural.toFixed(0)} dengan bantalan 0,15 ATR`
            : `${atrStopMultiplier} x ATR di bawah harga`;
      } else {
        stopLoss = atrStop;
        stopBasis = `${atrStopMultiplier} x ATR di bawah harga`;
      }
    } else {
      const atrStop = price + atr * atrStopMultiplier;
      const structural = this.structuralStop(primary, 'SHORT');
      if (structural !== null && structural > price) {
        const buffered = structural + atr * 0.15;
        stopLoss = Math.max(atrStop, buffered);
        stopBasis =
          stopLoss === buffered
            ? `Di atas struktur ${structural.toFixed(0)} dengan bantalan 0,15 ATR`
            : `${atrStopMultiplier} x ATR di atas harga`;
      } else {
        stopLoss = atrStop;
        stopBasis = `${atrStopMultiplier} x ATR di atas harga`;
      }
    }

    const riskPerUnit = Math.abs(price - stopLoss);
    if (!(riskPerUnit > 0)) return null;

    const sign = direction === 'LONG' ? 1 : -1;
    let tp1 = price + sign * riskPerUnit * m1;
    let tp2 = price + sign * riskPerUnit * m2;
    const tp3 = price + sign * riskPerUnit * m3;
    let targetBasis = `Kelipatan risiko ${m1}R / ${m2}R / ${m3}R`;

    // Bila ada zona kuat di depan sebelum TP1, target dimundurkan ke sisi
    // dekat zona itu. Menaruh target DI BALIK resistance kuat berarti berharap
    // harga menembusnya - harapan bukan rencana.
    const ahead = direction === 'LONG' ? primary.levels?.nearestResistance : primary.levels?.nearestSupport;
    if (ahead && ahead.strength >= 60) {
      const barrier = direction === 'LONG' ? ahead.priceLow : ahead.priceHigh;
      const beyondTp1 = direction === 'LONG' ? barrier < tp1 : barrier > tp1;
      if (beyondTp1 && (direction === 'LONG' ? barrier > price : barrier < price)) {
        tp1 = barrier;
        targetBasis = `TP1 dimundurkan ke ${ahead.type.replace('_', ' ')} di ${barrier.toFixed(0)}`;
        if (direction === 'LONG' ? tp2 < tp1 : tp2 > tp1) tp2 = price + sign * riskPerUnit * m2;
      }
    }

    const rrOf = (target: number): number =>
      Number((Math.abs(target - price) / riskPerUnit).toFixed(2));

    return {
      direction,
      entryLow,
      entryHigh,
      entryReference: price,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3,
      riskPerUnit,
      riskReward: rrOf(tp2),
      riskRewardTp1: rrOf(tp1),
      riskRewardTp3: rrOf(tp3),
      atr,
      atrPercent,
      stopBasis,
      targetBasis,
    };
  }

  /** Level struktural untuk menempatkan stop: swing terakhir atau zona terdekat. */
  private structuralStop(primary: TimeframeAnalysis, direction: 'LONG' | 'SHORT'): number | null {
    const candidates: number[] = [];

    if (direction === 'LONG') {
      const swing = primary.structure?.lastSwingLow?.price;
      if (swing !== undefined) candidates.push(swing);
      const support: SupportResistanceZone | null | undefined = primary.levels?.nearestSupport;
      if (support) candidates.push(support.priceLow);
      return candidates.length ? Math.max(...candidates) : null;
    }

    const swing = primary.structure?.lastSwingHigh?.price;
    if (swing !== undefined) candidates.push(swing);
    const resistance: SupportResistanceZone | null | undefined = primary.levels?.nearestResistance;
    if (resistance) candidates.push(resistance.priceHigh);
    return candidates.length ? Math.min(...candidates) : null;
  }

  // --- Utilitas ------------------------------------------------------------

  private dim(
    dimension: ConfluenceDimension,
    raw: number,
    weights: ConfluenceWeights,
    unavailable: boolean,
    notes: string[],
  ): DimensionScore {
    return {
      dimension,
      raw: Number(raw.toFixed(1)),
      weight: weights[dimension],
      contribution: 0,
      unavailable,
      notes,
    };
  }

  private emptyResult(
    mtf: MtfContext,
    direction: TradeDirection,
    weights: ConfluenceWeights,
    blockers: string[],
  ): ConfluenceResult {
    const breakdown = {} as Record<ConfluenceDimension, number>;
    for (const key of Object.keys(weights) as ConfluenceDimension[]) breakdown[key] = 0;

    return {
      pair: mtf.pair,
      timeframe: mtf.primaryTimeframe,
      direction,
      score: 0,
      decision: 'NO_TRADE',
      regime: 'SIDEWAYS',
      dimensions: [],
      breakdown,
      setup: null,
      reasons: [],
      blockers,
      riskFactors: [],
      executable: false,
    };
  }
}
