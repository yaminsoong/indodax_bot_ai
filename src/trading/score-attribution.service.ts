import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { BotConfigService } from '../config/bot-config.service';
import { PerformanceSlice } from '../backtest/backtest.types';
import { SCORE_BUCKETS, sliceByRegime, sliceByScore } from '../backtest/performance-slice';

/** Jumlah trade minimum per bucket sebelum angkanya layak dibaca. */
const MIN_TRADES_PER_BUCKET = 20;
/** Berapa banyak bucket harus memenuhi ambang itu sebelum hubungannya bisa dinilai. */
const MIN_READY_BUCKETS = 2;

export interface ScoreAttribution {
  mode: string;
  totalClosed: number;
  /** Trade tertutup yang menyimpan skor MI; sisanya tidak bisa diatribusikan. */
  scored: number;
  byScore: PerformanceSlice[];
  byRegime: PerformanceSlice[];
  /** Bucket yang sudah mencapai MIN_TRADES_PER_BUCKET. */
  readyBuckets: number;
  minTradesPerBucket: number;
  /** True bila hubungan skor-hasil sudah layak dinilai. */
  conclusive: boolean;
  /**
   * Arah hubungan skor terhadap hasil, HANYA bila `conclusive`.
   *
   * null selama sampelnya belum cukup — bukan "netral". Melaporkan arah dari
   * sampel kecil adalah cara tercepat menarik kesimpulan yang salah, dan di
   * sini kesimpulan salah berarti mengubah ambang skor ke arah yang keliru.
   */
  direction: 'SEARAH' | 'TERBALIK' | 'TIDAK JELAS' | null;
  caveat: string;
}

/**
 * Apakah skor Market Intelligence benar-benar meramalkan hasil?
 *
 * Pertanyaan ini menentukan arah seluruh proyek, dan jawabannya bisa
 * mengejutkan. Pada walk-forward 16 Okt 2026 — dijalankan setelah bug
 * pemotongan backtest diperbaiki — hubungannya tampak TERBALIK:
 *
 *   bucket 65-69 :  3 trade, win 33%, -0,652R
 *   bucket 70-79 : 13 trade, win 31%, -0,377R
 *   bucket 80-89 :  7 trade, win  0%, -1,217R
 *   bucket 90-100:  1 trade, win  0%, -1,224R
 *
 * Skor 80+: delapan trade, nol menang. Bila itu nyata, menaikkan ambang skor
 * justru MEMPERBURUK hasil — kebalikan dari dugaan wajar siapa pun.
 *
 * Tetapi sampelnya terlalu kecil untuk disimpulkan: peluang nol menang dari
 * delapan trade pada win rate dasar ~37% adalah ~2,5%. Mengusik, bukan bukti.
 *
 * Karena itu layanan ini TIDAK melaporkan arah hubungan sampai ada cukup
 * trade per bucket, dan `direction` bernilai null — bukan "netral" — selama
 * belum cukup. Perhitungannya memakai ULANG `sliceByScore` dari lapisan
 * backtest: dua rumus ekspektasi yang berbeda akan menghasilkan dua
 * kesimpulan berbeda tentang data yang sama.
 */
@Injectable()
export class ScoreAttributionService {
  private readonly logger = new Logger(ScoreAttributionService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly config: BotConfigService,
  ) {}

  async attribute(): Promise<ScoreAttribution> {
    const params = this.config.params();
    const closed = await this.tradeRepo.find({
      where: { status: 'CLOSED', mode: this.config.mode as any },
    });

    /**
     * Dipetakan ke bentuk yang dipakai lapisan backtest agar fungsi irisannya
     * bisa dipakai apa adanya. `holdingBars` diturunkan dari lama tahan dibagi
     * panjang bar; field itu tidak disimpan di database karena timeframe bisa
     * berubah, sementara waktu buka-tutup tidak.
     */
    const barMenit = Math.max(1, params.candleTimeframe);
    const mapped = closed.map((t) => ({
      pair: t.pair,
      strategy: t.strategy,
      rMultiple: t.rMultiple ?? 0,
      profitLoss: t.profitLoss ?? 0,
      intelligenceScore: t.intelligenceScore ?? null,
      marketRegime: t.marketRegime ?? null,
      holdingBars:
        t.closedAt && t.openedAt
          ? Math.max(
              0,
              Math.round(
                (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) /
                  (barMenit * 60_000),
              ),
            )
          : 0,
    })) as any[];

    const byScore = sliceByScore(mapped);
    const byRegime = sliceByRegime(mapped);
    const scored = mapped.filter(
      (t) => t.intelligenceScore !== null && t.intelligenceScore !== undefined,
    ).length;

    const readyBuckets = byScore.filter((b) => b.trades >= MIN_TRADES_PER_BUCKET).length;
    const conclusive = readyBuckets >= MIN_READY_BUCKETS;

    return {
      mode: this.config.mode,
      totalClosed: closed.length,
      scored,
      byScore,
      byRegime,
      readyBuckets,
      minTradesPerBucket: MIN_TRADES_PER_BUCKET,
      conclusive,
      direction: conclusive ? this.direction(byScore) : null,
      caveat: conclusive
        ? `${readyBuckets} bucket sudah mencapai ${MIN_TRADES_PER_BUCKET} trade — hubungannya layak dinilai.`
        : `Butuh ${MIN_TRADES_PER_BUCKET} trade pada minimal ${MIN_READY_BUCKETS} bucket; ` +
          `baru ${readyBuckets} yang memenuhi. Arah hubungan BELUM bisa disimpulkan.`,
    };
  }

  /**
   * Arah hubungan skor terhadap ekspektasi.
   *
   * Dibandingkan hanya antar bucket yang sampelnya cukup — bucket berisi tiga
   * trade tidak boleh menentukan kesimpulan tentang bucket berisi dua ratus.
   * Perbedaan di bawah 0,1R dianggap tidak jelas: di bawah itu, galat baku
   * khas sudah lebih besar daripada selisihnya.
   */
  private direction(byScore: PerformanceSlice[]): 'SEARAH' | 'TERBALIK' | 'TIDAK JELAS' {
    const urut = SCORE_BUCKETS.map(([label]) => label)
      .map((label) => byScore.find((b) => b.label === label))
      .filter((b): b is PerformanceSlice => !!b && b.trades >= MIN_TRADES_PER_BUCKET);

    if (urut.length < MIN_READY_BUCKETS) return 'TIDAK JELAS';

    const terendah = urut[0];
    const tertinggi = urut[urut.length - 1];
    const selisih = tertinggi.expectancyR - terendah.expectancyR;

    if (Math.abs(selisih) < 0.1) return 'TIDAK JELAS';
    return selisih > 0 ? 'SEARAH' : 'TERBALIK';
  }
}
