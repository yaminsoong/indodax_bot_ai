import { RegimeEngineService } from './regime-engine.service';
import { IndicatorEngineService } from '../indicators/indicator-engine.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { Candle } from '../../indodax/indodax.types';
import { IndicatorReport } from '../indicators/indicator.types';

function bar(i: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { time: i * 3600, open: o, high: h, low: l, close: c, volume: v };
}

/** Indikator kosong yang bisa ditimpa sebagian - agar test fokus pada satu aspek. */
function baseIndicators(overrides: any = {}): IndicatorReport {
  const base: IndicatorReport = {
    timeframe: '1H',
    barTime: 1000,
    bars: 300,
    trend: {
      ema9: null,
      ema21: null,
      ema50: null,
      ema200: null,
      sma50: null,
      sma200: null,
      emaStack: 'NEUTRAL',
      priceVsEma200Percent: null,
      maCross: 'NONE',
    },
    momentum: {
      rsi14: 50,
      macd: { macd: 0, signal: 0, histogram: 0 },
      macdHistogramPrev: 0,
      stochastic: { k: 50, d: 50 },
      adx: 10,
      plusDi: 20,
      minusDi: 20,
    },
    volatility: {
      atr14: 10,
      atrPercent: 1,
      atrRatio: 1,
      bollinger: { upper: null, middle: null, lower: null, widthPercent: null, percentB: null },
      squeeze: false,
      state: 'STABLE',
    },
    volume: { volume: 100, volumeMa20: 100, relativeVolume: 1, spike: false, state: 'STABLE' },
    price: { close: 100, high: 101, low: 99, vwap: null, vwapDistancePercent: null },
    unavailable: [],
  };
  return {
    ...base,
    ...overrides,
    trend: { ...base.trend, ...(overrides.trend ?? {}) },
    momentum: { ...base.momentum, ...(overrides.momentum ?? {}) },
    volatility: { ...base.volatility, ...(overrides.volatility ?? {}) },
    volume: { ...base.volume, ...(overrides.volume ?? {}) },
    price: { ...base.price, ...(overrides.price ?? {}) },
  };
}

const flatCandles = Array.from({ length: 60 }, (_, i) => bar(i, 100, 101, 99, 100));

describe('RegimeEngineService', () => {
  let regimeEngine: RegimeEngineService;
  let indicatorEngine: IndicatorEngineService;
  let structureEngine: StructureEngineService;

  beforeEach(() => {
    const technical = new TechnicalService();
    regimeEngine = new RegimeEngineService();
    indicatorEngine = new IndicatorEngineService(technical);
    structureEngine = new StructureEngineService(technical);
  });

  it('tidak menetapkan tren hanya dari ADX tinggi tanpa bukti lain', () => {
    const ind = baseIndicators({ momentum: { adx: 35, plusDi: 20, minusDi: 20 } });
    const report = regimeEngine.analyze('1H', ind, null, flatCandles);
    // ADX saja = satu bukti; minimum dua diperlukan.
    expect(report.regime).not.toBe('BULL_TREND');
    expect(report.regime).not.toBe('BEAR_TREND');
  });

  it('menetapkan BULL_TREND saat ADX, DI, EMA, dan struktur sepakat', () => {
    const ind = baseIndicators({
      momentum: { adx: 32, plusDi: 34, minusDi: 12 },
      trend: { emaStack: 'BULLISH', priceVsEma200Percent: 8 },
    });
    const structure: any = { trend: 'BULLISH', onLastBar: [], events: [] };
    const report = regimeEngine.analyze('1H', ind, structure, flatCandles);
    expect(report.regime).toBe('BULL_TREND');
    expect(report.evidence.length).toBeGreaterThanOrEqual(2);
    expect(report.confidence).toBeGreaterThan(0.5);
  });

  it('menetapkan BEAR_TREND saat seluruh bukti menunjuk ke bawah', () => {
    const ind = baseIndicators({
      momentum: { adx: 30, plusDi: 10, minusDi: 33 },
      trend: { emaStack: 'BEARISH', priceVsEma200Percent: -6 },
    });
    const structure: any = { trend: 'BEARISH', onLastBar: [], events: [] };
    const report = regimeEngine.analyze('1H', ind, structure, flatCandles);
    expect(report.regime).toBe('BEAR_TREND');
  });

  it('menetapkan SIDEWAYS pada pasar tanpa arah', () => {
    const ind = baseIndicators({ momentum: { adx: 12, plusDi: 18, minusDi: 19 } });
    const structure: any = { trend: 'NEUTRAL', onLastBar: [], events: [] };
    const report = regimeEngine.analyze('1H', ind, structure, flatCandles);
    expect(report.regime).toBe('SIDEWAYS');
  });

  it('menetapkan BREAKOUT saat event struktur bullish disertai volume', () => {
    const ind = baseIndicators({
      volume: { volume: 300, volumeMa20: 100, relativeVolume: 3, spike: true, state: 'EXPANDING' },
      volatility: { state: 'EXPANDING', atrRatio: 1.2 },
    });
    const structure: any = {
      trend: 'NEUTRAL',
      events: [],
      onLastBar: [{ type: 'BREAKOUT', direction: 'BULLISH', confidence: 0.8 }],
    };
    const report = regimeEngine.analyze('1H', ind, structure, flatCandles);
    expect(report.regime).toBe('BREAKOUT');
  });

  it('menandai HIGH_VOLATILITY pada sumbu volatilitas terpisah', () => {
    const ind = baseIndicators({
      momentum: { adx: 30, plusDi: 34, minusDi: 12 },
      trend: { emaStack: 'BULLISH', priceVsEma200Percent: 5 },
      volatility: { atrRatio: 2.2, atrPercent: 6, state: 'EXPANDING' },
    });
    const structure: any = { trend: 'BULLISH', onLastBar: [], events: [] };
    const report = regimeEngine.analyze('1H', ind, structure, flatCandles);
    // Tren tetap menjadi regime utama, volatilitas dilaporkan terpisah.
    expect(report.regime).toBe('BULL_TREND');
    expect(report.volatility).toBe('HIGH_VOLATILITY');
  });

  it('menandai LOW_VOLATILITY saat ATR menyusut dan band menyempit', () => {
    const ind = baseIndicators({
      volatility: { atrRatio: 0.5, squeeze: true, state: 'CONTRACTING' },
    });
    const report = regimeEngine.analyze('1H', ind, null, flatCandles);
    expect(report.volatility).toBe('LOW_VOLATILITY');
  });

  it('mengenali ACCUMULATION di dasar rentang dengan volume masuk', () => {
    const candles = [
      ...Array.from({ length: 40 }, (_, i) => bar(i, 150, 160, 140, 150)),
      ...Array.from({ length: 10 }, (_, i) => bar(40 + i, 141, 143, 140, 141)),
    ];
    const ind = baseIndicators({
      momentum: { adx: 12, plusDi: 18, minusDi: 19 },
      volume: { volume: 200, volumeMa20: 100, relativeVolume: 2, spike: true, state: 'EXPANDING' },
    });
    const report = regimeEngine.analyze('1H', ind, null, candles);
    expect(report.candidates.map((c) => c.regime)).toContain('ACCUMULATION');
    expect(report.positionInRange!).toBeLessThan(0.35);
  });

  it('mengenali DISTRIBUTION di puncak rentang dengan volume besar tanpa kenaikan', () => {
    const candles = [
      ...Array.from({ length: 40 }, (_, i) => bar(i, 150, 160, 140, 150)),
      ...Array.from({ length: 10 }, (_, i) => bar(40 + i, 158, 160, 157, 159)),
    ];
    const ind = baseIndicators({
      momentum: { adx: 12, plusDi: 19, minusDi: 18 },
      volume: { volume: 200, volumeMa20: 100, relativeVolume: 2, spike: true, state: 'EXPANDING' },
    });
    const report = regimeEngine.analyze('1H', ind, null, candles);
    expect(report.candidates.map((c) => c.regime)).toContain('DISTRIBUTION');
    expect(report.positionInRange!).toBeGreaterThan(0.65);
  });

  it('bekerja dengan indikator dan struktur yang dihitung dari candle nyata', () => {
    const candles = Array.from({ length: 260 }, (_, i) =>
      bar(i, 1000 + i * 5, 1000 + i * 5 + 8, 1000 + i * 5 - 8, 1000 + i * 5 + 4, 100 + (i % 6) * 10),
    );
    const ind = indicatorEngine.analyze('4H', candles)!;
    const structure = structureEngine.analyze('4H', candles);
    const report = regimeEngine.analyze('4H', ind, structure, candles);
    expect(report.regime).toBe('BULL_TREND');
    expect(report.barTime).toBe(ind.barTime);
  });

  it('selalu menyertakan bukti untuk regime yang dipilih', () => {
    const ind = baseIndicators();
    const report = regimeEngine.analyze('1H', ind, null, flatCandles);
    expect(report.evidence.length).toBeGreaterThan(0);
  });
});
