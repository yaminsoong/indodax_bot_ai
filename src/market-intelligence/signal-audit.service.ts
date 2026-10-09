import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import { SignalAnalysis } from '../database/entities/signal-analysis.entity';
import { MarketIntelligenceReport } from './market-intelligence.service';

export interface ScoreBucketPerformance {
  bucket: string;
  min: number;
  max: number;
  analyses: number;
  executed: number;
  /** Diisi oleh lapisan performa dengan menautkan tradeId. */
  trades: number;
  winRate: number | null;
  expectancyR: number | null;
  netPnl: number | null;
}

/**
 * Penyimpanan dan pembacaan jejak analisis (bagian 13 spesifikasi).
 *
 * Menulis audit TIDAK BOLEH menjatuhkan alur trading - kegagalan penyimpanan
 * ditelan dengan sengaja dan hanya dicatat sebagai peringatan, sama seperti
 * AuditService yang sudah ada.
 */
@Injectable()
export class SignalAuditService {
  private readonly logger = new Logger(SignalAuditService.name);

  constructor(
    @InjectRepository(SignalAnalysis)
    private readonly repo: Repository<SignalAnalysis>,
  ) {}

  async record(
    report: MarketIntelligenceReport,
    meta: {
      strategy: string;
      mode: string;
      observeOnly: boolean;
      executed?: boolean;
      tradeId?: number;
    },
  ): Promise<SignalAnalysis | null> {
    const c = report.confluence;
    const setup = c.setup;

    try {
      return await this.repo.save({
        pair: report.pair,
        barTime: report.mtf.asOf,
        strategy: meta.strategy,
        timeframe: c.timeframe,
        direction: c.direction,
        score: c.score,
        decision: c.decision,
        marketRegime: c.regime,

        trendScore: c.breakdown.TREND_ALIGNMENT ?? 0,
        structureScore: c.breakdown.MARKET_STRUCTURE ?? 0,
        momentumScore: c.breakdown.MOMENTUM ?? 0,
        volumeScore: c.breakdown.VOLUME ?? 0,
        supportResistanceScore: c.breakdown.SUPPORT_RESISTANCE ?? 0,
        volatilityScore: c.breakdown.VOLATILITY ?? 0,
        orderBookScore: c.breakdown.ORDER_BOOK ?? 0,
        riskRewardScore: c.breakdown.RISK_REWARD ?? 0,

        entryPrice: setup?.entryReference ?? 0,
        stopLoss: setup?.stopLoss ?? 0,
        takeProfit1: setup?.takeProfit1 ?? 0,
        takeProfit2: setup?.takeProfit2 ?? 0,
        takeProfit3: setup?.takeProfit3 ?? 0,
        riskReward: setup?.riskReward ?? 0,
        atrPercent: setup?.atrPercent ?? 0,

        reasons: report.explanation.reasons.join('\n') || null,
        blockers: c.blockers.join('\n') || null,
        riskFactors: report.explanation.risks.join('\n') || null,
        context: this.serializeContext(report),

        executed: meta.executed ? 1 : 0,
        tradeId: meta.tradeId ?? null,
        mode: meta.mode,
        observeOnly: meta.observeOnly ? 1 : 0,
      });
    } catch (err) {
      this.logger.warn(`Gagal menyimpan analisis sinyal: ${err.message}`);
      return null;
    }
  }

  /** Tandai analisis sebagai benar-benar dieksekusi, dan tautkan ke trade. */
  async markExecuted(id: number, tradeId: number): Promise<void> {
    try {
      await this.repo.update(id, { executed: 1, tradeId });
    } catch (err) {
      this.logger.warn(`Gagal menandai analisis #${id} sebagai tereksekusi: ${err.message}`);
    }
  }

  async recent(limit = 50, pair?: string): Promise<SignalAnalysis[]> {
    return this.repo.find({
      where: pair ? { pair } : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async byDecision(decision: string, limit = 50): Promise<SignalAnalysis[]> {
    return this.repo.find({ where: { decision }, order: { createdAt: 'DESC' }, take: limit });
  }

  /** Distribusi skor selama N hari terakhir. */
  async scoreDistribution(days = 30): Promise<ScoreBucketPerformance[]> {
    const since = new Date(Date.now() - days * 86400_000);
    const rows = await this.repo.find({ where: { createdAt: Between(since, new Date()) } });

    const buckets: Array<{ bucket: string; min: number; max: number }> = [
      { bucket: '0-49', min: 0, max: 49 },
      { bucket: '50-64', min: 50, max: 64 },
      { bucket: '65-69', min: 65, max: 69 },
      { bucket: '70-79', min: 70, max: 79 },
      { bucket: '80-89', min: 80, max: 89 },
      { bucket: '90-100', min: 90, max: 100 },
    ];

    return buckets.map((b) => {
      const inBucket = rows.filter((r) => r.score >= b.min && r.score <= b.max);
      return {
        ...b,
        analyses: inBucket.length,
        executed: inBucket.filter((r) => r.executed === 1).length,
        trades: 0,
        winRate: null,
        expectancyR: null,
        netPnl: null,
      };
    });
  }

  /** Blocker mana yang paling sering menolak trade. */
  async blockerStats(days = 30): Promise<Array<{ reason: string; count: number }>> {
    const since = new Date(Date.now() - days * 86400_000);
    const rows = await this.repo.find({ where: { createdAt: Between(since, new Date()) } });

    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.blockers) continue;
      for (const raw of row.blockers.split('\n')) {
        // Angka spesifik dibuang agar "ATR 6,2%" dan "ATR 7,1%" terhitung
        // sebagai satu jenis penolakan yang sama.
        const key = raw
          .replace(/-?\d+([.,]\d+)?%?/g, 'N')
          .replace(/\s+/g, ' ')
          .trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Buang analisis lama agar SQLite tidak membengkak tanpa batas. */
  async prune(olderThanDays = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
    const res = await this.repo.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }

  /**
   * Konteks ringkas untuk disimpan sebagai JSON.
   *
   * Sengaja TIDAK menyimpan seluruh deret indikator: satu analisis akan
   * menjadi ratusan kilobyte dan tabelnya membengkak dalam hitungan hari.
   * Yang disimpan hanya yang benar-benar dibutuhkan saat menelusuri ulang.
   */
  private serializeContext(report: MarketIntelligenceReport): string | null {
    try {
      const timeframes: Record<string, any> = {};
      for (const [tf, a] of Object.entries(report.mtf.timeframes)) {
        if (!a) continue;
        timeframes[tf] = {
          bias: a.bias,
          biasConfidence: a.biasConfidence,
          regime: a.regime.regime,
          volatility: a.regime.volatility,
          structureTrend: a.structure?.trend ?? null,
          rsi: a.indicators.momentum.rsi14,
          adx: a.indicators.momentum.adx,
          atrPercent: a.indicators.volatility.atrPercent,
          relativeVolume: a.indicators.volume.relativeVolume,
          lastEvents: (a.structure?.onLastBar ?? []).map((e) => ({
            type: e.type,
            direction: e.direction,
            price: e.price,
            confidence: e.confidence,
          })),
        };
      }

      const primary = report.mtf.timeframes[report.confluence.timeframe];

      return JSON.stringify({
        alignment: report.mtf.alignment,
        missingTimeframes: report.mtf.missing,
        timeframes,
        zones: (primary?.levels?.zones ?? []).slice(0, 8).map((z) => ({
          type: z.type,
          priceLow: z.priceLow,
          priceHigh: z.priceHigh,
          strength: z.strength,
          touchCount: z.touchCount,
        })),
      });
    } catch (err) {
      this.logger.warn(`Konteks analisis tidak bisa diserialisasi: ${err.message}`);
      return null;
    }
  }
}
