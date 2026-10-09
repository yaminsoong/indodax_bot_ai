import { Injectable, Logger } from '@nestjs/common';
import { Timeframe, TradeDirection } from '../market-intelligence.types';
import { MarketIntelligenceReport, MarketIntelligenceService } from '../market-intelligence.service';
import { MarketIntelligenceConfigService } from '../mi-config.service';
import { TimeframeAnalysis } from '../mtf/mtf.types';
import { IndodaxService } from '../../indodax/indodax.service';
import { PairRegistryService } from '../../indodax/pair-registry.service';
import { isStablecoinPair } from '../../common/stablecoins';


/** Jenis pemindaian yang tersedia (bagian 18 spesifikasi). */
export type ScannerType =
  | 'STRONG_TREND'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'VOLUME_SPIKE'
  | 'RSI_OVERSOLD'
  | 'RSI_OVERBOUGHT'
  | 'EMA_CROSS'
  | 'MACD_CROSS'
  | 'SUPPORT_BOUNCE'
  | 'RESISTANCE_REJECTION'
  | 'HIGH_SCORE_SETUP';

export interface ScannerFilter {
  /**
   * Pair yang dipindai. Bila kosong, scanner MENEMUKAN SENDIRI pair layak
   * lewat penyaringan likuiditas — itulah mode yang dipakai pemindaian
   * terjadwal.
   */
  pairs?: string[];
  timeframe?: Timeframe;
  strategy?: string;
  minScore?: number;
  regime?: string;
  types?: ScannerType[];
  direction?: TradeDirection;
  /** Volume 24 jam minimum (IDR) saat menemukan pair sendiri. */
  minVolumeIdr?: number;
  /** Spread maksimum (persen) saat menemukan pair sendiri. */
  maxSpreadPercent?: number;
  /**
   * Batas jumlah pair yang dianalisis penuh.
   *
   * Analisis Market Intelligence mengambil lima timeframe per pair; memindai
   * seluruh 463 pair IDR berarti ratusan permintaan dan menghabiskan jatah
   * rate limit yang juga dibutuhkan bot untuk trading. Penyaringan likuiditas
   * memakai SATU panggilan ringkasan pasar, lalu hanya yang teratas yang
   * dianalisis mahal.
   */
  maxPairs?: number;
}

/** Pair yang lolos penyaringan murah, sebelum analisis penuh dijalankan. */
export interface PrefilterResult {
  candidates: string[];
  totalPairs: number;
  rejected: { volume: number; spread: number; untradable: number; stablecoin: number };
}

export interface ScannerHit {
  pair: string;
  type: ScannerType;
  timeframe: Timeframe;
  direction: string;
  score: number;
  decision: string;
  regime: string;
  price: number;
  detail: string;
}

export interface ScannerResult {
  scannedAt: string;
  pairsScanned: number;
  pairsFailed: string[];
  /** Ringkasan penyaringan likuiditas; null bila daftar pair diberikan manual. */
  prefilter: PrefilterResult | null;
  hits: ScannerHit[];
  /** Ringkasan per pair, termasuk yang tidak menghasilkan hit. */
  overview: Array<{
    pair: string;
    price: number;
    score: number;
    decision: string;
    regime: string;
    trend: string;
    structure: string;
    rsi: number | null;
    relativeVolume: number | null;
    atrPercent: number | null;
  }>;
}

/**
 * Signal Scanner.
 *
 * Menjalankan Market Intelligence pada sekumpulan pair lalu menandai kondisi
 * yang layak diperhatikan. Scanner TIDAK membuka posisi dan tidak memicu
 * strategi - ia hanya menyaring daftar tontonan agar operator tidak perlu
 * membuka puluhan grafik satu per satu.
 */
@Injectable()
export class SignalScannerService {
  private readonly logger = new Logger(SignalScannerService.name);

  constructor(
    private readonly intelligence: MarketIntelligenceService,
    private readonly config: MarketIntelligenceConfigService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
  ) {}

  /**
   * Temukan pair layak pindai dari seluruh pasar IDR.
   *
   * Memakai SATU panggilan ringkasan pasar untuk menyaring volume, lalu
   * memeriksa status maintenance dari metadata pair yang sudah di-cache.
   * Spread tidak diperiksa di sini: itu butuh satu panggilan ticker per pair,
   * dan pada ratusan pair biayanya justru menyamai analisis yang hendak
   * dihemat — spread disaring belakangan oleh Market Intelligence pada
   * kandidat yang jauh lebih sedikit.
   */
  async prefilter(filter: ScannerFilter = {}): Promise<PrefilterResult> {
    const minVolume = filter.minVolumeIdr ?? this.config.params().scannerMinVolumeIdr;
    const maxPairs = filter.maxPairs ?? this.config.params().scannerMaxPairs;

    const market = await this.indodax.getMarketSummary();
    const rejected = { volume: 0, spread: 0, untradable: 0, stablecoin: 0 };

    const eligible = market
      .filter((m) => {
        // Pair stablecoin disingkirkan lebih dulu. Volumenya selalu tertinggi
        // di Indodax sehingga ia nyaris pasti menduduki puncak peringkat,
        // padahal "tren" yang terdeteksi di sana hanyalah pergerakan kurs
        // rupiah — bukan peluang yang bisa dimanfaatkan strategi momentum.
        if (isStablecoinPair(m.pair)) {
          rejected.stablecoin++;
          return false;
        }
        if (m.volumeIdr < minVolume) {
          rejected.volume++;
          return false;
        }
        const tradable = this.pairs.isTradable(m.pair);
        if (!tradable.ok) {
          rejected.untradable++;
          return false;
        }
        return true;
      })
      // Volume terbesar lebih dulu: pair paling likuid adalah yang paling
      // mudah dimasuki DAN dikeluari dengan modal kecil.
      .sort((a, b) => b.volumeIdr - a.volumeIdr);

    return {
      candidates: eligible.slice(0, maxPairs).map((m) => m.pair),
      totalPairs: market.length,
      rejected,
    };
  }

  async scan(filter: ScannerFilter = {}): Promise<ScannerResult> {
    const params = this.config.params();
    const direction = filter.direction ?? 'LONG';

    // Tanpa daftar pair eksplisit, scanner menemukan sendiri. Versi sebelumnya
    // mengembalikan array kosong di sini — artinya memindai NOL pair tanpa
    // satu pun pesan yang menyatakannya.
    let prefilterResult: PrefilterResult | null = null;
    let pairs: string[];

    if (filter.pairs?.length) {
      pairs = filter.pairs;
    } else {
      prefilterResult = await this.prefilter(filter);
      pairs = prefilterResult.candidates;
      this.logger.log(
        `Penyaringan likuiditas: ${pairs.length} kandidat dari ${prefilterResult.totalPairs} pair IDR ` +
          `(${prefilterResult.rejected.volume} volume kurang, ${prefilterResult.rejected.untradable} tidak dapat ditradingkan)`,
      );
    }

    const hits: ScannerHit[] = [];
    const overview: ScannerResult['overview'] = [];
    const failed: string[] = [];

    for (const pair of pairs) {
      try {
        const report = await this.intelligence.analyze(pair, { direction });
        const tf = filter.timeframe ?? report.confluence.timeframe;
        const analysis = report.mtf.timeframes[tf];
        if (!analysis) continue;

        overview.push(this.summarize(pair, report, analysis));

        const minScore = filter.minScore ?? 0;
        if (report.confluence.score < minScore) continue;
        if (filter.regime && report.confluence.regime !== filter.regime) continue;

        const found = this.detect(pair, report, analysis, tf);
        hits.push(...(filter.types?.length ? found.filter((h) => filter.types!.includes(h.type)) : found));
      } catch (err) {
        this.logger.warn(`Scan ${pair} gagal: ${err.message}`);
        failed.push(pair);
      }
    }

    // Skor tertinggi lebih dulu - itulah yang paling layak dilihat operator.
    hits.sort((a, b) => b.score - a.score);
    overview.sort((a, b) => b.score - a.score);

    void params;
    return {
      scannedAt: new Date().toISOString(),
      pairsScanned: pairs.length,
      pairsFailed: failed,
      prefilter: prefilterResult,
      hits,
      overview,
    };
  }

  // --- Deteksi kondisi -----------------------------------------------------

  private detect(
    pair: string,
    report: MarketIntelligenceReport,
    a: TimeframeAnalysis,
    tf: Timeframe,
  ): ScannerHit[] {
    const out: ScannerHit[] = [];
    const c = report.confluence;
    const price = a.indicators.price.close;

    const push = (type: ScannerType, detail: string, direction = c.direction) =>
      out.push({
        pair,
        type,
        timeframe: tf,
        direction,
        score: c.score,
        decision: c.decision,
        regime: c.regime,
        price,
        detail,
      });

    // Tren kuat: ADX tinggi DAN susunan EMA mendukung - satu saja tidak cukup.
    const adx = a.indicators.momentum.adx;
    if (adx !== null && adx >= 30 && a.indicators.trend.emaStack !== 'NEUTRAL') {
      push('STRONG_TREND', `ADX ${adx.toFixed(0)}, EMA ${a.indicators.trend.emaStack}`);
    }

    for (const event of a.structure?.onLastBar ?? []) {
      if (event.type === 'BREAKOUT' || (event.type === 'BOS' && event.direction === 'BULLISH')) {
        push('BREAKOUT', `${event.type} di ${event.price.toFixed(0)} (keyakinan ${(event.confidence * 100).toFixed(0)}%)`, 'LONG');
      }
      if (event.type === 'BREAKDOWN' || (event.type === 'BOS' && event.direction === 'BEARISH')) {
        push('BREAKDOWN', `${event.type} di ${event.price.toFixed(0)} (keyakinan ${(event.confidence * 100).toFixed(0)}%)`, 'SHORT');
      }
    }

    if (a.indicators.volume.spike && a.indicators.volume.relativeVolume !== null) {
      push('VOLUME_SPIKE', `Volume ${(a.indicators.volume.relativeVolume * 100).toFixed(0)}% dari rata-rata`);
    }

    const rsi = a.indicators.momentum.rsi14;
    if (rsi !== null) {
      if (rsi <= 30) push('RSI_OVERSOLD', `RSI ${rsi.toFixed(1)}`, 'LONG');
      if (rsi >= 70) push('RSI_OVERBOUGHT', `RSI ${rsi.toFixed(1)}`, 'SHORT');
    }

    const { ema9, ema21 } = a.indicators.trend;
    if (ema9 !== null && ema21 !== null) {
      const gap = Math.abs(ema9 - ema21) / (a.indicators.price.close || 1);
      // Hanya persilangan yang BARU terjadi yang menarik; EMA yang sudah lama
      // berjauhan bukan lagi sinyal persilangan.
      if (gap < 0.002) {
        push('EMA_CROSS', `EMA9 dan EMA21 nyaris bersilangan (selisih ${(gap * 100).toFixed(2)}%)`);
      }
    }

    const macd = a.indicators.momentum.macd;
    const prev = a.indicators.momentum.macdHistogramPrev;
    if (macd.histogram !== null && prev !== null) {
      if (macd.histogram > 0 && prev <= 0) push('MACD_CROSS', 'Histogram MACD menyilang ke positif', 'LONG');
      if (macd.histogram < 0 && prev >= 0) push('MACD_CROSS', 'Histogram MACD menyilang ke negatif', 'SHORT');
    }

    const support = a.levels?.nearestSupport;
    if (support && Math.abs(support.distancePercent) <= 1 && support.strength >= 50) {
      push('SUPPORT_BOUNCE', `Harga menempel ${support.type.replace('_', ' ')} (kekuatan ${support.strength})`, 'LONG');
    }

    const resistance = a.levels?.nearestResistance;
    if (resistance && Math.abs(resistance.distancePercent) <= 1 && resistance.strength >= 50) {
      push('RESISTANCE_REJECTION', `Harga menempel ${resistance.type.replace('_', ' ')} (kekuatan ${resistance.strength})`, 'SHORT');
    }

    if (c.decision === 'HIGH_QUALITY_SETUP' || c.decision === 'TRADE_SETUP') {
      push('HIGH_SCORE_SETUP', `Skor ${c.score}/100 - ${c.decision}`);
    }

    return out;
  }

  private summarize(
    pair: string,
    report: MarketIntelligenceReport,
    a: TimeframeAnalysis,
  ): ScannerResult['overview'][number] {
    const structureEvent = a.structure?.latest.BOS ?? a.structure?.latest.CHOCH;
    return {
      pair,
      price: a.indicators.price.close,
      score: report.confluence.score,
      decision: report.confluence.decision,
      regime: report.confluence.regime,
      trend: a.bias,
      structure: structureEvent
        ? `${structureEvent.type} ${structureEvent.direction}`
        : (a.structure?.trend ?? 'UNKNOWN'),
      rsi: a.indicators.momentum.rsi14,
      relativeVolume: a.indicators.volume.relativeVolume,
      atrPercent: a.indicators.volatility.atrPercent,
    };
  }
}
