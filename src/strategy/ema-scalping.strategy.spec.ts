import { EmaScalpingStrategy } from './ema-scalping.strategy';
import { TechnicalService } from '../indicators/technical.service';
import { StrategyContext } from './strategy.interface';
import { BotParams } from '../config/bot-config.service';
import { makeParams } from '../../test/fixtures/bot-params';
import { Candle } from '../indodax/indodax.types';

/**
 * Nilai strategi ini ada pada filternya. Test di sini memastikan setiap filter
 * benar-benar menolak kondisi yang seharusnya ditolak — terutama pasar sideways,
 * penyebab utama rentetan kerugian pada sistem EMA crossover.
 */
describe('EmaScalpingStrategy', () => {
  let strategy: EmaScalpingStrategy;
  let params: BotParams;

  beforeEach(() => {
    strategy = new EmaScalpingStrategy(new TechnicalService());
    params = makeParams();
  });

  const ctx = (candles: Candle[], overrides: Partial<StrategyContext> = {}): StrategyContext => ({
    pair: 'btcidr',
    candles,
    htfCandles: uptrend(120, 1_000_000, 3000),
    orderBook: { imbalance: 0.2, spreadPercent: 0.1, bidDepthIdr: 1e9, askDepthIdr: 8e8 },
    volumeIdr24h: 10e9,
    params,
    hasOpenPosition: false,
    ...overrides,
  });

  // ─── Kecukupan data ──────────────────────────────────────────────────────

  it('menahan sinyal bila candle belum cukup', () => {
    const signal = strategy.evaluate(ctx(uptrend(20, 1_000_000, 5000)));
    expect(signal.action).toBe('HOLD');
    expect(signal.reasons).toContain('Data candle belum cukup');
  });

  // ─── Filter regime ───────────────────────────────────────────────────────

  it('menolak entry di pasar sideways lewat ADX', () => {
    const signal = strategy.evaluate(ctx(sideways(120, 1_000_000)));
    expect(signal.action).not.toBe('BUY');
    expect(signal.blockedBy.some((b) => b.includes('ADX'))).toBe(true);
  });

  it('menolak entry saat choppiness tinggi', () => {
    params.minAdx = 0; // matikan filter ADX agar choppiness yang teruji
    const signal = strategy.evaluate(ctx(sideways(120, 1_000_000)));
    expect(signal.action).not.toBe('BUY');
    expect(signal.blockedBy.some((b) => b.includes('Choppiness'))).toBe(true);
  });

  // ─── Filter HTF ──────────────────────────────────────────────────────────

  it('menolak entry saat tren timeframe tinggi bearish', () => {
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), { htfCandles: downtrend(120, 2_000_000, 5000) }),
    );
    expect(signal.action).not.toBe('BUY');
    expect(signal.blockedBy.some((b) => b.includes('HTF'))).toBe(true);
  });

  it('mengizinkan entry saat filter HTF dimatikan', () => {
    params.requireHtfTrend = false;
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), { htfCandles: downtrend(120, 2_000_000, 5000) }),
    );
    expect(signal.blockedBy.some((b) => b.includes('HTF'))).toBe(false);
  });

  // ─── Filter likuiditas ───────────────────────────────────────────────────

  it('menolak pair dengan spread terlalu lebar', () => {
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), {
        orderBook: { imbalance: 0.2, spreadPercent: 2.5, bidDepthIdr: 1e6, askDepthIdr: 1e6 },
      }),
    );
    expect(signal.blockedBy.some((b) => b.includes('Spread'))).toBe(true);
  });

  it('menolak pair dengan volume 24 jam terlalu kecil', () => {
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), { volumeIdr24h: 1_000_000 }),
    );
    expect(signal.blockedBy.some((b) => b.includes('Volume 24h'))).toBe(true);
  });

  it('menolak saat order book condong jual kuat', () => {
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), {
        orderBook: { imbalance: -0.6, spreadPercent: 0.1, bidDepthIdr: 1e8, askDepthIdr: 4e8 },
      }),
    );
    expect(signal.blockedBy.some((b) => b.includes('order book') || b.includes('Order book'))).toBe(true);
  });

  // ─── Sinyal keluar ───────────────────────────────────────────────────────

  it('menghasilkan SELL saat posisi terbuka dan tren berbalik bearish', () => {
    const signal = strategy.evaluate(
      ctx(downtrend(120, 2_000_000, 5000), { hasOpenPosition: true }),
    );
    expect(signal.action).toBe('SELL');
    expect(signal.strength).toBeGreaterThanOrEqual(50);
  });

  it('tidak keluar dari posisi yang masih sehat', () => {
    const signal = strategy.evaluate(
      ctx(uptrend(120, 1_000_000, 5000), { hasOpenPosition: true }),
    );
    expect(signal.action).not.toBe('SELL');
  });

  // ─── Level exit ──────────────────────────────────────────────────────────

  it('mengusulkan stop loss di bawah harga dan dalam batas persen', () => {
    const candles = uptrend(120, 1_000_000, 5000);
    const price = candles[candles.length - 1].close;
    const signal = strategy.evaluate(ctx(candles));

    expect(signal.suggestedStopLoss).toBeDefined();
    expect(signal.suggestedStopLoss!).toBeLessThan(price);

    const stopPercent = ((price - signal.suggestedStopLoss!) / price) * 100;
    expect(stopPercent).toBeGreaterThanOrEqual(params.minStopPercent - 0.001);
    expect(stopPercent).toBeLessThanOrEqual(params.maxStopPercent + 0.001);
  });

  it('mengusulkan target di atas harga dengan imbalan sepadan risiko', () => {
    const candles = uptrend(120, 1_000_000, 5000);
    const price = candles[candles.length - 1].close;
    const signal = strategy.evaluate(ctx(candles));

    expect(signal.suggestedTakeProfit!).toBeGreaterThan(price);
    const risk = price - signal.suggestedStopLoss!;
    const reward = signal.suggestedTakeProfit! - price;
    // Rasio target/stop mengikuti atrTargetMultiplier / atrStopMultiplier = 2
    expect(reward / risk).toBeCloseTo(params.atrTargetMultiplier / params.atrStopMultiplier, 5);
  });

  // ─── Snapshot ────────────────────────────────────────────────────────────

  it('selalu mengisi snapshot indikator untuk pencatatan', () => {
    const signal = strategy.evaluate(ctx(uptrend(120, 1_000_000, 5000)));
    expect(signal.snapshot.price).toBeGreaterThan(0);
    expect(signal.snapshot.adx).toBeGreaterThanOrEqual(0);
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(signal.snapshot.trend);
    expect(['TRENDING', 'RANGING', 'VOLATILE']).toContain(signal.snapshot.regime);
  });

  it('mencatat alasan penolakan agar bot pasif bisa didiagnosa', () => {
    const signal = strategy.evaluate(ctx(sideways(120, 1_000_000)));
    expect(signal.blockedBy.length).toBeGreaterThan(0);
  });
});

// ─── Generator data ────────────────────────────────────────────────────────

function bar(i: number, base: number, range: number): Candle {
  return {
    time: 1_700_000_000 + i * 900,
    open: base,
    high: base + range,
    low: base - range,
    close: base + range * 0.3,
    volume: 1000 + (i % 5) * 100,
  };
}

/**
 * Tren naik dengan derau ringan.
 *
 * Deret yang benar-benar linier bersifat degeneratif untuk indikator berbasis
 * selisih EMA: histogram MACD konvergen tepat ke nol, sehingga momentum tampak
 * netral padahal trennya kuat. Derau kecil membuat data berperilaku seperti
 * harga sungguhan.
 */
function uptrend(n: number, start: number, step: number): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    bar(i, start + i * step + Math.sin(i / 4) * step * 0.6, step * 0.3),
  );
}

function downtrend(n: number, start: number, step: number): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    bar(i, start - i * step + Math.sin(i / 4) * step * 0.6, step * 0.3),
  );
}

/** Bolak-balik dalam rentang sempit — ADX rendah, choppiness tinggi. */
function sideways(n: number, base: number): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    bar(i, base + Math.sin(i / 2) * base * 0.002, base * 0.003),
  );
}
