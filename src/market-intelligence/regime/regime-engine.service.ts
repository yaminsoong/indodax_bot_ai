import { Injectable } from '@nestjs/common';
import { Candle } from '../../indodax/indodax.types';
import { clamp } from '../../common/num';
import { Timeframe } from '../market-intelligence.types';
import { IndicatorReport } from '../indicators/indicator.types';
import { StructureReport } from '../structure/structure.types';
import {
  MarketRegimeType,
  RegimeCandidate,
  RegimeReport,
  VolatilityRegime,
} from './regime.types';

export interface RegimeOptions {
  /** ADX di atas ini dianggap ada tren. */
  trendingAdx: number;
  /** ADX di bawah ini dianggap tanpa arah. */
  rangingAdx: number;
  /** ATR relatif terhadap rata-ratanya sebelum disebut volatilitas tinggi. */
  highVolatilityRatio: number;
  /** ATR relatif sebelum disebut volatilitas rendah. */
  lowVolatilityRatio: number;
  /** Berapa bar dipakai mengukur posisi harga dalam rentang. */
  rangeLookback: number;
}

export const DEFAULT_REGIME_OPTIONS: RegimeOptions = {
  trendingAdx: 22,
  rangingAdx: 18,
  highVolatilityRatio: 1.4,
  lowVolatilityRatio: 0.7,
  rangeLookback: 40,
};

/**
 * Market Regime Engine.
 *
 * Menentukan "pasar sedang dalam kondisi apa" dari GABUNGAN bukti: ADX beserta
 * +DI/-DI, susunan EMA, ATR, lebar Bollinger, struktur harga, dan volume.
 *
 * Aturan yang ditegakkan di sini (bagian 5 spesifikasi): tidak ada satu
 * indikator pun yang boleh menentukan regime sendirian. Setiap kandidat regime
 * harus mengumpulkan bukti dari minimal dua sumber sebelum bisa menang -
 * `MIN_EVIDENCE`. ADX 30 tanpa susunan EMA yang mendukung, misalnya, bisa saja
 * berarti tren turun yang baru berbalik, bukan tren naik.
 */
@Injectable()
export class RegimeEngineService {
  /** Jumlah bukti minimum sebelum sebuah regime boleh menjadi regime utama. */
  private static readonly MIN_EVIDENCE = 2;

  analyze(
    timeframe: Timeframe,
    indicators: IndicatorReport,
    structure: StructureReport | null,
    candles: Candle[],
    options: Partial<RegimeOptions> = {},
  ): RegimeReport {
    const opts: RegimeOptions = { ...DEFAULT_REGIME_OPTIONS, ...options };

    const adx = indicators.momentum.adx;
    const plusDi = indicators.momentum.plusDi;
    const minusDi = indicators.momentum.minusDi;
    const emaStack = indicators.trend.emaStack;
    const atrRatio = indicators.volatility.atrRatio;
    const squeeze = indicators.volatility.squeeze;
    const volState = indicators.volume.state;
    const relVolume = indicators.volume.relativeVolume;
    const structTrend = structure?.trend ?? 'NEUTRAL';

    const positionInRange = this.positionInRange(candles, opts.rangeLookback);
    const volatility = this.volatilityRegime(atrRatio, squeeze, opts);

    const candidates: RegimeCandidate[] = [];
    const add = (regime: MarketRegimeType, evidence: string[]) => {
      if (!evidence.length) return;
      candidates.push({
        regime,
        // Skor tumbuh cepat pada bukti pertama lalu melandai: bukti kelima
        // tidak boleh membuat regime terlihat dua kali lebih pasti daripada
        // bukti ketiga.
        score: Number(clamp(1 - Math.pow(0.55, evidence.length), 0, 1).toFixed(3)),
        evidence,
      });
    };

    // --- BULL_TREND -------------------------------------------------------
    const bull: string[] = [];
    if (adx !== null && adx >= opts.trendingAdx) bull.push(`ADX ${adx.toFixed(1)} menandakan tren`);
    if (plusDi !== null && minusDi !== null && plusDi > minusDi) {
      bull.push(`+DI ${plusDi.toFixed(1)} > -DI ${minusDi.toFixed(1)}`);
    }
    if (emaStack === 'BULLISH') bull.push('EMA 9/21/50 tersusun naik');
    if (structTrend === 'BULLISH') bull.push('Struktur harga membentuk HH/HL');
    if (indicators.trend.priceVsEma200Percent !== null && indicators.trend.priceVsEma200Percent > 0) {
      bull.push('Harga di atas EMA200');
    }
    add('BULL_TREND', bull);

    // --- BEAR_TREND -------------------------------------------------------
    const bear: string[] = [];
    if (adx !== null && adx >= opts.trendingAdx) bear.push(`ADX ${adx.toFixed(1)} menandakan tren`);
    if (plusDi !== null && minusDi !== null && minusDi > plusDi) {
      bear.push(`-DI ${minusDi.toFixed(1)} > +DI ${plusDi.toFixed(1)}`);
    }
    if (emaStack === 'BEARISH') bear.push('EMA 9/21/50 tersusun turun');
    if (structTrend === 'BEARISH') bear.push('Struktur harga membentuk LH/LL');
    if (indicators.trend.priceVsEma200Percent !== null && indicators.trend.priceVsEma200Percent < 0) {
      bear.push('Harga di bawah EMA200');
    }
    add('BEAR_TREND', bear);

    // --- SIDEWAYS ---------------------------------------------------------
    const flat: string[] = [];
    if (adx !== null && adx < opts.rangingAdx) flat.push(`ADX ${adx.toFixed(1)} rendah - tanpa arah`);
    if (emaStack === 'NEUTRAL') flat.push('EMA saling bersilangan');
    if (structTrend === 'NEUTRAL') flat.push('Struktur tidak membentuk arah');
    if (squeeze) flat.push('Bollinger menyempit');
    add('SIDEWAYS', flat);

    // --- BREAKOUT / BREAKDOWN --------------------------------------------
    // Ekspansi dari rentang, bukan sekadar candle hijau besar: butuh event
    // struktur pada bar terakhir DAN konfirmasi volume atau volatilitas.
    const lastBarEvents = structure?.onLastBar ?? [];
    const bullBreak = lastBarEvents.filter(
      (e) => (e.type === 'BREAKOUT' || e.type === 'BOS' || e.type === 'CHOCH') && e.direction === 'BULLISH',
    );
    const bearBreak = lastBarEvents.filter(
      (e) => (e.type === 'BREAKDOWN' || e.type === 'BOS' || e.type === 'CHOCH') && e.direction === 'BEARISH',
    );

    if (bullBreak.length) {
      const ev = [`${bullBreak[0].type} bullish terkonfirmasi pada candle terakhir`];
      if (relVolume !== null && relVolume >= 1.3) ev.push(`Volume ${(relVolume * 100).toFixed(0)}% dari rata-rata`);
      if (volState === 'EXPANDING') ev.push('Volume sedang melebar');
      if (indicators.volatility.state === 'EXPANDING') ev.push('Volatilitas melebar');
      add('BREAKOUT', ev);
    }
    if (bearBreak.length) {
      const ev = [`${bearBreak[0].type} bearish terkonfirmasi pada candle terakhir`];
      if (relVolume !== null && relVolume >= 1.3) ev.push(`Volume ${(relVolume * 100).toFixed(0)}% dari rata-rata`);
      if (volState === 'EXPANDING') ev.push('Volume sedang melebar');
      if (indicators.volatility.state === 'EXPANDING') ev.push('Volatilitas melebar');
      add('BREAKDOWN', ev);
    }

    // --- ACCUMULATION / DISTRIBUTION -------------------------------------
    // Pasar datar yang menyerap volume. Di dasar rentang = akumulasi,
    // di puncak rentang = distribusi. Tanpa syarat volume, ini hanya
    // "sideways dengan nama lain".
    const quiet = adx !== null && adx < opts.rangingAdx;
    const absorbing = volState === 'EXPANDING' || (relVolume !== null && relVolume >= 1.2);

    if (quiet && absorbing && positionInRange !== null && positionInRange <= 0.35) {
      add('ACCUMULATION', [
        `ADX ${adx!.toFixed(1)} rendah (tanpa tren)`,
        'Volume tetap masuk meski harga datar',
        `Harga di ${(positionInRange * 100).toFixed(0)}% bawah rentang`,
      ]);
    }
    if (quiet && absorbing && positionInRange !== null && positionInRange >= 0.65) {
      add('DISTRIBUTION', [
        `ADX ${adx!.toFixed(1)} rendah (tanpa tren)`,
        'Volume tetap besar meski harga tidak naik',
        `Harga di ${(positionInRange * 100).toFixed(0)}% atas rentang`,
      ]);
    }

    // --- Volatilitas sebagai kandidat regime tersendiri -------------------
    if (volatility === 'HIGH_VOLATILITY') {
      const ev: string[] = [];
      if (atrRatio !== null) ev.push(`ATR ${atrRatio.toFixed(2)}x rata-ratanya`);
      if (indicators.volatility.state === 'EXPANDING') ev.push('ATR sedang melebar');
      if (indicators.volatility.atrPercent !== null && indicators.volatility.atrPercent > 4) {
        ev.push(`ATR ${indicators.volatility.atrPercent.toFixed(1)}% dari harga`);
      }
      add('HIGH_VOLATILITY', ev);
    }
    if (volatility === 'LOW_VOLATILITY') {
      const ev: string[] = [];
      if (atrRatio !== null) ev.push(`ATR hanya ${atrRatio.toFixed(2)}x rata-ratanya`);
      if (squeeze) ev.push('Bollinger dalam kondisi squeeze');
      if (indicators.volatility.state === 'CONTRACTING') ev.push('ATR sedang menyempit');
      add('LOW_VOLATILITY', ev);
    }

    // --- Pemilihan regime utama ------------------------------------------
    const ranked = [...candidates].sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length);

    // Hanya kandidat yang cukup bukti yang boleh menjadi regime utama.
    const eligible = ranked.filter((c) => c.evidence.length >= RegimeEngineService.MIN_EVIDENCE);
    const winner = eligible[0] ?? null;
    const runnerUp = eligible[1] ?? null;

    const regime: MarketRegimeType = winner?.regime ?? 'SIDEWAYS';
    const evidence = winner?.evidence ?? [
      'Tidak ada kondisi yang didukung cukup bukti - diperlakukan sebagai sideways',
    ];

    return {
      timeframe,
      barTime: indicators.barTime,
      regime,
      secondary: runnerUp && runnerUp.score >= (winner?.score ?? 0) * 0.75 ? runnerUp.regime : null,
      confidence: winner ? winner.score : 0.2,
      volatility,
      candidates: ranked,
      evidence,
      positionInRange,
    };
  }

  // --- Utilitas ------------------------------------------------------------

  private volatilityRegime(
    atrRatio: number | null,
    squeeze: boolean,
    opts: RegimeOptions,
  ): VolatilityRegime {
    if (atrRatio === null) return 'NORMAL_VOLATILITY';
    if (atrRatio >= opts.highVolatilityRatio) return 'HIGH_VOLATILITY';
    if (atrRatio <= opts.lowVolatilityRatio || squeeze) return 'LOW_VOLATILITY';
    return 'NORMAL_VOLATILITY';
  }

  /** Posisi close terakhir di antara terendah dan tertinggi `lookback` bar. */
  private positionInRange(candles: Candle[], lookback: number): number | null {
    if (candles.length < 5) return null;
    const window = candles.slice(-lookback);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));
    if (!(high > low)) return null;
    return clamp((window[window.length - 1].close - low) / (high - low), 0, 1);
  }
}
