import { StructureEngineService } from './structure-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { Candle } from '../../indodax/indodax.types';

function bar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { time: i * 3600, open, high, low, close, volume };
}

/** Candle biasa dengan sumbu kecil di sekitar `close`. */
function plain(i: number, close: number, volume = 100): Candle {
  return bar(i, close, close + 1, close - 1, close, volume);
}

describe('StructureEngineService', () => {
  let engine: StructureEngineService;

  beforeEach(() => {
    engine = new StructureEngineService(new TechnicalService());
  });

  describe('findSwings', () => {
    it('menemukan pivot high dan pivot low', () => {
      const candles = [
        plain(0, 100),
        plain(1, 101),
        bar(2, 102, 120, 101, 103), // pivot high
        plain(3, 102),
        plain(4, 101),
        bar(5, 100, 101, 80, 90), // pivot low
        plain(6, 95),
        plain(7, 98),
      ];
      const swings = engine.findSwings(candles, 2);
      expect(swings.map((s) => s.type)).toEqual(['HIGH', 'LOW']);
      expect(swings[0].price).toBe(120);
      expect(swings[1].price).toBe(80);
    });

    it('menandai pivot baru terkonfirmasi setelah lookback candle berikutnya', () => {
      const candles = [
        plain(0, 100),
        plain(1, 101),
        bar(2, 102, 120, 101, 103),
        plain(3, 102),
        plain(4, 101),
        plain(5, 100),
        plain(6, 99),
      ];
      const [swing] = engine.findSwings(candles, 2);
      expect(swing.index).toBe(2);
      // Konfirmasi baru terjadi 2 candle kemudian - bukan pada candle pivot.
      expect(swing.confirmedAtIndex).toBe(4);
      expect(swing.confirmedAtTime).toBe(candles[4].time);
    });

    it('tidak melaporkan pivot yang belum punya cukup candle di kanan', () => {
      const candles = [plain(0, 100), plain(1, 101), bar(2, 102, 130, 101, 103), plain(3, 102)];
      // Pivot di indeks 2 butuh 2 candle di kanan; hanya ada 1.
      expect(engine.findSwings(candles, 2)).toEqual([]);
    });

    it('memberi label HH/HL pada struktur naik', () => {
      const candles: Candle[] = [];
      let idx = 0;
      const push = (c: Candle) => candles.push(c);
      // low 90 -> high 110 -> low 100 -> high 125
      push(plain(idx++, 95));
      push(plain(idx++, 93));
      push(bar(idx++, 92, 93, 90, 92));
      push(plain(idx++, 95));
      push(plain(idx++, 100));
      push(bar(idx++, 105, 110, 104, 108));
      push(plain(idx++, 106));
      push(plain(idx++, 103));
      push(bar(idx++, 101, 102, 100, 101));
      push(plain(idx++, 105));
      push(plain(idx++, 112));
      push(bar(idx++, 118, 125, 117, 122));
      push(plain(idx++, 120));
      push(plain(idx++, 118));

      const swings = engine.findSwings(candles, 2);
      const labels = swings.map((s) => `${s.type}:${s.label}`);
      expect(labels).toContain('LOW:HL');
      expect(labels).toContain('HIGH:HH');
    });
  });

  describe('structureTrend', () => {
    it('BULLISH bila dua label naik mendominasi', () => {
      const swings = [
        { label: 'HL' } as any,
        { label: 'HH' } as any,
        { label: 'HL' } as any,
        { label: 'HH' } as any,
      ];
      expect(engine.structureTrend(swings)).toBe('BULLISH');
    });

    it('BEARISH bila dua label turun mendominasi', () => {
      const swings = [{ label: 'LH' } as any, { label: 'LL' } as any];
      expect(engine.structureTrend(swings)).toBe('BEARISH');
    });

    it('NEUTRAL bila hanya satu label searah', () => {
      const swings = [{ label: 'HH' } as any, { label: 'LL' } as any];
      expect(engine.structureTrend(swings)).toBe('NEUTRAL');
    });
  });

  describe('analyze', () => {
    it('mengembalikan null bila candle terlalu sedikit', () => {
      expect(engine.analyze('1H', [plain(0, 100), plain(1, 101)])).toBeNull();
    });

    it('mencatat BOS saat CLOSE menembus swing high', () => {
      const candles: Candle[] = [];
      let i = 0;
      candles.push(plain(i++, 100));
      candles.push(plain(i++, 101));
      candles.push(bar(i++, 102, 110, 101, 103)); // pivot high 110
      candles.push(plain(i++, 102));
      candles.push(plain(i++, 101)); // pivot terkonfirmasi di sini
      candles.push(plain(i++, 105));
      candles.push(bar(i++, 108, 116, 107, 115, 300)); // close 115 > 110
      candles.push(plain(i++, 114));
      candles.push(plain(i++, 113));
      candles.push(plain(i++, 114));

      const report = engine.analyze('1H', candles, { rangeLookback: 5 })!;
      const bos = report.events.filter((e) => e.type === 'BOS' || e.type === 'CHOCH');
      expect(bos.length).toBeGreaterThan(0);
      expect(bos[0].direction).toBe('BULLISH');
      expect(bos[0].price).toBe(110);
      expect(bos[0].timestamp).toBe(candles[6].time);
      expect(bos[0].confidence).toBeGreaterThan(0);
      expect(bos[0].confidence).toBeLessThanOrEqual(0.95);
    });

    it('menganggap wick yang menembus tanpa close sebagai LIQUIDITY_SWEEP, bukan breakout', () => {
      const candles: Candle[] = [];
      let i = 0;
      candles.push(plain(i++, 100));
      candles.push(plain(i++, 101));
      candles.push(bar(i++, 102, 110, 101, 103)); // pivot high 110
      candles.push(plain(i++, 102));
      candles.push(plain(i++, 101));
      candles.push(plain(i++, 103));
      candles.push(bar(i++, 105, 118, 104, 106, 400)); // wick tembus, close 106 < 110
      candles.push(plain(i++, 105));
      candles.push(plain(i++, 104));
      candles.push(plain(i++, 105));

      const report = engine.analyze('1H', candles, { rangeLookback: 5 })!;
      const sweeps = report.events.filter((e) => e.type === 'LIQUIDITY_SWEEP');
      const breaks = report.events.filter((e) => e.type === 'BOS' || e.type === 'BREAKOUT');
      expect(sweeps.length).toBeGreaterThan(0);
      expect(sweeps[0].direction).toBe('BEARISH');
      expect(breaks).toHaveLength(0);
    });

    it('mencatat FAILED_BREAKOUT saat harga cepat kembali ke bawah level', () => {
      const candles: Candle[] = [];
      let i = 0;
      for (; i < 22; i++) candles.push(plain(i, 100 + (i % 2)));
      candles.push(bar(i++, 101, 112, 100, 110, 400)); // breakout rentang
      candles.push(bar(i++, 109, 110, 95, 96, 400)); // close kembali di bawah
      candles.push(plain(i++, 97));

      const report = engine.analyze('1H', candles, { rangeLookback: 20 })!;
      expect(report.events.some((e) => e.type === 'BREAKOUT')).toBe(true);
      expect(report.events.some((e) => e.type === 'FAILED_BREAKOUT')).toBe(true);
    });

    it('mencatat RETEST saat harga kembali ke level lalu bertahan', () => {
      const candles: Candle[] = [];
      let i = 0;
      for (; i < 22; i++) candles.push(plain(i, 100 + (i % 2)));
      candles.push(bar(i++, 101, 112, 100, 110, 400)); // breakout level ~102
      candles.push(bar(i++, 110, 111, 102, 105, 200)); // turun menyentuh level, close di atas
      candles.push(plain(i++, 107));

      const report = engine.analyze('1H', candles, { rangeLookback: 20 })!;
      expect(report.events.some((e) => e.type === 'RETEST')).toBe(true);
    });

    it('tidak menghasilkan event dengan timestamp melampaui candle terakhir', () => {
      const candles = Array.from({ length: 80 }, (_, i) =>
        bar(i, 100 + i, 100 + i + 3, 100 + i - 3, 100 + i + 1, 100 + (i % 7) * 20),
      );
      const report = engine.analyze('4H', candles)!;
      const lastTime = candles[candles.length - 1].time;
      expect(report.events.every((e) => e.timestamp <= lastTime)).toBe(true);
      expect(report.barTime).toBe(lastTime);
    });

    it('tidak berubah bila candle masa depan ditambahkan kemudian (tanpa look-ahead)', () => {
      const all = Array.from({ length: 120 }, (_, i) =>
        bar(i, 100 + i, 100 + i + 4, 100 + i - 4, 100 + i + 1, 100 + (i % 5) * 30),
      );
      const early = engine.analyze('1H', all.slice(0, 90))!;
      const later = engine.analyze('1H', all)!;

      const earlyKeys = early.events.map((e) => `${e.type}@${e.timestamp}`);
      const laterKeysUpToEarly = later.events
        .filter((e) => e.timestamp <= early.barTime)
        .map((e) => `${e.type}@${e.timestamp}`);

      // Event yang sudah terjadi tidak boleh hilang atau berubah waktu.
      for (const key of earlyKeys) {
        expect(laterKeysUpToEarly).toContain(key);
      }
    });

    it('menandai tren struktur bullish pada tangga naik', () => {
      const candles: Candle[] = [];
      let i = 0;
      let base = 100;
      for (let leg = 0; leg < 6; leg++) {
        candles.push(plain(i++, base));
        candles.push(bar(i++, base, base + 12, base - 1, base + 10)); // puncak
        candles.push(plain(i++, base + 6));
        candles.push(bar(i++, base + 5, base + 6, base + 2, base + 4)); // lembah lebih tinggi
        candles.push(plain(i++, base + 7));
        base += 8;
      }
      const report = engine.analyze('1H', candles)!;
      expect(report.trend).toBe('BULLISH');
    });
  });
});
