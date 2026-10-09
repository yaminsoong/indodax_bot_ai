import { Injectable, Logger } from '@nestjs/common';
import {
  IntelligenceRequirement,
  StrategyIntelligenceProfile,
  TradingStrategy,
} from '../strategy/strategy.interface';
import { MarketIntelligenceConfigService } from './mi-config.service';
import { NoTradeThresholds } from './confluence/confluence.types';
import { MarketIntelligenceReport } from './market-intelligence.service';
import { TimeframeAnalysis } from './mtf/mtf.types';

export interface GateDecision {
  /** Apakah entry boleh diteruskan ke Risk Engine. */
  allowed: boolean;
  /** Skor confluence yang dipakai. */
  score: number;
  /** Skor minimum yang berlaku untuk strategi ini. */
  minScore: number;
  decision: string;
  /** Alasan penolakan; kosong bila diizinkan. */
  rejections: string[];
  /** Konfirmasi yang terpenuhi - berguna untuk penjelasan sinyal. */
  confirmations: string[];
  /** Peringatan yang tidak menolak trade. */
  warnings: string[];
  /**
   * True bila Market Intelligence sedang hanya mengamati. Dalam mode ini
   * `allowed` selalu true, tetapi `rejections` tetap diisi dan dicatat -
   * itulah cara mengumpulkan bukti apakah gerbang ini layak dinyalakan.
   */
  observeOnly: boolean;
}

/**
 * Gerbang antara Market Intelligence dan strategi yang sudah ada
 * (bagian 7 spesifikasi).
 *
 * Prinsip yang dipegang: gerbang ini HANYA BISA MENOLAK, tidak pernah membuat
 * sinyal baru. Strategi tetap menjadi satu-satunya sumber sinyal BUY; Market
 * Intelligence menambahkan lapisan konfirmasi di atasnya. Konsekuensinya jelas
 * dan disengaja - kesalahan terburuk yang bisa dilakukan lapisan ini adalah
 * MELEWATKAN peluang, bukan mengambil posisi yang tidak diminta siapa pun.
 *
 * Urutan pemeriksaan:
 *   1. blocker No Trade Engine  -> tolak
 *   2. regime yang memusuhi strategi -> tolak
 *   3. konfirmasi wajib profil strategi -> tolak bila tidak terpenuhi
 *   4. skor di bawah minimum strategi -> tolak
 */
@Injectable()
export class StrategyGateService {
  private readonly logger = new Logger(StrategyGateService.name);

  constructor(private readonly config: MarketIntelligenceConfigService) {}

  evaluate(strategy: TradingStrategy, report: MarketIntelligenceReport): GateDecision {
    const params = this.config.params();
    const minScore = this.config.minScoreFor(strategy.name);
    const c = report.confluence;

    const rejections: string[] = [];
    const confirmations: string[] = [];
    const warnings: string[] = [...c.riskFactors];

    // 1. Blocker dari No Trade Engine.
    rejections.push(...c.blockers);

    // 2 & 3. Profil khusus strategi.
    const profile = strategy.intelligenceProfile;
    if (profile) {
      rejections.push(...this.checkRegime(profile, c.regime, confirmations));
      rejections.push(
        ...this.checkRequirements(profile, report, params.noTrade, confirmations, warnings),
      );
    }

    // 4. Skor minimum.
    if (c.score < minScore) {
      rejections.push(
        `Skor kualitas ${c.score} di bawah minimum ${minScore} untuk ${strategy.name}`,
      );
    } else {
      confirmations.push(`Skor kualitas ${c.score} >= minimum ${minScore}`);
    }

    // Arah yang tidak bisa dieksekusi bursa spot.
    if (!c.executable) {
      rejections.push(`Arah ${c.direction} tidak dapat dieksekusi di bursa spot`);
    }

    const observeOnly = !params.enforce;
    return {
      allowed: observeOnly || rejections.length === 0,
      score: c.score,
      minScore,
      decision: c.decision,
      rejections,
      confirmations,
      warnings,
      observeOnly,
    };
  }

  // --- Pemeriksaan regime --------------------------------------------------

  private checkRegime(
    profile: StrategyIntelligenceProfile,
    regime: string,
    confirmations: string[],
  ): string[] {
    if (profile.hostileRegimes.includes(regime)) {
      return [`Regime ${regime} tidak cocok untuk strategi ini`];
    }
    if (profile.favourableRegimes.includes(regime)) {
      confirmations.push(`Regime ${regime} mendukung strategi ini`);
    }
    return [];
  }

  // --- Pemeriksaan konfirmasi wajib ---------------------------------------

  private checkRequirements(
    profile: StrategyIntelligenceProfile,
    report: MarketIntelligenceReport,
    thresholds: NoTradeThresholds,
    confirmations: string[],
    warnings: string[],
  ): string[] {
    const rejections: string[] = [];
    const c = report.confluence;
    const primary = report.mtf.timeframes[c.timeframe];

    for (const requirement of profile.requires) {
      const result = this.checkOne(requirement, report, primary, thresholds);
      if (result.ok) confirmations.push(result.message);
      else rejections.push(result.message);
      if (result.warning) warnings.push(result.warning);
    }

    return rejections;
  }

  private checkOne(
    requirement: IntelligenceRequirement,
    report: MarketIntelligenceReport,
    primary: TimeframeAnalysis | undefined,
    thresholds: NoTradeThresholds,
  ): { ok: boolean; message: string; warning?: string } {
    const c = report.confluence;
    const alignment = report.mtf.alignment;

    switch (requirement) {
      case 'TREND_ALIGNMENT': {
        const wanted = c.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
        const ok = alignment.direction === wanted && alignment.conflicts.length === 0;
        return {
          ok,
          message: ok
            ? `Timeframe selaras ${alignment.direction} (skor ${alignment.score})`
            : `Timeframe belum selaras: arah ${alignment.direction}` +
              (alignment.conflicts.length ? `, konflik ${alignment.conflicts.length}` : ''),
        };
      }

      case 'VOLUME_CONFIRMATION': {
        const rel = primary?.indicators.volume.relativeVolume;
        if (rel === null || rel === undefined) {
          // Data volume tidak ada bukan berarti volume buruk; jangan menolak,
          // tetapi operator perlu tahu konfirmasi ini tidak bisa dilakukan.
          return {
            ok: true,
            message: 'Volume tidak dapat diverifikasi',
            warning: 'Konfirmasi volume dilewati - rata-rata volume belum bisa dihitung',
          };
        }
        const ok = rel >= 1;
        return {
          ok,
          message: ok
            ? `Volume ${(rel * 100).toFixed(0)}% dari rata-rata - terkonfirmasi`
            : `Volume hanya ${(rel * 100).toFixed(0)}% dari rata-rata - breakout/tren tanpa partisipasi`,
        };
      }

      case 'STRUCTURE_BREAK': {
        const structure = primary?.structure;
        const wanted = c.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
        const recent = [
          structure?.latest.BOS,
          structure?.latest.BREAKOUT,
          structure?.latest.CHOCH,
          structure?.latest.RETEST,
        ].filter((e) => e && e.direction === wanted);

        const ok = recent.length > 0;
        return {
          ok,
          message: ok
            ? `Penembusan struktur ${wanted.toLowerCase()} terkonfirmasi lewat close (${recent[0]!.type})`
            : 'Belum ada penembusan struktur yang terkonfirmasi lewat close',
        };
      }

      case 'RANGE_CONDITION': {
        const adx = primary?.indicators.momentum.adx;
        const regime = c.regime;
        const ok =
          regime === 'SIDEWAYS' ||
          regime === 'ACCUMULATION' ||
          regime === 'LOW_VOLATILITY' ||
          (adx !== null && adx !== undefined && adx < 25);
        return {
          ok,
          message: ok
            ? `Pasar sedang tanpa arah (regime ${regime})`
            : `Pasar sedang bergerak terarah (regime ${regime}) - bukan kondisi mean reversion`,
        };
      }

      case 'EXTREME_LOCATION': {
        const pos = primary?.levels?.positionInRange;
        if (pos === null || pos === undefined) {
          return {
            ok: true,
            message: 'Lokasi dalam rentang tidak dapat diukur',
            warning: 'Zona support/resistance belum terbentuk - lokasi entry tidak terverifikasi',
          };
        }
        // Mean reversion LONG hanya masuk akal di dasar rentang.
        const ok = c.direction === 'LONG' ? pos <= 0.35 : pos >= 0.65;
        return {
          ok,
          message: ok
            ? `Harga di ${(pos * 100).toFixed(0)}% rentang - lokasi ekstrem`
            : `Harga di ${(pos * 100).toFixed(0)}% rentang - bukan lokasi ekstrem`,
        };
      }

      case 'VOLATILITY_ROOM': {
        const atrPercent = primary?.indicators.volatility.atrPercent;
        if (atrPercent === null || atrPercent === undefined) {
          return {
            ok: true,
            message: 'Volatilitas tidak dapat diukur',
            warning: 'ATR belum bisa dihitung - ruang profit tidak terverifikasi',
          };
        }
        const ok = atrPercent >= thresholds.minAtrPercent;
        return {
          ok,
          message: ok
            ? `ATR ${atrPercent.toFixed(2)}% - ada ruang untuk profit`
            : `ATR hanya ${atrPercent.toFixed(2)}% (minimum ${thresholds.minAtrPercent}%) - ` +
              `pergerakan terlalu kecil untuk menutup fee`,
        };
      }

      default:
        return { ok: true, message: `Konfirmasi ${requirement} tidak dikenal - dilewati` };
    }
  }
}
