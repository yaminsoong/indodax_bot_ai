import { FomoGuardService } from './fomo-guard.service';
import { DEFAULT_FOMO, STRICT_FOMO } from './fomo-guard.types';
import { Candle } from '../../indodax/indodax.service';
import { IndicatorReport } from '../indicators/indicator.types';

/**
 * Gerbang ini menjawab pertanyaan yang tidak ditanyakan filter lain: BUKAN
 * "apakah arahnya benar?" melainkan "apakah kita sudah terlambat?".
 *
 * Perbedaannya menentukan pada memecoin. Kenaikan 30% dalam dua jam membuat
 * SELURUH indikator tren terlihat sempurna — EMA tersusun naik, momentum kuat,
 * volume melonjak — tepat pada titik di mana risikonya paling besar. Gerbang
 * lain akan meloloskannya.
 */
describe('FomoGuardService', () => {
  let svc: FomoGuardService;

  beforeEach(() => {
    svc = new FomoGuardService();
  });

  /** Candle naik mulus dengan total kenaikan `totalPct` selama `n` bar. */
  const rising = (n: number, totalPct: number, start = 100): Candle[] => {
    const step = Math.pow(1 + totalPct / 100, 1 / n);
    const out: Candle[] = [];
    let price = start;
    for (let i = 0; i < n; i++) {
      const close = price * step;
      out.push({ time: i * 3600, open: price, high: close, low: price, close, volume: 1000 } as Candle);
      price = close;
    }
    return out;
  };

  /** Candle mendatar — tidak ada yang dikejar. */
  const flat = (n: number, price = 100): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      time: i * 3600,
      open: price,
      high: price * 1.001,
      low: price * 0.999,
      close: price,
      volume: 1000,
    })) as Candle[];

  const ind = (over: {
    atrPercent?: number | null;
    ema21?: number | null;
    rsi?: number | null;
    relativeVolume?: number | null;
  } = {}): IndicatorReport =>
    ({
      timeframe: '1H',
      // `??` TIDAK dipakai di sini: `null ?? 100` menghasilkan 100, sehingga
      // nilai null yang sengaja diuji tidak pernah sampai ke kode.
      trend: { ema21: over.ema21 === undefined ? 100 : over.ema21 },
      momentum: { rsi14: over.rsi === undefined ? 50 : over.rsi },
      volatility: { atrPercent: over.atrPercent === undefined ? 1.0 : over.atrPercent },
      volume: { relativeVolume: over.relativeVolume === undefined ? 1.0 : over.relativeVolume },
      price: { close: 100 },
    }) as any;

  // ─── Yang HARUS ditolak ──────────────────────────────────────────────────

  it('menolak harga yang sudah naik jauh melebihi ATR-nya', () => {
    // Naik 20% dalam 12 bar sementara ATR 1% = 20x ATR, jauh di atas ambang 6x.
    const r = svc.assess(rising(13, 20), ind({ atrPercent: 1.0, ema21: 100 }));
    expect(r.signals.some((s) => s.code === 'PRICE_ALREADY_RAN')).toBe(true);
    expect(r.severity).toBe('BLOCK');
    expect(r.blockers.length).toBe(1);
  });

  it('menolak harga yang terlalu jauh di atas rata-rata', () => {
    const candles = flat(20, 110);
    const r = svc.assess(candles, ind({ atrPercent: 1.0, ema21: 100 }));
    // 10% di atas EMA21 dengan ATR 1% = 10x ATR, ambang 2,5x.
    expect(r.signals.some((s) => s.code === 'EXTENDED_FROM_MEAN')).toBe(true);
  });

  it('menolak kenaikan parabolik tanpa jeda', () => {
    const r = svc.assess(rising(8, 3), ind({ atrPercent: 2.0, ema21: 100 }));
    expect(r.signals.some((s) => s.code === 'PARABOLIC')).toBe(true);
  });

  it('menolak RSI jenuh beli', () => {
    const r = svc.assess(flat(20), ind({ rsi: 82 }));
    expect(r.signals.some((s) => s.code === 'OVERBOUGHT_STACK')).toBe(true);
  });

  // ─── Yang TIDAK boleh ditolak ────────────────────────────────────────────

  it('harga tenang tidak menimbulkan tanda apa pun', () => {
    const r = svc.assess(flat(20), ind());
    expect(r.signals).toEqual([]);
    expect(r.severity).toBe('NONE');
    expect(r.blockers).toEqual([]);
  });

  it('volume tinggi pada harga yang BELUM bergerak adalah akumulasi, bukan puncak', () => {
    // Pembedaan yang menentukan: volume besar tanpa harga terentang justru
    // tanda akumulasi. Menolaknya akan menyingkirkan entry terbaik.
    const r = svc.assess(flat(20), ind({ relativeVolume: 5 }));
    expect(r.signals.some((s) => s.code === 'BLOWOFF_VOLUME')).toBe(false);
  });

  it('volume tinggi pada harga yang SUDAH terentang dihitung sebagai blow-off', () => {
    const r = svc.assess(rising(13, 20), ind({ atrPercent: 1.0, ema21: 100, relativeVolume: 5 }));
    expect(r.signals.some((s) => s.code === 'BLOWOFF_VOLUME')).toBe(true);
  });

  it('kenaikan yang wajar terhadap ATR pair itu tidak ditolak', () => {
    // Naik 8% dalam 12 bar pada ATR 2% = 4x ATR, di bawah ambang 6x.
    // Inilah gunanya normalisasi: 8% mentah akan terlihat besar.
    const r = svc.assess(rising(13, 8), ind({ atrPercent: 2.0, ema21: 107.9 }));
    expect(r.signals.some((s) => s.code === 'PRICE_ALREADY_RAN')).toBe(false);
  });

  // ─── Normalisasi ATR: satu ambang untuk BTC dan memecoin ─────────────────

  it('kenaikan yang sama dinilai berbeda sesuai ATR pair-nya', () => {
    const candles = rising(13, 10);

    // BTC: ATR 0,36% → 10% = 28x ATR → jelas luar biasa
    const btc = svc.assess(candles, ind({ atrPercent: 0.36, ema21: 100 }));
    // Memecoin: ATR 1,66% → 10% = 6x ATR → di batas
    const meme = svc.assess(candles, ind({ atrPercent: 1.66, ema21: 100 }));

    expect(btc.score).toBeGreaterThan(meme.score);
    expect(btc.severity).toBe('BLOCK');
  });

  // ─── Ambang ketat untuk memecoin ─────────────────────────────────────────

  it('ambang ketat memblokir lebih awal daripada bawaan', () => {
    const candles = rising(13, 9);
    const biasa = svc.assess(candles, ind({ atrPercent: 1.66, ema21: 100 }), DEFAULT_FOMO);
    const ketat = svc.assess(candles, ind({ atrPercent: 1.66, ema21: 100 }), STRICT_FOMO);
    expect(ketat.score).toBeGreaterThanOrEqual(biasa.score);
  });

  it('ambang ketat memang lebih rendah pada tiap parameternya', () => {
    expect(STRICT_FOMO.runAtrMultiple).toBeLessThan(DEFAULT_FOMO.runAtrMultiple);
    expect(STRICT_FOMO.extensionAtrMultiple).toBeLessThan(DEFAULT_FOMO.extensionAtrMultiple);
    expect(STRICT_FOMO.blockAboveScore).toBeLessThan(DEFAULT_FOMO.blockAboveScore);
  });

  // ─── Berita sebagai penguat, bukan sinyal mandiri ────────────────────────

  it('berita sangat positif pada harga terentang menambah tanda hype', () => {
    const r = svc.assess(rising(13, 20), ind({ atrPercent: 1.0, ema21: 100 }), DEFAULT_FOMO, 85);
    expect(r.signals.some((s) => s.code === 'HYPE_WITHOUT_STRUCTURE')).toBe(true);
  });

  it('berita sangat positif pada harga TENANG bukan tanda hype', () => {
    const r = svc.assess(flat(20), ind(), DEFAULT_FOMO, 85);
    expect(r.signals.some((s) => s.code === 'HYPE_WITHOUT_STRUCTURE')).toBe(false);
  });

  it('tanpa skor berita, tanda hype dilewati — bukan diasumsikan aman', () => {
    const r = svc.assess(rising(13, 20), ind({ atrPercent: 1.0, ema21: 100 }));
    expect(r.signals.some((s) => s.code === 'HYPE_WITHOUT_STRUCTURE')).toBe(false);
    expect(r.severity).toBe('BLOCK'); // tetap diblokir oleh tanda lain
  });

  // ─── Data tidak cukup ────────────────────────────────────────────────────

  it('tanpa ATR hasilnya TIDAK TAHU, bukan izin', () => {
    const r = svc.assess(rising(13, 50), ind({ atrPercent: null }));
    expect(r.inconclusive).toBe(true);
    expect(r.severity).toBe('NONE');
    expect(r.caveat).toMatch(/tidak cukup/i);
  });

  it('candle terlalu sedikit juga TIDAK TAHU', () => {
    expect(svc.assess(flat(2), ind()).inconclusive).toBe(true);
  });

  it('indikator null tidak melempar', () => {
    expect(() => svc.assess(flat(20), null)).not.toThrow();
    expect(svc.assess(flat(20), null).inconclusive).toBe(true);
  });

  it('EMA21 tidak tersedia hanya melewatkan satu tanda', () => {
    const r = svc.assess(rising(13, 20), ind({ atrPercent: 1.0, ema21: null }));
    expect(r.signals.some((s) => s.code === 'EXTENDED_FROM_MEAN')).toBe(false);
    expect(r.signals.some((s) => s.code === 'PRICE_ALREADY_RAN')).toBe(true);
  });

  // ─── Batas skor ──────────────────────────────────────────────────────────

  it('skor tetap dalam 0..100 pada kondisi paling ekstrem', () => {
    const r = svc.assess(
      rising(20, 300),
      ind({ atrPercent: 0.5, ema21: 50, rsi: 99, relativeVolume: 20 }),
      STRICT_FOMO,
      100,
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.severity).toBe('BLOCK');
  });

  it('selalu membawa peringatan bahwa tidak ada FOMO bukan alasan membeli', () => {
    expect(svc.assess(flat(20), ind()).caveat).toMatch(/BUKAN alasan untuk membeli/i);
  });
});
