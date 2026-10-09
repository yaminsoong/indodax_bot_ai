import { Injectable, Logger } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.service';
import { IndicatorReport } from '../indicators/indicator.types';
import {
  DEFAULT_FOMO,
  FOMO_CAVEAT,
  FomoAssessment,
  FomoSeverity,
  FomoSignal,
  FomoThresholds,
} from './fomo-guard.types';

/** Bobot tiap tanda dalam skor akhir. Totalnya 100. */
const WEIGHTS: Record<FomoSignal['code'], number> = {
  PRICE_ALREADY_RAN: 30,
  EXTENDED_FROM_MEAN: 25,
  PARABOLIC: 15,
  BLOWOFF_VOLUME: 15,
  OVERBOUGHT_STACK: 10,
  HYPE_WITHOUT_STRUCTURE: 5,
};

/**
 * Mengukur seberapa terlambat sebuah entry.
 *
 * Seluruh pengukuran dinormalkan terhadap ATR pair itu sendiri, sehingga satu
 * set ambang berlaku untuk BTC maupun memecoin. Tanpa normalisasi, ambang yang
 * benar untuk BTC akan menolak hampir seluruh memecoin, dan ambang yang benar
 * untuk memecoin tidak akan pernah menolak apa pun pada BTC.
 */
@Injectable()
export class FomoGuardService {
  private readonly logger = new Logger(FomoGuardService.name);

  /**
   * Nilai kondisi FOMO.
   *
   * `newsScore` opsional: berita yang sangat positif bersamaan dengan harga
   * yang sudah terentang adalah tanda puncak hype, bukan konfirmasi. Bila
   * tidak tersedia, tanda itu dilewati — bukan diasumsikan aman.
   */
  assess(
    candles: Candle[],
    indicators: IndicatorReport | null,
    thresholds: FomoThresholds = DEFAULT_FOMO,
    newsScore?: number,
  ): FomoAssessment {
    const atrPercent = indicators?.volatility?.atrPercent ?? null;

    // Tanpa ATR, seluruh ambang relatif kehilangan dasarnya. Mengembalikan
    // "tidak ada FOMO" di sini akan menjadi izin yang tidak berdasar.
    if (!atrPercent || atrPercent <= 0 || candles.length < 3) {
      return {
        score: 0,
        severity: 'NONE',
        signals: [],
        blockers: [],
        inconclusive: true,
        caveat: `Data tidak cukup untuk menilai FOMO (ATR atau candle tidak tersedia). ${FOMO_CAVEAT}`,
      };
    }

    const signals: FomoSignal[] = [];
    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];

    // ── 1. Harga sudah berjalan ─────────────────────────────────────────────
    const lookback = Math.min(thresholds.lookbackBars, closes.length - 1);
    const from = closes[closes.length - 1 - lookback];
    if (from > 0) {
      const runPercent = ((last - from) / from) * 100;
      const inAtr = runPercent / atrPercent;
      if (inAtr >= thresholds.runAtrMultiple) {
        signals.push({
          code: 'PRICE_ALREADY_RAN',
          detail:
            `Harga sudah naik ${runPercent.toFixed(1)}% dalam ${lookback} bar ` +
            `(${inAtr.toFixed(1)}x ATR, ambang ${thresholds.runAtrMultiple}x)`,
          magnitude: clamp01(inAtr / (thresholds.runAtrMultiple * 2)),
        });
      }
    }

    // ── 2. Terlalu jauh dari rata-rata ──────────────────────────────────────
    const ema21 = indicators?.trend?.ema21 ?? null;
    if (ema21 && ema21 > 0) {
      const extPercent = ((last - ema21) / ema21) * 100;
      const extAtr = extPercent / atrPercent;
      if (extAtr >= thresholds.extensionAtrMultiple) {
        signals.push({
          code: 'EXTENDED_FROM_MEAN',
          detail:
            `Harga ${extPercent.toFixed(1)}% di atas EMA21 ` +
            `(${extAtr.toFixed(1)}x ATR, ambang ${thresholds.extensionAtrMultiple}x) — ` +
            `stop wajar jadi sangat lebar`,
          magnitude: clamp01(extAtr / (thresholds.extensionAtrMultiple * 2)),
        });
      }
    }

    // ── 3. Parabolik ────────────────────────────────────────────────────────
    let upRun = 0;
    for (let i = closes.length - 1; i > 0; i--) {
      if (closes[i] > closes[i - 1]) upRun++;
      else break;
    }
    if (upRun >= thresholds.consecutiveUpBars) {
      signals.push({
        code: 'PARABOLIC',
        detail: `${upRun} bar naik berurutan (ambang ${thresholds.consecutiveUpBars}) — tidak ada jeda untuk masuk`,
        magnitude: clamp01(upRun / (thresholds.consecutiveUpBars * 2)),
      });
    }

    // ── 4. Volume blow-off ──────────────────────────────────────────────────
    // Hanya berarti bila harga JUGA sudah terentang. Volume tinggi pada harga
    // yang belum bergerak adalah akumulasi, bukan puncak.
    const relVol = indicators?.volume?.relativeVolume ?? null;
    const sudahTerentang = signals.some(
      (s) => s.code === 'PRICE_ALREADY_RAN' || s.code === 'EXTENDED_FROM_MEAN',
    );
    if (relVol && relVol >= thresholds.blowoffRelativeVolume && sudahTerentang) {
      signals.push({
        code: 'BLOWOFF_VOLUME',
        detail:
          `Volume ${relVol.toFixed(1)}x rata-rata saat harga sudah terentang — ` +
          `ciri pembelian terakhir, bukan awal`,
        magnitude: clamp01(relVol / (thresholds.blowoffRelativeVolume * 2)),
      });
    }

    // ── 5. Jenuh beli ───────────────────────────────────────────────────────
    const rsi = indicators?.momentum?.rsi14 ?? null;
    if (rsi && rsi >= thresholds.overboughtRsi) {
      signals.push({
        code: 'OVERBOUGHT_STACK',
        detail: `RSI ${rsi.toFixed(0)} (ambang ${thresholds.overboughtRsi})`,
        magnitude: clamp01((rsi - thresholds.overboughtRsi) / (100 - thresholds.overboughtRsi)),
      });
    }

    // ── 6. Hype tanpa struktur ──────────────────────────────────────────────
    // Berita sangat positif pada harga yang sudah terentang: kabarnya sudah
    // tercermin di harga, dan yang membeli sekarang membeli dari yang membaca
    // lebih dulu.
    if (newsScore !== undefined && newsScore >= 70 && sudahTerentang) {
      signals.push({
        code: 'HYPE_WITHOUT_STRUCTURE',
        detail: `Berita sangat positif (${newsScore}/100) pada harga yang sudah terentang — kabarnya sudah tercermin`,
        magnitude: clamp01((newsScore - 70) / 30),
      });
    }

    // ── Skor ────────────────────────────────────────────────────────────────
    const score = Math.round(
      Math.min(
        100,
        signals.reduce((sum, s) => sum + WEIGHTS[s.code] * (0.5 + 0.5 * s.magnitude), 0),
      ),
    );

    const severity: FomoSeverity =
      score >= thresholds.blockAboveScore ? 'BLOCK' : score > 0 ? 'WATCH' : 'NONE';

    const blockers =
      severity === 'BLOCK'
        ? [
            `Mengejar gerakan yang sudah terjadi (skor FOMO ${score}/100): ` +
              signals.map((s) => s.detail).join('; '),
          ]
        : [];

    return { score, severity, signals, blockers, inconclusive: false, caveat: FOMO_CAVEAT };
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
