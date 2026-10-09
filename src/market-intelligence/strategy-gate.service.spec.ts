import { StrategyGateService } from './strategy-gate.service';
import { MarketIntelligenceConfigService } from './mi-config.service';
import { MarketIntelligenceReport } from './market-intelligence.service';
import { TradingStrategy, StrategyIntelligenceProfile } from '../strategy/strategy.interface';

/** Konfigurasi palsu - hanya nilai yang dipakai gerbang. */
function fakeConfig(overrides: { enforce?: boolean; minScore?: number } = {}): any {
  const enforce = overrides.enforce ?? true;
  const minScore = overrides.minScore ?? 65;
  return {
    params: () => ({ enforce, noTrade: { minAtrPercent: 0.4 } }),
    minScoreFor: () => minScore,
  } as unknown as MarketIntelligenceConfigService;
}

function fakeStrategy(profile?: StrategyIntelligenceProfile): TradingStrategy {
  return {
    name: 'TEST_STRATEGY',
    description: 'strategi uji',
    minCandles: 60,
    intelligenceProfile: profile,
    evaluate: () => {
      throw new Error('tidak dipakai dalam test ini');
    },
  };
}

/** Laporan Market Intelligence minimal yang bisa ditimpa per test. */
function fakeReport(overrides: any = {}): MarketIntelligenceReport {
  const confluence = {
    pair: 'btcidr',
    timeframe: '1H',
    direction: 'LONG',
    score: 80,
    decision: 'HIGH_QUALITY_SETUP',
    regime: 'BULL_TREND',
    dimensions: [],
    breakdown: {},
    setup: null,
    reasons: [],
    blockers: [],
    riskFactors: [],
    executable: true,
    ...(overrides.confluence ?? {}),
  };

  const analysis = {
    timeframe: '1H',
    role: 'SETUP',
    bars: 300,
    barTime: 1000,
    bias: 'BULLISH',
    biasConfidence: 0.8,
    biasReasons: [],
    regime: { regime: 'BULL_TREND', volatility: 'NORMAL_VOLATILITY' },
    indicators: {
      momentum: { adx: 30, rsi14: 55, macd: {}, macdHistogramPrev: 0, stochastic: {} },
      volatility: { atrPercent: 1.5 },
      volume: { relativeVolume: 1.4 },
      price: { close: 100 },
      trend: {},
      ...(overrides.indicators ?? {}),
    },
    structure: {
      trend: 'BULLISH',
      latest: { BOS: { type: 'BOS', direction: 'BULLISH', price: 99, confidence: 0.8 } },
      onLastBar: [],
      ...(overrides.structure ?? {}),
    },
    levels: { positionInRange: 0.2, nearestSupport: null, nearestResistance: null, zones: [] },
    ...(overrides.analysis ?? {}),
  };

  const mtf = {
    pair: 'btcidr',
    asOf: 1000,
    timeframes: { '1H': analysis },
    missing: [],
    alignment: {
      score: 0.8,
      direction: 'BULLISH',
      aligned: ['1H'],
      conflicting: [],
      conflicts: [],
      ...(overrides.alignment ?? {}),
    },
    primaryTimeframe: '1H',
    executionTimeframe: '1H',
  };

  return {
    pair: 'btcidr',
    mtf,
    confluence,
    explanation: { headline: '', summary: {}, reasons: [], risks: [], blockers: [], text: '' },
  } as unknown as MarketIntelligenceReport;
}

describe('StrategyGateService', () => {
  it('mengizinkan entry saat semua syarat terpenuhi', () => {
    const gate = new StrategyGateService(fakeConfig());
    const decision = gate.evaluate(fakeStrategy(), fakeReport());
    expect(decision.allowed).toBe(true);
    expect(decision.rejections).toHaveLength(0);
  });

  it('menolak saat skor di bawah minimum strategi', () => {
    const gate = new StrategyGateService(fakeConfig({ minScore: 90 }));
    const decision = gate.evaluate(fakeStrategy(), fakeReport());
    expect(decision.allowed).toBe(false);
    expect(decision.rejections.join(' ')).toMatch(/di bawah minimum 90/);
  });

  it('meneruskan blocker dari No Trade Engine', () => {
    const gate = new StrategyGateService(fakeConfig());
    const decision = gate.evaluate(
      fakeStrategy(),
      fakeReport({ confluence: { blockers: ['Resistance hanya 0,5% dari entry'] } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rejections).toContain('Resistance hanya 0,5% dari entry');
  });

  it('menolak regime yang memusuhi strategi', () => {
    const gate = new StrategyGateService(fakeConfig());
    const profile: StrategyIntelligenceProfile = {
      favourableRegimes: ['BULL_TREND'],
      hostileRegimes: ['SIDEWAYS'],
      requires: [],
    };
    const decision = gate.evaluate(
      fakeStrategy(profile),
      fakeReport({ confluence: { regime: 'SIDEWAYS' } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rejections.join(' ')).toMatch(/SIDEWAYS/);
  });

  it('mencatat regime yang mendukung sebagai konfirmasi', () => {
    const gate = new StrategyGateService(fakeConfig());
    const profile: StrategyIntelligenceProfile = {
      favourableRegimes: ['BULL_TREND'],
      hostileRegimes: [],
      requires: [],
    };
    const decision = gate.evaluate(fakeStrategy(profile), fakeReport());
    expect(decision.confirmations.join(' ')).toMatch(/BULL_TREND mendukung/);
  });

  describe('konfirmasi wajib', () => {
    const withRequirement = (requires: any[]): StrategyIntelligenceProfile => ({
      favourableRegimes: [],
      hostileRegimes: [],
      requires,
    });

    it('TREND_ALIGNMENT menolak saat arah timeframe tidak searah', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['TREND_ALIGNMENT'])),
        fakeReport({ alignment: { direction: 'BEARISH', conflicts: ['4H vs 1H'] } }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/belum selaras/);
    });

    it('VOLUME_CONFIRMATION menolak saat volume di bawah rata-rata', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['VOLUME_CONFIRMATION'])),
        fakeReport({ indicators: { volume: { relativeVolume: 0.6 }, momentum: {}, volatility: { atrPercent: 1.5 }, price: { close: 100 }, trend: {} } }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/Volume hanya/);
    });

    it('VOLUME_CONFIRMATION tidak menolak saat volume tidak dapat diukur, tetapi memberi peringatan', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['VOLUME_CONFIRMATION'])),
        fakeReport({ indicators: { volume: { relativeVolume: null }, momentum: {}, volatility: { atrPercent: 1.5 }, price: { close: 100 }, trend: {} } }),
      );
      expect(decision.allowed).toBe(true);
      expect(decision.warnings.join(' ')).toMatch(/Konfirmasi volume dilewati/);
    });

    it('STRUCTURE_BREAK menolak bila tidak ada penembusan terkonfirmasi', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['STRUCTURE_BREAK'])),
        fakeReport({ structure: { trend: 'NEUTRAL', latest: {}, onLastBar: [] } }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/penembusan struktur/);
    });

    it('STRUCTURE_BREAK menerima BOS searah yang terkonfirmasi lewat close', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(fakeStrategy(withRequirement(['STRUCTURE_BREAK'])), fakeReport());
      expect(decision.allowed).toBe(true);
      expect(decision.confirmations.join(' ')).toMatch(/terkonfirmasi lewat close/);
    });

    it('RANGE_CONDITION menolak saat pasar sedang tren kuat', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['RANGE_CONDITION'])),
        fakeReport({
          confluence: { regime: 'BULL_TREND' },
          indicators: { momentum: { adx: 40 }, volatility: { atrPercent: 1.5 }, volume: { relativeVolume: 1.2 }, price: { close: 100 }, trend: {} },
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/bukan kondisi mean reversion/);
    });

    it('EXTREME_LOCATION menolak saat harga di tengah rentang', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['EXTREME_LOCATION'])),
        fakeReport({ analysis: { levels: { positionInRange: 0.5, zones: [] } } }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/bukan lokasi ekstrem/);
    });

    it('VOLATILITY_ROOM menolak saat ATR terlalu kecil untuk menutup fee', () => {
      const gate = new StrategyGateService(fakeConfig());
      const decision = gate.evaluate(
        fakeStrategy(withRequirement(['VOLATILITY_ROOM'])),
        fakeReport({ indicators: { volatility: { atrPercent: 0.1 }, momentum: {}, volume: { relativeVolume: 1.2 }, price: { close: 100 }, trend: {} } }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.rejections.join(' ')).toMatch(/terlalu kecil untuk menutup fee/);
    });
  });

  describe('mode observasi', () => {
    it('mengizinkan entry meski ada penolakan saat MI_ENFORCE=false', () => {
      const gate = new StrategyGateService(fakeConfig({ enforce: false, minScore: 99 }));
      const decision = gate.evaluate(fakeStrategy(), fakeReport());
      expect(decision.allowed).toBe(true);
      expect(decision.observeOnly).toBe(true);
      // Penolakan tetap dicatat - itulah bukti untuk mengevaluasi gerbang nanti.
      expect(decision.rejections.length).toBeGreaterThan(0);
    });

    it('benar-benar memblokir saat MI_ENFORCE=true', () => {
      const gate = new StrategyGateService(fakeConfig({ enforce: true, minScore: 99 }));
      const decision = gate.evaluate(fakeStrategy(), fakeReport());
      expect(decision.allowed).toBe(false);
      expect(decision.observeOnly).toBe(false);
    });
  });

  it('menolak arah SHORT karena tidak dapat dieksekusi di bursa spot', () => {
    const gate = new StrategyGateService(fakeConfig());
    const decision = gate.evaluate(
      fakeStrategy(),
      fakeReport({ confluence: { direction: 'SHORT', executable: false } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rejections.join(' ')).toMatch(/bursa spot/);
  });

  it('tidak pernah membuat sinyal baru - hanya mengembalikan izin atau penolakan', () => {
    const gate = new StrategyGateService(fakeConfig());
    const decision = gate.evaluate(fakeStrategy(), fakeReport());
    expect(Object.keys(decision).sort()).toEqual(
      ['allowed', 'confirmations', 'decision', 'minScore', 'observeOnly', 'rejections', 'score', 'warnings'].sort(),
    );
  });
});
