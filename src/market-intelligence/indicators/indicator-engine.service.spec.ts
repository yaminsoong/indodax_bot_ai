import { IndicatorEngineService, DEFAULT_THRESHOLDS } from './indicator-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { Candle } from '../../indodax/indodax.types';

/** Candle sintetis dengan kontrol penuh atas OHLCV. */
function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

/** Deret naik mulus: close bertambah `step` tiap bar. */
function uptrend(n: number, start = 1000, step = 10, volume = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step;
    return candle(i * 3600, close - step / 2, close + step / 4, close - step, close, volume);
  });
}

/** Deret datar sempurna. */
function flat(n: number, price = 1000, volume = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i * 3600, price, price, price, price, volume));
}

describe('IndicatorEngineService', () => {
  let engine: IndicatorEngineService;

  beforeEach(() => {
    engine = new IndicatorEngineService(new TechnicalService());
  });

  describe('calculateStochastic', () => {
    it('mendekati 100 saat close berada di puncak rentang', () => {
      const { k } = engine.calculateStochastic(uptrend(40));
      expect(k).not.toBeNull();
      expect(k!).toBeGreaterThan(85);
    });

    it('mendekati 0 saat close berada di dasar rentang', () => {
      const bars: Candle[] = Array.from({ length: 40 }, (_, i) => {
        const close = 2000 - i * 10;
        return candle(i * 3600, close + 5, close + 10, close - 2, close);
      });
      const { k } = engine.calculateStochastic(bars);
      expect(k).not.toBeNull();
      expect(k!).toBeLessThan(15);
    });

    it('bernilai netral 50 pada harga benar-benar datar, bukan 0 atau 100', () => {
      const { k } = engine.calculateStochastic(flat(40));
      expect(k).toBe(50);
    });

    it('mengembalikan null bila data kurang', () => {
      expect(engine.calculateStochastic(flat(5))).toEqual({ k: null, d: null });
    });
  });

  describe('calculateVWAP', () => {
    it('sama dengan harga saat seluruh candle berharga sama', () => {
      const bars = flat(10, 500);
      expect(engine.calculateVWAP(bars)).toBeCloseTo(500, 6);
    });

    it('memberi bobot lebih besar pada candle bervolume besar', () => {
      const day = 86400;
      const bars = [
        candle(day, 100, 100, 100, 100, 1),
        candle(day + 3600, 200, 200, 200, 200, 99),
      ];
      // Rata-rata sederhana = 150; tertimbang volume jauh lebih dekat ke 200.
      expect(engine.calculateVWAP(bars)!).toBeCloseTo(199, 0);
    });

    it('hanya memakai candle sesi hari berjalan', () => {
      const bars = [
        candle(0, 100, 100, 100, 100, 1000), // hari sebelumnya
        candle(86400, 500, 500, 500, 500, 10),
      ];
      expect(engine.calculateVWAP(bars)).toBeCloseTo(500, 6);
    });

    it('mengembalikan null bila sesi tidak punya volume sama sekali', () => {
      expect(engine.calculateVWAP([candle(86400, 10, 10, 10, 10, 0)])).toBeNull();
    });
  });

  describe('volumeState', () => {
    it('EXPANDING saat volume paruh terakhir jauh lebih besar', () => {
      const bars = [...flat(20, 1000, 100), ...flat(20, 1000, 300)].map((c, i) => ({
        ...c,
        time: i * 3600,
      }));
      expect(engine.volumeState(bars)).toBe('EXPANDING');
    });

    it('CONTRACTING saat volume mengering', () => {
      const bars = [...flat(20, 1000, 300), ...flat(20, 1000, 100)].map((c, i) => ({
        ...c,
        time: i * 3600,
      }));
      expect(engine.volumeState(bars)).toBe('CONTRACTING');
    });

    it('STABLE bila data belum cukup untuk membandingkan dua paruh', () => {
      expect(engine.volumeState(flat(10))).toBe('STABLE');
    });
  });

  describe('analyze', () => {
    it('mengembalikan null pada candle kosong', () => {
      expect(engine.analyze('1H', [])).toBeNull();
    });

    it('menandai indikator yang belum bisa dihitung sebagai null, bukan 0', () => {
      const report = engine.analyze('1H', uptrend(60))!;
      expect(report.trend.ema50).not.toBeNull();
      // 60 bar tidak cukup untuk EMA/SMA 200.
      expect(report.trend.ema200).toBeNull();
      expect(report.trend.sma200).toBeNull();
      expect(report.trend.priceVsEma200Percent).toBeNull();
      expect(report.unavailable.some((u) => u.startsWith('EMA200'))).toBe(true);
    });

    it('mengenali susunan EMA bullish pada tren naik', () => {
      const report = engine.analyze('1H', uptrend(250))!;
      expect(report.trend.emaStack).toBe('BULLISH');
      expect(report.trend.ema200).not.toBeNull();
      expect(report.trend.maCross).toBe('GOLDEN');
      expect(report.momentum.plusDi!).toBeGreaterThan(report.momentum.minusDi!);
    });

    it('mengenali susunan EMA bearish pada tren turun', () => {
      const bars: Candle[] = Array.from({ length: 250 }, (_, i) => {
        const close = 5000 - i * 10;
        return candle(i * 3600, close + 5, close + 8, close - 10, close);
      });
      const report = engine.analyze('1H', bars)!;
      expect(report.trend.emaStack).toBe('BEARISH');
      expect(report.trend.maCross).toBe('DEATH');
      expect(report.momentum.minusDi!).toBeGreaterThan(report.momentum.plusDi!);
    });

    it('memakai candle terakhir sebagai acuan waktu dan harga', () => {
      const bars = uptrend(120);
      const report = engine.analyze('15m', bars)!;
      expect(report.barTime).toBe(bars[bars.length - 1].time);
      expect(report.price.close).toBe(bars[bars.length - 1].close);
      expect(report.timeframe).toBe('15m');
      expect(report.bars).toBe(120);
    });

    it('deterministik: dua pemanggilan pada data sama menghasilkan hasil sama', () => {
      const bars = uptrend(150);
      expect(JSON.stringify(engine.analyze('1H', bars))).toBe(
        JSON.stringify(engine.analyze('1H', bars)),
      );
    });

    it('tidak terpengaruh candle sesudahnya (tanpa look-ahead)', () => {
      const bars = uptrend(160);
      const early = engine.analyze('1H', bars.slice(0, 120))!;
      const withFuture = engine.analyze('1H', bars)!;
      const recomputed = engine.analyze('1H', bars.slice(0, 120))!;
      expect(JSON.stringify(early)).toBe(JSON.stringify(recomputed));
      expect(withFuture.barTime).not.toBe(early.barTime);
    });

    it('menandai lonjakan volume pada candle terakhir', () => {
      const bars = flat(40, 1000, 100).map((c, i) => ({ ...c, time: i * 3600 }));
      bars[bars.length - 1].volume = 500;
      const report = engine.analyze('1H', bars)!;
      expect(report.volume.spike).toBe(true);
      expect(report.volume.relativeVolume!).toBeGreaterThan(DEFAULT_THRESHOLDS.volumeSpikeRatio);
    });

    it('tidak menandai lonjakan pada volume normal', () => {
      const report = engine.analyze('1H', flat(40, 1000, 100))!;
      expect(report.volume.spike).toBe(false);
      expect(report.volume.relativeVolume!).toBeCloseTo(1, 6);
    });

    it('mendeteksi squeeze pada pasar yang menyempit tajam', () => {
      const noisy: Candle[] = Array.from({ length: 80 }, (_, i) => {
        const close = 1000 + (i % 2 === 0 ? 40 : -40);
        return candle(i * 3600, close, close + 40, close - 40, close);
      });
      const calm: Candle[] = Array.from({ length: 40 }, (_, i) => {
        const close = 1000 + (i % 2 === 0 ? 0.5 : -0.5);
        return candle((80 + i) * 3600, close, close + 0.5, close - 0.5, close);
      });
      const report = engine.analyze('1H', [...noisy, ...calm])!;
      expect(report.volatility.squeeze).toBe(true);
    });

    it('menghitung persen-B di dalam rentang 0-1 pada data normal', () => {
      const report = engine.analyze('1H', uptrend(120))!;
      expect(report.volatility.bollinger.percentB).not.toBeNull();
      expect(report.volatility.bollinger.percentB!).toBeGreaterThan(0.5);
    });
  });
});
