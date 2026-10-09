import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyAnalysis } from '../database/entities/analysis.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { TechnicalService } from '../indicators/technical.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { StrategyContext } from '../strategy/strategy.interface';
import { BotConfigService } from '../config/bot-config.service';
import { NotificationService } from '../notification/notification.service';

export interface PairAnalysis {
  pair: string;
  price: number;
  change24h: number;
  volume24h: number;
  trend: string;
  regime: string;
  htfTrend: string;
  rsi: number;
  adx: number;
  choppiness: number;
  atrPercent: number;
  signal: string;
  strength: number;
  reasons: string[];
  blockedBy: string[];
  spreadPercent: number;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly technical: TechnicalService,
    private readonly strategies: StrategyRegistry,
    private readonly notification: NotificationService,
    @InjectRepository(DailyAnalysis)
    private readonly analysisRepo: Repository<DailyAnalysis>,
  ) {}

  async runDailyAnalysis(): Promise<DailyAnalysis> {
    this.logger.log('=== Analisis Harian ===');
    const params = this.config.params();

    const pairAnalyses: PairAnalysis[] = [];
    for (const pair of params.tradingPairs) {
      try {
        const analysis = await this.analyzePair(pair);
        if (analysis) pairAnalyses.push(analysis);
      } catch (err) {
        this.logger.error(`Analisis ${pair} gagal: ${err.message}`);
      }
    }

    // Peringkat pasar diambil dari SELURUH pair IDR, bukan hanya yang dipantau.
    // Versi lama mengurutkan pair sendiri berdasarkan percent_change_24h yang
    // selalu bernilai 0, sehingga "top gainers" tidak berarti apa-apa.
    let topGainers: Array<{ pair: string; change: string; price: number }> = [];
    let topLosers: typeof topGainers = [];

    try {
      const market = await this.indodax.getMarketSummary();
      // Saring pair bervolume sangat kecil: persentasenya mudah ekstrem dan menyesatkan.
      const liquid = market.filter((m) => m.volumeIdr >= 100_000_000);
      const sorted = [...liquid].sort((a, b) => b.change24h - a.change24h);

      topGainers = sorted.slice(0, 5).map((m) => ({
        pair: m.pair,
        change: m.change24h.toFixed(2),
        price: m.last,
      }));
      topLosers = sorted
        .slice(-5)
        .reverse()
        .map((m) => ({ pair: m.pair, change: m.change24h.toFixed(2), price: m.last }));
    } catch (err) {
      this.logger.warn(`Ringkasan pasar tidak tersedia: ${err.message}`);
    }

    const bullish = pairAnalyses.filter((p) => p.trend === 'BULLISH').length;
    const bearish = pairAnalyses.filter((p) => p.trend === 'BEARISH').length;
    const marketSentiment = bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'NEUTRAL';

    const marketSummary = {
      totalPairs: pairAnalyses.length,
      bullishPairs: bullish,
      bearishPairs: bearish,
      neutralPairs: pairAnalyses.length - bullish - bearish,
      trendingPairs: pairAnalyses.filter((p) => p.regime === 'TRENDING').length,
      rangingPairs: pairAnalyses.filter((p) => p.regime === 'RANGING').length,
      marketSentiment,
      timestamp: new Date().toISOString(),
    };

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });

    // Satu baris per hari: jalankan ulang analisis akan memperbarui, bukan menduplikasi.
    const existing = await this.analysisRepo.findOne({ where: { date: today } });
    const payload = {
      date: today,
      topGainers: JSON.stringify(topGainers),
      topLosers: JSON.stringify(topLosers),
      marketSummary: JSON.stringify(marketSummary),
      pairAnalysis: JSON.stringify(pairAnalyses),
    };

    const record = existing
      ? await this.analysisRepo.save({ ...existing, ...payload })
      : await this.analysisRepo.save(payload);

    await this.notification.sendDailyAnalysis({
      date: today,
      marketSentiment,
      pairAnalyses,
      topGainers,
      topLosers,
    });

    this.logger.log(
      `Analisis selesai. Sentimen: ${marketSentiment} | ${pairAnalyses.length} pair dianalisis`,
    );
    return record;
  }

  private async analyzePair(pair: string): Promise<PairAnalysis | null> {
    const params = this.config.params();
    const strategy = this.strategies.active();

    if (!this.pairs.has(pair)) {
      this.logger.warn(`Pair ${pair} tidak dikenal di Indodax`);
      return null;
    }

    const [candles, ticker, htfCandles] = await Promise.all([
      this.indodax.getCandles(pair, params.candleTimeframe, params.candleLimit),
      this.indodax.getTicker(pair),
      params.requireHtfTrend
        ? this.indodax.getCandles(pair, params.htfTimeframe, 120).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (candles.length < strategy.minCandles) return null;

    let orderBook: StrategyContext['orderBook'];
    try {
      orderBook = this.technical.analyzeOrderBook(await this.indodax.getOrderBook(pair));
    } catch {
      /* opsional */
    }

    const signal = strategy.evaluate({
      pair,
      candles,
      htfCandles,
      orderBook,
      volumeIdr24h: ticker.volume_idr,
      params,
      hasOpenPosition: false,
    });

    const s = signal.snapshot;
    return {
      pair,
      price: ticker.last,
      change24h: ticker.percent_change_24h,
      volume24h: ticker.volume_idr,
      trend: s.trend,
      regime: s.regime,
      htfTrend: s.htfTrend,
      rsi: s.rsi,
      adx: s.adx,
      choppiness: s.choppiness,
      atrPercent: s.atrPercent,
      signal: signal.action,
      strength: signal.strength,
      reasons: signal.reasons,
      blockedBy: signal.blockedBy,
      spreadPercent: ticker.spreadPercent,
    };
  }

  async getLatestAnalysis(): Promise<DailyAnalysis | null> {
    return this.analysisRepo.findOne({ where: {}, order: { createdAt: 'DESC' } });
  }

  async getAnalysisHistory(days = 7): Promise<DailyAnalysis[]> {
    return this.analysisRepo.find({ order: { createdAt: 'DESC' }, take: days });
  }

  /** Analisis satu pair secara langsung (dipakai dashboard dan perintah /scan). */
  async analyzeNow(pair: string): Promise<PairAnalysis | null> {
    return this.analyzePair(pair.toLowerCase());
  }
}
