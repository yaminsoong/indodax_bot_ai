import { ConfluenceEngineService } from './confluence-engine.service';
import { DEFAULT_WEIGHTS } from './confluence.types';
import { MultiTimeframeService } from '../mtf/multi-timeframe.service';
import { IndicatorEngineService } from '../indicators/indicator-engine.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { SupportResistanceService } from '../levels/support-resistance.service';
import { RegimeEngineService } from '../regime/regime-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { MtfContext } from '../mtf/mtf.types';
import {
  bearishSet,
  bullishSet,
  conflictingSet,
  sidewaysSet,
} from '../../../test/fixtures/market-candles';

function buildMtf(): MultiTimeframeService {
  const technical = new TechnicalService();
  const structure = new StructureEngineService(technical);
  return new MultiTimeframeService(
    new IndicatorEngineService(technical),
    structure,
    new SupportResistanceService(structure),
    new RegimeEngineService(),
  );
}

describe('ConfluenceEngineService', () => {
  let engine: ConfluenceEngineService;
  let mtfService: MultiTimeframeService;
  let bullish: MtfContext;
  let bearish: MtfContext;
  let sideways: MtfContext;
  let conflicting: MtfContext;

  beforeAll(() => {
    mtfService = buildMtf();
    bullish = mtfService.build('btcidr', bullishSet());
    bearish = mtfService.build('btcidr', bearishSet());
    sideways = mtfService.build('btcidr', sidewaysSet());
    conflicting = mtfService.build('btcidr', conflictingSet());
  });

  beforeEach(() => {
    engine = new ConfluenceEngineService();
  });

  describe('bobot dan skala skor', () => {
    it('bobot default berjumlah tepat 100', () => {
      const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
      expect(total).toBe(100);
    });

    it('skor selalu berada di rentang 0-100', () => {
      for (const ctx of [bullish, bearish, sideways, conflicting]) {
        for (const dir of ['LONG', 'SHORT'] as const) {
          const res = engine.evaluate(ctx, dir);
          expect(res.score).toBeGreaterThanOrEqual(0);
          expect(res.score).toBeLessThanOrEqual(100);
        }
      }
    });

    it('menerima bobot kustom', () => {
      const res = engine.evaluate(bullish, 'LONG', {
        weights: { TREND_ALIGNMENT: 50, MOMENTUM: 5 },
      });
      const trend = res.dimensions.find((d) => d.dimension === 'TREND_ALIGNMENT')!;
      expect(trend.weight).toBe(50);
    });

    it('mendistribusikan ulang bobot dimensi yang tidak tersedia', () => {
      // Tanpa order book, dimensi ORDER_BOOK ditandai unavailable dan tidak
      // menyumbang - tetapi skor tetap pada skala 0-100.
      const res = engine.evaluate(bullish, 'LONG');
      const ob = res.dimensions.find((d) => d.dimension === 'ORDER_BOOK')!;
      expect(ob.unavailable).toBe(true);
      expect(ob.contribution).toBe(0);

      const sumContributions = res.dimensions.reduce((s, d) => s + d.contribution, 0);
      expect(Math.round(sumContributions)).toBe(res.score);
    });

    it('menilai order book saat datanya tersedia', () => {
      const res = engine.evaluate(bullish, 'LONG', {
        orderBook: { imbalance: 0.4, spreadPercent: 0.1, bidDepthIdr: 1e9, askDepthIdr: 5e8 },
      });
      const ob = res.dimensions.find((d) => d.dimension === 'ORDER_BOOK')!;
      expect(ob.unavailable).toBe(false);
      expect(ob.raw).toBeGreaterThan(50);
    });
  });

  describe('penilaian arah', () => {
    it('memberi skor tren jauh lebih tinggi untuk LONG di pasar bullish', () => {
      const long = engine.evaluate(bullish, 'LONG');
      const short = engine.evaluate(bullish, 'SHORT');
      expect(long.breakdown.TREND_ALIGNMENT).toBeGreaterThan(short.breakdown.TREND_ALIGNMENT);
    });

    it('menolak arah yang melawan keselarasan timeframe', () => {
      const short = engine.evaluate(bullish, 'SHORT');
      expect(short.decision).toBe('NO_TRADE');
      expect(short.blockers.join(' ')).toMatch(/melawan keselarasan/i);
    });

    it('menandai setup SHORT sebagai tidak dapat dieksekusi di bursa spot', () => {
      const short = engine.evaluate(bearish, 'SHORT');
      expect(short.executable).toBe(false);
      const long = engine.evaluate(bullish, 'LONG');
      expect(long.executable).toBe(true);
    });

    it('mengembalikan NO_TRADE untuk arah NONE', () => {
      const res = engine.evaluate(bullish, 'NONE');
      expect(res.decision).toBe('NO_TRADE');
      expect(res.blockers.length).toBeGreaterThan(0);
    });
  });

  describe('No Trade Engine', () => {
    it('menolak trade saat timeframe saling bertentangan', () => {
      const res = engine.evaluate(conflicting, 'LONG');
      expect(res.decision).toBe('NO_TRADE');
      expect(res.blockers.length).toBeGreaterThan(0);
    });

    it('menolak saat rasio imbalan/risiko di bawah minimum', () => {
      const res = engine.evaluate(bullish, 'LONG', {
        noTrade: { minRiskReward: 99 },
      });
      expect(res.decision).toBe('NO_TRADE');
      expect(res.blockers.join(' ')).toMatch(/imbalan\/risiko/i);
    });

    it('menolak saat volatilitas melampaui batas', () => {
      const res = engine.evaluate(bullish, 'LONG', {
        noTrade: { maxAtrPercent: 0.001 },
      });
      expect(res.blockers.join(' ')).toMatch(/Volatilitas ekstrem/i);
      expect(res.decision).toBe('NO_TRADE');
    });

    it('menolak saat volume terlalu sepi', () => {
      const res = engine.evaluate(bullish, 'LONG', {
        noTrade: { minRelativeVolume: 99 },
      });
      expect(res.blockers.join(' ')).toMatch(/Volume/i);
    });

    it('menolak saat resistance terlalu dekat dengan entry', () => {
      // Butuh pasar yang memang punya resistance di atas harga.
      const ctx = [sideways, bearish, conflicting].find(
        (c) => c.timeframes[c.primaryTimeframe]?.levels?.nearestResistance,
      )!;
      expect(ctx).toBeDefined();

      const res = engine.evaluate(ctx, 'LONG', {
        noTrade: { minResistanceDistancePercent: 99 },
      });
      expect(res.blockers.join(' ')).toMatch(/RESISTANCE/i);
      expect(res.decision).toBe('NO_TRADE');
    });

    it('tidak memunculkan blocker resistance saat harga berada di puncak tertinggi', () => {
      // Pada tren naik mulus tidak ada resistance di atas harga sama sekali;
      // ketiadaan zona bukan alasan menolak trade.
      const primary = bullish.timeframes[bullish.primaryTimeframe]!;
      expect(primary.levels!.nearestResistance).toBeNull();

      const res = engine.evaluate(bullish, 'LONG', {
        noTrade: { minResistanceDistancePercent: 99 },
      });
      expect(res.blockers.join(' ')).not.toMatch(/RESISTANCE hanya/i);
    });

    it('blocker selalu mengalahkan skor tinggi', () => {
      const clean = engine.evaluate(bullish, 'LONG');
      const blocked = engine.evaluate(bullish, 'LONG', { noTrade: { minRiskReward: 99 } });
      // Skor mentahnya boleh tetap tinggi, keputusannya tetap NO_TRADE.
      expect(blocked.decision).toBe('NO_TRADE');
      expect(blocked.blockers.length).toBeGreaterThan(0);
      expect(clean.score).toBeGreaterThan(0);
    });

    it('memberi alasan tekstual untuk setiap penolakan', () => {
      const res = engine.evaluate(conflicting, 'LONG');
      for (const blocker of res.blockers) {
        expect(typeof blocker).toBe('string');
        expect(blocker.length).toBeGreaterThan(10);
      }
    });
  });

  describe('trade setup', () => {
    it('menghitung stop di bawah entry dan target di atasnya untuk LONG', () => {
      const res = engine.evaluate(bullish, 'LONG');
      const setup = res.setup!;
      expect(setup.direction).toBe('LONG');
      expect(setup.stopLoss).toBeLessThan(setup.entryReference);
      expect(setup.takeProfit1).toBeGreaterThan(setup.entryReference);
      expect(setup.takeProfit2).toBeGreaterThan(setup.takeProfit1);
      expect(setup.takeProfit3).toBeGreaterThan(setup.takeProfit2);
      expect(setup.riskPerUnit).toBeGreaterThan(0);
    });

    it('menghitung stop di atas entry untuk SHORT', () => {
      const res = engine.evaluate(bearish, 'SHORT');
      const setup = res.setup!;
      expect(setup.stopLoss).toBeGreaterThan(setup.entryReference);
      expect(setup.takeProfit1).toBeLessThan(setup.entryReference);
    });

    it('menghasilkan rasio imbalan/risiko yang konsisten dengan target', () => {
      const res = engine.evaluate(bullish, 'LONG');
      const s = res.setup!;
      const expected = (s.takeProfit2 - s.entryReference) / s.riskPerUnit;
      expect(s.riskReward).toBeCloseTo(expected, 1);
      expect(s.riskRewardTp3).toBeGreaterThan(s.riskRewardTp1);
    });

    it('menyertakan dasar penentuan stop dan target', () => {
      const res = engine.evaluate(bullish, 'LONG');
      expect(res.setup!.stopBasis.length).toBeGreaterThan(5);
      expect(res.setup!.targetBasis.length).toBeGreaterThan(5);
    });

    it('tidak menghitung ukuran posisi - itu wewenang Risk Engine', () => {
      const res = engine.evaluate(bullish, 'LONG');
      expect(res.setup).not.toHaveProperty('positionSize');
      expect(res.setup).not.toHaveProperty('quantity');
      expect(JSON.stringify(res.setup)).not.toMatch(/quantity|positionSize|lot/i);
    });
  });

  describe('penjelasan', () => {
    it('menyertakan alasan positif pada setup bullish', () => {
      const res = engine.evaluate(bullish, 'LONG');
      expect(res.reasons.filter((r) => r.kind === 'POSITIVE').length).toBeGreaterThan(0);
    });

    it('memberi label dimensi pada setiap alasan', () => {
      const res = engine.evaluate(bullish, 'LONG');
      for (const r of res.reasons) {
        expect(r.dimension.length).toBeGreaterThan(0);
        expect(['POSITIVE', 'RISK', 'BLOCKER']).toContain(r.kind);
      }
    });

    it('mencatat faktor risiko terpisah dari alasan positif', () => {
      const res = engine.evaluate(sideways, 'LONG');
      expect(Array.isArray(res.riskFactors)).toBe(true);
    });

    it('menyertakan rincian skor per dimensi untuk audit', () => {
      const res = engine.evaluate(bullish, 'LONG');
      const keys = Object.keys(res.breakdown);
      expect(keys).toContain('TREND_ALIGNMENT');
      expect(keys).toContain('RISK_REWARD');
      expect(keys).toHaveLength(8);
    });
  });

  describe('pemetaan keputusan', () => {
    it('memakai ambang 50/65/80 sesuai spesifikasi', () => {
      const cases: Array<[number, string]> = [
        [0, 'NO_TRADE'],
        [49, 'NO_TRADE'],
        [50, 'WATCH'],
        [64, 'WATCH'],
        [65, 'TRADE_SETUP'],
        [79, 'TRADE_SETUP'],
        [80, 'HIGH_QUALITY_SETUP'],
        [100, 'HIGH_QUALITY_SETUP'],
      ];
      // decisionForScore diuji lewat modul tipe agar ambangnya tidak bergeser diam-diam.
      const { decisionForScore } = require('../market-intelligence.types');
      for (const [score, expected] of cases) {
        expect(decisionForScore(score)).toBe(expected);
      }
    });

    it('mengembalikan hasil kosong yang aman bila tidak ada timeframe', () => {
      const empty = mtfService.build('btcidr', {});
      const res = engine.evaluate(empty, 'LONG');
      expect(res.score).toBe(0);
      expect(res.decision).toBe('NO_TRADE');
      expect(res.setup).toBeNull();
    });
  });

  it('deterministik pada konteks yang sama', () => {
    const a = engine.evaluate(bullish, 'LONG');
    const b = engine.evaluate(bullish, 'LONG');
    expect(a.score).toBe(b.score);
    expect(JSON.stringify(a.breakdown)).toBe(JSON.stringify(b.breakdown));
  });
});
