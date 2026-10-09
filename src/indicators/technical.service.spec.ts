import { TechnicalService } from './technical.service';
import { Candle } from '../indodax/indodax.types';

/**
 * Indikator yang salah hitung merusak setiap keputusan di hilirnya dan hampir
 * mustahil terdeteksi dari log. Nilai acuan di sini dihitung manual dari
 * definisi baku masing-masing indikator.
 */
describe('TechnicalService', () => {
  let svc: TechnicalService;

  beforeEach(() => {
    svc = new TechnicalService();
  });

  // ─── EMA ────────────────────────────────────────────────────────────────

  describe('calculateEMA', () => {
    it('memakai SMA sebagai nilai awal', () => {
      const prices = [1, 2, 3, 4, 5];
      const ema = svc.calculateEMA(prices, 5);
      expect(ema).toHaveLength(1);
      expect(ema[0]).toBeCloseTo(3, 10); // SMA(1..5) = 3
    });

    it('menerapkan faktor pemulusan 2/(n+1)', () => {
      const prices = [1, 2, 3, 4, 5, 6];
      const ema = svc.calculateEMA(prices, 5);
      // seed 3, lalu 6*(2/6) + 3*(4/6) = 2 + 2 = 4
      expect(ema[1]).toBeCloseTo(4, 10);
    });

    it('mengembalikan array kosong bila data kurang dari periode', () => {
      expect(svc.calculateEMA([1, 2, 3], 5)).toEqual([]);
    });

    it('menghasilkan panjang length - period + 1', () => {
      const prices = Array.from({ length: 50 }, (_, i) => i + 1);
      expect(svc.calculateEMA(prices, 21)).toHaveLength(30);
    });

    it('konvergen ke nilai konstan pada harga datar', () => {
      const ema = svc.calculateEMA(Array(40).fill(100), 13);
      expect(ema[ema.length - 1]).toBeCloseTo(100, 8);
    });
  });

  // ─── RSI ────────────────────────────────────────────────────────────────

  describe('calculateRSI', () => {
    it('bernilai 100 saat seluruh perubahan positif', () => {
      const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
      const rsi = svc.calculateRSI(prices, 14);
      expect(rsi[rsi.length - 1]).toBeCloseTo(100, 6);
    });

    it('bernilai 0 saat seluruh perubahan negatif', () => {
      const prices = Array.from({ length: 20 }, (_, i) => 200 - i);
      const rsi = svc.calculateRSI(prices, 14);
      expect(rsi[rsi.length - 1]).toBeCloseTo(0, 6);
    });

    it('mendekati 50 saat naik-turun seimbang', () => {
      const prices: number[] = [];
      for (let i = 0; i < 40; i++) prices.push(100 + (i % 2 === 0 ? 0 : 1));
      const rsi = svc.calculateRSI(prices, 14);
      expect(rsi[rsi.length - 1]).toBeGreaterThan(40);
      expect(rsi[rsi.length - 1]).toBeLessThan(60);
    });

    it('cocok dengan hitungan manual pada deret Wilder klasik', () => {
      // Deret uji baku dari Wilder. Turunan manual untuk 14 perubahan pertama:
      //   total gain  = 3.34  → avgGain = 3.34/14 = 0.2385714
      //   total loss  = 1.40  → avgLoss = 1.40/14 = 0.1000000
      //   RS  = 2.3857143
      //   RSI = 100 - 100/(1+RS) = 70.464135
      const prices = [
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
        45.89, 46.03, 45.61, 46.28, 46.28,
      ];
      const rsi = svc.calculateRSI(prices, 14);
      expect(rsi[0]).toBeCloseTo(70.464135, 4);
    });

    it('selalu berada di rentang 0-100', () => {
      const prices = Array.from({ length: 100 }, () => 100 + Math.random() * 20);
      for (const v of svc.calculateRSI(prices, 14)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    });
  });

  // ─── ATR ────────────────────────────────────────────────────────────────

  describe('calculateATR', () => {
    it('sama dengan tinggi bar pada range konstan tanpa gap', () => {
      // Setiap bar: high-low = 10, tanpa gap → true range selalu 10.
      const candles = makeCandles(30, (i) => ({
        open: 100,
        high: 105,
        low: 95,
        close: 100,
      }));
      expect(svc.calculateATR(candles, 14)).toBeCloseTo(10, 6);
    });

    it('memperhitungkan gap antar bar', () => {
      const candles: Candle[] = [
        candle(0, 100, 102, 98, 100),
        // Gap naik: high 120 vs close sebelumnya 100 → TR = 20, bukan 4.
        candle(1, 118, 120, 116, 118),
      ];
      // Dengan hanya 2 candle dan period 1.
      expect(svc.calculateATR(candles, 1)).toBeCloseTo(20, 6);
    });

    it('mengembalikan 0 bila data kurang', () => {
      expect(svc.calculateATR(makeCandles(5, () => ({ open: 1, high: 2, low: 0, close: 1 })), 14)).toBe(0);
    });
  });

  // ─── ADX ────────────────────────────────────────────────────────────────

  describe('calculateADX', () => {
    it('tinggi pada tren naik yang mulus', () => {
      const candles = makeCandles(60, (i) => ({
        open: 100 + i * 2,
        high: 101 + i * 2,
        low: 99 + i * 2,
        close: 100.5 + i * 2,
      }));
      expect(svc.calculateADX(candles, 14)).toBeGreaterThan(40);
    });

    it('rendah pada pasar sideways', () => {
      // Bolak-balik dalam rentang sempit — inilah kondisi yang harus disaring.
      const candles = makeCandles(60, (i) => {
        const base = 100 + (i % 2 === 0 ? 0 : 0.5);
        return { open: base, high: base + 0.5, low: base - 0.5, close: base };
      });
      expect(svc.calculateADX(candles, 14)).toBeLessThan(25);
    });

    it('mengembalikan 0 bila data kurang dari 2*period+1', () => {
      expect(svc.calculateADX(makeCandles(20, () => ({ open: 1, high: 2, low: 0, close: 1 })), 14)).toBe(0);
    });
  });

  // ─── Choppiness ─────────────────────────────────────────────────────────

  describe('calculateChoppiness', () => {
    it('rendah pada tren terarah', () => {
      const candles = makeCandles(40, (i) => ({
        open: 100 + i * 3,
        high: 101 + i * 3,
        low: 99 + i * 3,
        close: 100.5 + i * 3,
      }));
      expect(svc.calculateChoppiness(candles, 14)).toBeLessThan(45);
    });

    it('tinggi saat harga berputar di rentang yang sama', () => {
      const candles = makeCandles(40, (i) => {
        const base = 100 + Math.sin(i) * 2;
        return { open: base, high: base + 2, low: base - 2, close: base };
      });
      expect(svc.calculateChoppiness(candles, 14)).toBeGreaterThan(55);
    });
  });

  // ─── Crossover ──────────────────────────────────────────────────────────

  describe('detectCrossover', () => {
    it('mengenali golden cross', () => {
      expect(svc.detectCrossover([9, 11], [10, 10])).toBe('GOLDEN');
    });

    it('mengenali death cross', () => {
      expect(svc.detectCrossover([11, 9], [10, 10])).toBe('DEATH');
    });

    it('tidak melaporkan crossover bila jarak hanya menyempit', () => {
      expect(svc.detectCrossover([12, 11], [10, 10])).toBe('NONE');
    });

    it('menangani seri dengan panjang berbeda tanpa salah indeks', () => {
      // EMA5 selalu lebih panjang dari EMA13 pada input yang sama.
      const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
      const ema5 = svc.calculateEMA(closes, 5);
      const ema13 = svc.calculateEMA(closes, 13);
      expect(ema5.length).toBeGreaterThan(ema13.length);
      expect(['GOLDEN', 'DEATH', 'NONE']).toContain(svc.detectCrossover(ema5, ema13));
    });
  });

  describe('barsSinceCrossover', () => {
    it('mengembalikan 0 bila crossover terjadi pada bar terakhir', () => {
      expect(svc.barsSinceCrossover([9, 11], [10, 10], 'GOLDEN')).toBe(0);
    });

    it('mengembalikan -1 bila tidak ada crossover dalam jendela', () => {
      expect(svc.barsSinceCrossover([11, 12, 13], [10, 10, 10], 'GOLDEN', 2)).toBe(-1);
    });
  });

  // ─── Tren & struktur ────────────────────────────────────────────────────

  describe('detectTrend', () => {
    it('BULLISH saat 5 > 13 > 21', () => {
      expect(svc.detectTrend([12], [11], [10])).toBe('BULLISH');
    });
    it('BEARISH saat 5 < 13 < 21', () => {
      expect(svc.detectTrend([10], [11], [12])).toBe('BEARISH');
    });
    it('NEUTRAL saat susunan campur', () => {
      expect(svc.detectTrend([12], [10], [11])).toBe('NEUTRAL');
    });
  });

  describe('findSwingLow', () => {
    it('menemukan titik pivot terendah terbaru', () => {
      const lows = [100, 98, 95, 97, 99, 101, 103];
      const candles = lows.map((low, i) => candle(i, low + 2, low + 4, low, low + 2));
      // Pivot di indeks 2 (95) dengan lookback 2.
      expect(svc.findSwingLow(candles, 2)).toBe(95);
    });

    it('jatuh ke harga terendah bila tidak ada pivot', () => {
      const candles = makeCandles(10, (i) => ({
        open: 100 - i,
        high: 101 - i,
        low: 99 - i,
        close: 100 - i,
      }));
      // Menurun monoton — tidak ada pivot, ambil low terendah.
      expect(svc.findSwingLow(candles, 2)).toBe(90);
    });
  });

  // ─── Order book ─────────────────────────────────────────────────────────

  describe('analyzeOrderBook', () => {
    it('menghitung imbalance positif saat sisi beli lebih tebal', () => {
      const m = svc.analyzeOrderBook({
        buy: [[100, 10]],
        sell: [[101, 2]],
      });
      expect(m.imbalance).toBeGreaterThan(0);
      expect(m.bidDepthIdr).toBeCloseTo(1000);
      expect(m.askDepthIdr).toBeCloseTo(202);
    });

    it('menghitung spread dalam persen', () => {
      const m = svc.analyzeOrderBook({ buy: [[100, 1]], sell: [[101, 1]] });
      expect(m.spreadPercent).toBeCloseTo(1, 6);
    });

    it('tidak pecah pada order book kosong', () => {
      const m = svc.analyzeOrderBook({ buy: [], sell: [] });
      expect(m.imbalance).toBe(0);
      expect(m.spreadPercent).toBe(0);
    });
  });

  // ─── Analisis lengkap ───────────────────────────────────────────────────

  describe('analyze', () => {
    it('mengembalikan null bila candle kurang dari 50', () => {
      expect(svc.analyze(makeCandles(30, () => ({ open: 1, high: 2, low: 0, close: 1 })))).toBeNull();
    });

    it('mengisi seluruh indikator pada data memadai', () => {
      const candles = makeCandles(100, (i) => {
        const base = 100 + Math.sin(i / 5) * 10 + i * 0.2;
        return { open: base, high: base + 1, low: base - 1, close: base + 0.3 };
      });
      const r = svc.analyze(candles)!;

      expect(r).not.toBeNull();
      expect(r.ema5.length).toBeGreaterThan(0);
      expect(r.ema50.length).toBeGreaterThan(0);
      expect(r.atr).toBeGreaterThan(0);
      expect(r.atrPercent).toBeGreaterThan(0);
      expect(r.adx).toBeGreaterThanOrEqual(0);
      expect(r.choppiness).toBeGreaterThan(0);
      expect(r.bollinger.upper).toBeGreaterThan(r.bollinger.lower);
      expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(r.trend);
      expect(['TRENDING', 'RANGING', 'VOLATILE']).toContain(r.regime);
    });
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────

function candle(i: number, open: number, high: number, low: number, close: number): Candle {
  return { time: 1_700_000_000 + i * 900, open, high, low, close, volume: 1000 };
}

function makeCandles(
  n: number,
  fn: (i: number) => { open: number; high: number; low: number; close: number },
): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { time: 1_700_000_000 + i * 900, volume: 1000, ...c };
  });
}
