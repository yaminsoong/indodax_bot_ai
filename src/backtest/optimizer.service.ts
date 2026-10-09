import { Injectable, Logger } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { BacktestConfig, BacktestReport, BacktestTrade, PerformanceSlice } from './backtest.types';
import { BotParams } from '../config/bot-config.service';
import { mean } from '../common/num';
import { SCORE_BUCKETS, slicePerformance } from './performance-slice';

export interface SweepSpec {
  /** Nama parameter di BotParams, mis. 'minAdx'. */
  param: keyof BotParams;
  values: number[];
}

export interface SweepResult {
  overrides: Record<string, number>;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number | null;
  expectancyR: number;
  /** Galat baku ekspektasi — makin besar, makin tidak bisa dipercaya. */
  expectancyStdErrorR: number;
  totalTrades: number;
  winRate: number;
  sharpeRatio: number;
  /** Batas bawah kepercayaan dikurangi hukuman drawdown — lihat scoreOf(). */
  score: number;
}

export interface SweepReport {
  base: BacktestConfig;
  tested: number;
  results: SweepResult[];
  best: SweepResult | null;
  /** Kesimpulan langsung: apakah ada kombinasi yang layak dipakai sama sekali. */
  verdict: string;
  warnings: string[];
}

/**
 * Evaluasi Market Intelligence pada data out-of-sample (bagian 15 spesifikasi).
 *
 * Seluruh angka di sini berasal dari periode yang TIDAK dipakai untuk mencari
 * parameter. Itulah satu-satunya bukti yang berarti: skor tinggi yang tampak
 * menguntungkan pada data optimasi hampir selalu hanya hasil pencocokan ke
 * kebisingan masa lalu.
 */
export interface IntelligenceEvaluation {
  enabled: boolean;
  strategy: string;
  timeframeMinutes: number;
  totalTrades: number;
  avgScore: number | null;
  acceptedSignals: number;
  rejectedSignals: number;
  /** Performa per bucket skor, digabung dari seluruh jendela out-of-sample. */
  byScoreBucket: PerformanceSlice[];
  byRegime: PerformanceSlice[];
  topRejections: Array<{ reason: string; count: number }>;
  /**
   * Apakah data mendukung anggapan "skor lebih tinggi = hasil lebih baik".
   * Dinyatakan apa adanya, termasuk saat jawabannya tidak.
   */
  verdict: string;
}

export interface WalkForwardReport {
  windows: Array<{
    window: number;
    inSampleReturn: number;
    inSampleTrades: number;
    outOfSampleReturn: number;
    outOfSampleTrades: number;
    outOfSampleMaxDd: number;
    bestParams: Record<string, number>;
  }>;
  /** Evaluasi Market Intelligence pada seluruh periode out-of-sample. */
  intelligence: IntelligenceEvaluation;
  /** Rata-rata return out-of-sample — inilah yang mendekati hasil nyata. */
  avgOutOfSampleReturn: number;
  avgInSampleReturn: number;
  /** Rasio OOS/IS; jauh di bawah 1 menandakan overfitting. */
  robustnessRatio: number | null;
  verdict: string;
  warnings: string[];
}

/**
 * Pencarian parameter dan validasi walk-forward.
 *
 * Sweep saja berbahaya: dengan cukup banyak kombinasi, selalu ada satu yang
 * terlihat hebat pada data historis semata-mata karena kebetulan. Walk-forward
 * menguji parameter terbaik pada data yang belum pernah dilihat, sehingga bisa
 * membedakan strategi yang benar-benar bekerja dari yang sekadar terpasang pas
 * ke masa lalu.
 */
@Injectable()
export class OptimizerService {
  private readonly logger = new Logger(OptimizerService.name);

  constructor(private readonly backtest: BacktestService) {}

  /**
   * Skor peringkat: batas bawah kepercayaan atas ekspektasi, dikurangi
   * hukuman drawdown.
   *
   * Memakai `expectancy − 1×galat baku` alih-alih ekspektasi mentah membuat
   * jumlah sampel ikut diperhitungkan secara berkesinambungan: hasil bagus dari
   * 8 trade otomatis dihukum karena ketidakpastiannya besar, tanpa perlu ambang
   * keras. Ambang keras justru berbahaya — versi pertama fungsi ini memberi
   * −1000 untuk sampel di bawah 10, sehingga hasil buruk bersampel 10 menang
   * atas hasil bagus bersampel 9.
   */
  private scoreOf(r: Omit<SweepResult, 'score'>): number {
    if (r.totalTrades === 0) return -Infinity;

    // Batas bawah satu sigma: seberapa buruk hasil ini bisa jadi sebenarnya.
    const lowerBound = r.expectancyR - r.expectancyStdErrorR;

    // Drawdown besar menurunkan nilai walau ekspektasinya positif.
    const ddPenalty = r.maxDrawdownPercent / 100;

    return lowerBound - ddPenalty;
  }

  // ─── Parameter sweep ──────────────────────────────────────────────────────

  async sweep(base: BacktestConfig, specs: SweepSpec[], maxRuns = 60): Promise<SweepReport> {
    const combos = this.cartesian(specs);
    const warnings: string[] = [];

    if (combos.length > maxRuns) {
      warnings.push(
        `${combos.length} kombinasi diminta, dibatasi menjadi ${maxRuns} untuk menjaga waktu proses. ` +
          `Kurangi jumlah nilai per parameter untuk cakupan yang lebih rapat.`,
      );
    }
    const toRun = combos.slice(0, maxRuns);

    if (toRun.length > 20) {
      warnings.push(
        `Menguji ${toRun.length} kombinasi pada data yang sama meningkatkan risiko overfitting. ` +
          `Selalu validasi pemenangnya dengan walk-forward sebelum dipakai.`,
      );
    }

    const results: SweepResult[] = [];

    for (const [i, overrides] of toRun.entries()) {
      try {
        const report = await this.backtest.run(
          { ...base, paramOverrides: overrides as Partial<BotParams> },
          false,
        );
        const m = report.metrics;
        const partial = {
          overrides: overrides as Record<string, number>,
          totalReturnPercent: m.totalReturnPercent,
          maxDrawdownPercent: m.maxDrawdownPercent,
          profitFactor: m.profitFactor,
          expectancyR: m.expectancyR,
          expectancyStdErrorR: m.expectancyStdErrorR,
          totalTrades: m.totalTrades,
          winRate: m.winRate,
          sharpeRatio: m.sharpeRatio,
        };
        results.push({ ...partial, score: this.scoreOf(partial) });

        this.logger.log(
          `Sweep ${i + 1}/${toRun.length} ${JSON.stringify(overrides)} → ` +
            `return ${m.totalReturnPercent.toFixed(2)}%, DD ${m.maxDrawdownPercent.toFixed(2)}%, ${m.totalTrades} trade`,
        );
      } catch (err) {
        this.logger.warn(`Kombinasi ${JSON.stringify(overrides)} gagal: ${err.message}`);
      }
    }

    results.sort((a, b) => b.score - a.score);

    const best = results[0] ?? null;
    if (best && best.totalTrades < 30) {
      warnings.push(
        `Kombinasi terbaik hanya menghasilkan ${best.totalTrades} trade — belum cukup untuk disimpulkan.`,
      );
    }

    const positive = results.filter((r) => r.expectancyR > 0);
    let verdict: string;
    if (!results.length) {
      verdict = 'Tidak ada kombinasi yang menghasilkan trade.';
    } else if (!positive.length) {
      verdict =
        'TIDAK ADA yang layak — seluruh kombinasi berekspektasi negatif. ' +
        'Menaikkan ukuran posisi tidak akan menolong: ekspektasi negatif berarti ' +
        'makin banyak trade, makin besar kerugian. Strateginya sendiri yang perlu diubah.';
    } else if (best && best.score <= 0) {
      verdict =
        `${positive.length} kombinasi berekspektasi positif, tetapi tidak satu pun ` +
        'bertahan setelah memperhitungkan ketidakpastian sampel dan drawdown. ' +
        'Perlu data lebih panjang sebelum bisa disimpulkan.';
    } else {
      verdict =
        `Kombinasi terbaik: ${JSON.stringify(best!.overrides)} — ekspektasi ` +
        `${best!.expectancyR}R (±${best!.expectancyStdErrorR}) dari ${best!.totalTrades} trade. ` +
        'WAJIB divalidasi dengan walk-forward sebelum dipakai.';
    }

    return { base, tested: results.length, results, best, verdict, warnings };
  }

  private cartesian(specs: SweepSpec[]): Array<Record<string, number>> {
    let combos: Array<Record<string, number>> = [{}];
    for (const spec of specs) {
      const next: Array<Record<string, number>> = [];
      for (const combo of combos) {
        for (const value of spec.values) {
          next.push({ ...combo, [spec.param as string]: value });
        }
      }
      combos = next;
    }
    return combos;
  }

  // ─── Walk-forward ─────────────────────────────────────────────────────────

  /**
   * Bagi data menjadi beberapa jendela. Pada tiap jendela, parameter terbaik
   * dicari pada bagian in-sample lalu diuji pada bagian out-of-sample yang
   * belum pernah dipakai.
   */
  async walkForward(
    base: BacktestConfig,
    specs: SweepSpec[],
    windows = 4,
    outOfSampleRatio = 0.3,
  ): Promise<WalkForwardReport> {
    const warnings: string[] = [];

    /**
     * Data dibagi menjadi `windows` segmen berurutan. Tiap segmen dipecah lagi
     * menjadi bagian in-sample (untuk mencari parameter) dan out-of-sample
     * (untuk mengujinya pada data yang belum pernah dilihat).
     *
     * Segmen dipilih lewat `barsOffsetFromEnd`, bukan dengan mengubah jumlah
     * bar. Versi pertama fungsi ini hanya memvariasikan `bars` — karena
     * pengambilan candle selalu mengembalikan N bar TERAKHIR, setiap jendela
     * berakhir menguji rentang yang sama persis dan menghasilkan angka identik.
     */
    const segmentBars = Math.floor(base.bars / windows);
    const oosBars = Math.max(60, Math.floor(segmentBars * outOfSampleRatio));
    const isBars = segmentBars - oosBars;
    // Bantalan agar indikator sudah "panas" di awal tiap jendela.
    const warmup = 60;

    if (isBars < 150) {
      warnings.push(
        `Bagian in-sample hanya ${isBars} candle per jendela — terlalu pendek untuk optimasi yang bermakna. ` +
          `Tambah jumlah bar atau kurangi jumlah jendela.`,
      );
    }

    const out: WalkForwardReport['windows'] = [];
    /** Seluruh trade out-of-sample, dikumpulkan untuk evaluasi Market Intelligence. */
    const oosTrades: BacktestTrade[] = [];
    const rejectionCounts = new Map<string, number>();
    let acceptedSignals = 0;
    let rejectedSignals = 0;
    let intelligenceEnabled = false;

    for (let w = 0; w < windows; w++) {
      // Jendela 0 adalah yang paling lama; jendela terakhir paling baru.
      const segmentsAfterThis = windows - 1 - w;

      // In-sample: bagian awal segmen. Yang dibuang = OOS segmen ini + seluruh segmen sesudahnya.
      const isOffset = oosBars + segmentsAfterThis * segmentBars;
      // Out-of-sample: bagian akhir segmen, tepat setelah in-sample berakhir.
      const oosOffset = segmentsAfterThis * segmentBars;

      const isConfig: BacktestConfig = {
        ...base,
        bars: isBars + warmup,
        barsOffsetFromEnd: isOffset,
      };
      const oosConfig: BacktestConfig = {
        ...base,
        bars: oosBars + warmup,
        barsOffsetFromEnd: oosOffset,
      };

      // 1. Cari parameter terbaik pada in-sample.
      const sweep = await this.sweep(isConfig, specs, 40);
      if (!sweep.best) {
        warnings.push(`Jendela ${w + 1}: tidak ada kombinasi valid pada bagian in-sample`);
        continue;
      }

      // 2. Uji parameter pemenang pada out-of-sample yang belum pernah dilihat.
      const oos = await this.backtest.run(
        { ...oosConfig, paramOverrides: sweep.best.overrides as Partial<BotParams> },
        false,
      );

      oosTrades.push(...oos.trades);
      intelligenceEnabled = intelligenceEnabled || oos.metrics.intelligence.enabled;
      acceptedSignals += oos.metrics.intelligence.accepted;
      rejectedSignals += oos.metrics.intelligence.rejected;
      for (const r of oos.metrics.intelligence.topRejections) {
        rejectionCounts.set(r.reason, (rejectionCounts.get(r.reason) ?? 0) + r.count);
      }

      out.push({
        window: w + 1,
        inSampleReturn: sweep.best.totalReturnPercent,
        inSampleTrades: sweep.best.totalTrades,
        outOfSampleReturn: oos.metrics.totalReturnPercent,
        outOfSampleTrades: oos.metrics.totalTrades,
        outOfSampleMaxDd: oos.metrics.maxDrawdownPercent,
        bestParams: sweep.best.overrides,
      });

      this.logger.log(
        `Walk-forward jendela ${w + 1}/${windows} (offset IS ${isOffset}, OOS ${oosOffset}): ` +
          `IS ${sweep.best.totalReturnPercent.toFixed(2)}% → ` +
          `OOS ${oos.metrics.totalReturnPercent.toFixed(2)}% (${oos.metrics.totalTrades} trade)`,
      );
    }

    // Jendela yang seragam sempurna menandakan pembagian data tidak bekerja.
    if (out.length > 1) {
      const identical = out.every(
        (x) => x.outOfSampleReturn === out[0].outOfSampleReturn && x.outOfSampleTrades === out[0].outOfSampleTrades,
      );
      if (identical) {
        warnings.push(
          'Semua jendela menghasilkan angka identik — data kemungkinan tidak terbagi dengan benar ' +
            '(riwayat candle mungkin lebih pendek daripada jumlah bar yang diminta).',
        );
      }
    }

    const avgOos = out.length ? out.reduce((s, x) => s + x.outOfSampleReturn, 0) / out.length : 0;
    const avgIs = out.length ? out.reduce((s, x) => s + x.inSampleReturn, 0) / out.length : 0;

    /**
     * Rasio ketahanan hanya bermakna bila in-sample POSITIF.
     *
     * Pembagian dengan in-sample negatif menghasilkan angka yang tampak
     * masuk akal tetapi artinya terbalik: OOS +0,11% dibagi IS −0,7% memberi
     * −0,15, yang lalu dibaca sebagai "hanya bertahan −15%" — padahal
     * out-of-sample justru LEBIH BAIK daripada in-sample. Dalam keadaan itu
     * rasionya dinyatakan null, dan kesimpulannya ditulis apa adanya.
     */
    const ratio = avgIs > 0 ? avgOos / avgIs : null;

    let verdict: string;
    if (!out.length) {
      verdict = 'Tidak cukup data untuk menyimpulkan.';
    } else if (avgOos <= 0) {
      verdict =
        'GAGAL — strategi merugi pada data yang belum pernah dilihat. Parameter yang bagus di masa lalu ' +
        'tidak bertahan ke depan; jangan dijalankan dengan uang sungguhan.';
    } else if (ratio === null) {
      // avgOos positif tetapi avgIs tidak — perbandingan rasio tidak berlaku.
      verdict =
        `TIDAK DAPAT DISIMPULKAN — optimasi in-sample sendiri berakhir ${avgIs.toFixed(2)}% ` +
        `(tidak positif), sehingga rasio ketahanan tidak punya arti. Out-of-sample ` +
        `${avgOos.toFixed(2)}% kemungkinan besar hanya kebetulan: tidak ada parameter yang ` +
        'terbukti bekerja bahkan pada data yang dipakai untuk mencarinya.';
    } else if (ratio < 0.3) {
      verdict =
        `LEMAH — hasil out-of-sample hanya ${(ratio * 100).toFixed(0)}% dari in-sample. ` +
        'Ini pola khas overfitting: parameternya terpasang ke kebisingan masa lalu.';
    } else if (ratio < 0.6) {
      verdict =
        `SEDANG — out-of-sample bertahan ${(ratio * 100).toFixed(0)}% dari in-sample. ` +
        'Ada sinyal nyata, tetapi harapkan hasil live jauh di bawah angka backtest.';
    } else {
      verdict =
        `BAIK — performa out-of-sample bertahan ${(ratio * 100).toFixed(0)}% dari in-sample. ` +
        'Mulailah tetap dengan mode simulasi dan risiko kecil.';
    }

    return {
      windows: out,
      intelligence: this.evaluateIntelligence(
        base,
        oosTrades,
        {
          enabled: intelligenceEnabled,
          accepted: acceptedSignals,
          rejected: rejectedSignals,
          rejections: rejectionCounts,
        },
        warnings,
      ),
      avgOutOfSampleReturn: Number(avgOos.toFixed(2)),
      avgInSampleReturn: Number(avgIs.toFixed(2)),
      robustnessRatio: ratio !== null ? Number(ratio.toFixed(3)) : null,
      verdict,
      warnings,
    };
  }

  // ─── Evaluasi Market Intelligence ─────────────────────────────────────────

  /**
   * Nilai apakah skor Market Intelligence benar-benar berkorelasi dengan hasil.
   *
   * Bagian 15 spesifikasi menyatakannya dengan tegas: jangan mengasumsikan skor
   * tinggi pasti lebih menguntungkan, buktikan dengan data. Fungsi ini menolak
   * memberi kesimpulan positif bila sampelnya terlalu kecil - dan pada sebagian
   * besar backtest berdurasi pendek, itulah yang akan terjadi.
   */
  private evaluateIntelligence(
    base: BacktestConfig,
    trades: BacktestTrade[],
    stats: {
      enabled: boolean;
      accepted: number;
      rejected: number;
      rejections: Map<string, number>;
    },
    warnings: string[],
  ): IntelligenceEvaluation {
    const scored = trades.filter(
      (t) => t.intelligenceScore !== null && t.intelligenceScore !== undefined,
    );

    const byScoreBucket = SCORE_BUCKETS
      .map(([label, min, max]) =>
        slicePerformance(
          label,
          scored.filter((t) => t.intelligenceScore! >= min && t.intelligenceScore! <= max),
        ),
      )
      .filter((s) => s.trades > 0);

    const regimes = [...new Set(trades.map((t) => t.marketRegime).filter(Boolean))] as string[];
    const byRegime = regimes
      .map((regime) => slicePerformance(regime, trades.filter((t) => t.marketRegime === regime)))
      .sort((a, b) => b.trades - a.trades);

    return {
      enabled: stats.enabled,
      strategy: base.strategy,
      timeframeMinutes: base.timeframe,
      totalTrades: trades.length,
      avgScore: scored.length
        ? Number(mean(scored.map((t) => t.intelligenceScore!)).toFixed(1))
        : null,
      acceptedSignals: stats.accepted,
      rejectedSignals: stats.rejected,
      byScoreBucket,
      byRegime,
      topRejections: [...stats.rejections.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      verdict: this.scoreVerdict(byScoreBucket, stats, warnings),
    };
  }

  /** Kesimpulan apa adanya tentang hubungan skor dengan hasil. */
  private scoreVerdict(
    byScoreBucket: PerformanceSlice[],
    stats: { enabled: boolean },
    warnings: string[],
  ): string {
    if (!stats.enabled) {
      return 'Market Intelligence tidak aktif pada backtest ini - tidak ada yang bisa dinilai.';
    }
    if (!byScoreBucket.length) {
      return 'Tidak ada trade bertanda skor - Market Intelligence menolak semua sinyal, atau tidak ada sinyal sama sekali.';
    }

    const usable = byScoreBucket.filter((b) => b.trades >= 20);
    if (usable.length < 2) {
      const msg =
        'Sampel per bucket skor terlalu kecil (butuh minimal 20 trade per bucket pada ' +
        'setidaknya dua bucket). Hubungan antara skor dan hasil BELUM bisa disimpulkan - ' +
        'jangan menaikkan ambang skor berdasarkan angka ini.';
      warnings.push(msg);
      return msg;
    }

    const sorted = [...usable].sort((a, b) => a.label.localeCompare(b.label));
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    const gap = highest.expectancyR - lowest.expectancyR;
    // Selisih harus lebih besar daripada ketidakpastian gabungan kedua bucket,
    // kalau tidak ia hanya kebisingan yang kebetulan berbentuk pola.
    const combinedError = highest.expectancyStdErrorR + lowest.expectancyStdErrorR;

    if (gap > combinedError) {
      return (
        `Bucket skor ${highest.label} berekspektasi ${highest.expectancyR}R vs ` +
        `${lowest.label} ${lowest.expectancyR}R (selisih ${gap.toFixed(3)}R melebihi ` +
        `ketidakpastian ${combinedError.toFixed(3)}R). Data MENDUKUNG anggapan skor lebih ` +
        `tinggi memberi hasil lebih baik pada periode ini.`
      );
    }

    return (
      `Selisih ekspektasi antar bucket skor (${gap.toFixed(3)}R) masih di dalam ` +
      `ketidakpastian sampel (${combinedError.toFixed(3)}R). Data TIDAK mendukung anggapan ` +
      `bahwa skor lebih tinggi menghasilkan trade lebih baik - perlakukan skor sebagai ` +
      `penyaring kualitas, bukan sebagai ramalan profit.`
    );
  }
}
