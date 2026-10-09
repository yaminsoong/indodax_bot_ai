import { Injectable, Logger } from '@nestjs/common';
import { Candle } from '../indodax/indodax.types';
import { Timeframe, TradeDirection } from './market-intelligence.types';
import { MarketIntelligenceConfigService } from './mi-config.service';
import { MarketDataProvider } from './mtf/market-data.provider';
import { MultiTimeframeService } from './mtf/multi-timeframe.service';
import { CandleSet, MtfContext } from './mtf/mtf.types';
import { ConfluenceEngineService } from './confluence/confluence-engine.service';
import {
  ConfluenceOptions,
  ConfluenceResult,
  OrderBookContext,
} from './confluence/confluence.types';
import { FomoGuardService } from './fomo/fomo-guard.service';
import { DEFAULT_FOMO, STRICT_FOMO, FomoAssessment } from './fomo/fomo-guard.types';
import { SignalExplainerService, SignalExplanation } from './signal-explainer.service';

/** Hasil lengkap satu analisis: konteks, skor, dan penjelasan. */
export interface MarketIntelligenceReport {
  pair: string;
  mtf: MtfContext;
  confluence: ConfluenceResult;
  explanation: SignalExplanation;
  /**
   * Penilaian FOMO, atau null bila arahnya bukan LONG.
   *
   * Blocker-nya sudah digabungkan ke `confluence.blockers`; field ini ada agar
   * rinciannya bisa ditampilkan tanpa mengurai ulang teks blocker.
   */
  fomo: FomoAssessment | null;
}

export interface AnalyzeOptions {
  /** Arah yang ingin dinilai. Default LONG (satu-satunya yang bisa dieksekusi). */
  direction?: TradeDirection;
  /**
   * Timpa saklar gerbang FOMO.
   *
   * Diperlukan karena backtest memakai `paramOverrides` sendiri, sementara
   * lapisan ini membaca konfigurasi global — tanpa jalur ini, membandingkan
   * gerbang aktif vs nonaktif dalam backtest tidak mungkin dilakukan.
   */
  fomoGuard?: boolean;
  orderBook?: OrderBookContext;
  /** Timpa kelipatan ATR untuk stop analitis (biasanya dari BotParams). */
  atrStopMultiplier?: number;
  targetMultiples?: [number, number, number];
}

/**
 * Facade Market Intelligence.
 *
 * Satu pintu masuk untuk seluruh lapisan analisis. Yang penting dipahami:
 * lapisan ini TIDAK PERNAH mengirim order dan tidak punya akses ke
 * ExecutionService maupun kredensial exchange. Ia hanya menghasilkan keputusan
 * analitis; eksekusi tetap menempuh jalur yang sudah ada:
 *
 *     Strategy -> Risk Engine -> Execution Engine -> Indodax
 *
 * Ada dua cara memanggilnya:
 *
 *  - `analyze(pair)` untuk mode live: candle diambil lewat MarketDataProvider.
 *  - `analyzeCandles(pair, candleSet)` untuk backtest: candle dipasok pemanggil,
 *    tanpa satu pun panggilan jaringan. Keduanya menjalankan kode penilaian
 *    yang sama persis - itulah syarat agar hasil backtest bisa dipercaya.
 */
@Injectable()
export class MarketIntelligenceService {
  private readonly logger = new Logger(MarketIntelligenceService.name);

  constructor(
    private readonly fomo: FomoGuardService,
    private readonly config: MarketIntelligenceConfigService,
    private readonly data: MarketDataProvider,
    private readonly mtf: MultiTimeframeService,
    private readonly confluence: ConfluenceEngineService,
    private readonly explainer: SignalExplainerService,
  ) {}

  /** Analisis satu pair dengan mengambil data terbaru dari exchange. */
  async analyze(pair: string, options: AnalyzeOptions = {}): Promise<MarketIntelligenceReport> {
    const params = this.config.params();
    const candleSet = await this.data.getCandleSet(
      pair,
      params.timeframes,
      params.barsPerTimeframe,
    );
    return this.analyzeCandles(pair, candleSet, options);
  }

  /**
   * Analisis dari candle yang sudah tersedia - murni, tanpa jaringan.
   *
   * Dipakai backtest. Pemanggil bertanggung jawab memastikan candle yang
   * dikirim hanya berisi bar yang SUDAH TERTUTUP pada titik waktu yang diuji;
   * itulah yang menjaga backtest bebas look-ahead bias.
   */
  analyzeCandles(
    pair: string,
    candleSet: CandleSet,
    options: AnalyzeOptions = {},
  ): MarketIntelligenceReport {
    const params = this.config.params();
    const mtf = this.mtf.build(pair, candleSet);

    const confluenceOptions: ConfluenceOptions = {
      weights: params.weights,
      noTrade: params.noTrade,
      orderBook: options.orderBook,
      atrStopMultiplier: options.atrStopMultiplier,
      targetMultiples: options.targetMultiples,
    };

    const direction = options.direction ?? 'LONG';
    const confluence = this.confluence.evaluate(mtf, direction, confluenceOptions);

    // Gerbang FOMO ditambahkan SETELAH confluence, bukan sebagai dimensi di
    // dalamnya. Alasannya sama dengan skor gabungan: ia hanya boleh menolak,
    // dan menjadikannya dimensi berbobot akan membuat "tidak ada FOMO"
    // MENAIKKAN skor — padahal tidak terlambat bukan alasan untuk membeli.
    const fomo = this.applyFomoGuard(pair, candleSet, mtf, confluence, direction, options.fomoGuard);

    const explanation = this.explainer.explain(confluence, mtf);

    return { pair, mtf, confluence, explanation, fomo };
  }

  /**
   * Bangun CandleSet dari candle yang sudah dimiliki pemanggil.
   *
   * Backtest memegang candle timeframe utama dan HTF; helper ini memetakannya
   * ke timeframe Market Intelligence tanpa mengambil data tambahan.
   */
  buildCandleSet(entries: Array<{ timeframe: Timeframe; candles: Candle[] }>): CandleSet {
    const set: CandleSet = {};
    for (const e of entries) {
      if (e.candles.length) set[e.timeframe] = e.candles;
    }
    return set;
  }

  /** Analisis beberapa pair sekaligus; kegagalan satu pair tidak menggagalkan sisanya. */
  /**
   * Nilai kondisi FOMO lalu TAMBAHKAN blocker-nya ke hasil confluence.
   *
   * Ambang ketat dipakai untuk pair yang gejolaknya tinggi. Batasnya memakai
   * ATR, bukan daftar nama koin: daftar nama akan selalu ketinggalan setiap
   * kali pair baru terdaftar di Indodax, sementara ATR mengukur sifat yang
   * sebenarnya ingin dibedakan.
   */
  private applyFomoGuard(
    pair: string,
    candleSet: CandleSet,
    mtf: ReturnType<MultiTimeframeService['build']>,
    confluence: ReturnType<ConfluenceEngineService['evaluate']>,
    direction: string,
    override?: boolean,
  ) {
    // FOMO hanya berlaku untuk entry arah naik; menjual ke dalam kepanikan
    // adalah persoalan yang berbeda dan tidak diukur di sini.
    if (direction !== 'LONG') return null;
    const enabled = override ?? this.config.params().fomoGuardEnabled;
    if (!enabled) return null;

    const tf = confluence.timeframe;
    const frame = mtf.timeframes?.[tf];
    const indicators = frame?.indicators ?? null;
    // Candle diambil dari CandleSet, bukan dari TimeframeAnalysis: analisis
    // per timeframe hanya menyimpan hasil indikator, bukan bar mentahnya.
    const candles = candleSet[tf] ?? [];

    const atrPercent = indicators?.volatility?.atrPercent ?? null;
    // Di atas 1,2% per bar, pair bergerak cukup cepat untuk dikejar hype.
    const thresholds = atrPercent && atrPercent >= 1.2 ? STRICT_FOMO : DEFAULT_FOMO;

    const assessment = this.fomo.assess(candles, indicators, thresholds);

    if (assessment.blockers.length) {
      confluence.blockers.push(...assessment.blockers);
      // Blocker apa pun memaksa NO_TRADE — aturan yang sama dengan No Trade
      // Engine, ditegakkan ulang di sini agar tidak bergantung pada urutan.
      confluence.decision = 'NO_TRADE';
      this.logger.debug(
        `${pair}: FOMO ${assessment.score}/100 (${thresholds === STRICT_FOMO ? 'ketat' : 'biasa'}) — entry ditahan`,
      );
    } else if (assessment.signals.length) {
      confluence.riskFactors.push(
        ...assessment.signals.map((sig) => `FOMO: ${sig.detail}`),
      );
    }

    return assessment;
  }

  async analyzeMany(
    pairs: string[],
    options: AnalyzeOptions = {},
  ): Promise<MarketIntelligenceReport[]> {
    const out: MarketIntelligenceReport[] = [];
    for (const pair of pairs) {
      try {
        out.push(await this.analyze(pair, options));
      } catch (err) {
        this.logger.warn(`Analisis ${pair} gagal: ${err.message}`);
      }
    }
    return out;
  }
}
