import { GlobalMarketService } from './global-market.service';
import { GLOBAL_SYMBOLS, GlobalQuote, GlobalSymbol } from './global-market.types';

/**
 * Lapisan makro punya dua cara gagal tanpa menimbulkan galat, dan keduanya
 * menghasilkan angka yang terlihat sah:
 *
 *   1. Pasar saham tutup — penutupan Jumat terbaca sebagai kondisi Minggu.
 *   2. Sumber data gagal sebagian — skor dihitung dari sisa yang kebetulan ada.
 *
 * Keduanya diuji di sini secara eksplisit.
 */
describe('Global risk score', () => {
  let svc: GlobalMarketService;

  beforeEach(() => {
    svc = new GlobalMarketService({} as any);
  });

  const quote = (symbol: GlobalSymbol, changePercent: number, over: Partial<GlobalQuote> = {}): GlobalQuote => {
    const spec = GLOBAL_SYMBOLS.find((s) => s.symbol === symbol)!;
    const previousClose = 100;
    return {
      symbol,
      label: spec.label,
      price: previousClose * (1 + changePercent / 100),
      previousClose,
      changePercent,
      quotedAt: new Date().toISOString(),
      ageHours: 1,
      stale: false,
      ...over,
    };
  };

  /** Semua instrumen bergerak sebesar ambang signifikannya. */
  const allMoving = (towardRiskOn: boolean) =>
    GLOBAL_SYMBOLS.map((s) => {
      const magnitude = s.significantMovePercent;
      const up = s.polarity === 'POSITIVE' ? towardRiskOn : !towardRiskOn;
      return quote(s.symbol, up ? magnitude : -magnitude);
    });

  /**
   * Lengkapi dengan instrumen netral sampai seluruh bobot terkumpul.
   *
   * Tanpa ini sebagian besar tes di bawah akan menguji jalur "data tidak
   * cukup" dan selalu mendapat 50 — lolos tanpa membuktikan apa pun tentang
   * arah skor.
   */
  const padded = (...moving: GlobalQuote[]): GlobalQuote[] => {
    const named = new Set(moving.map((q) => q.symbol));
    return [
      ...moving,
      ...GLOBAL_SYMBOLS.filter((s) => !named.has(s.symbol)).map((s) => quote(s.symbol, 0)),
    ];
  };

  // ─── Arah skor ───────────────────────────────────────────────────────────

  it('netral 50 bila tidak ada yang bergerak', () => {
    const r = svc.score(GLOBAL_SYMBOLS.map((s) => quote(s.symbol, 0)));
    expect(r.score).toBe(50);
    expect(r.regime).toBe('MIXED');
  });

  it('skor tinggi dan RISK_ON saat semua mendukung risiko', () => {
    const r = svc.score(allMoving(true));
    expect(r.score).toBe(100);
    expect(r.regime).toBe('RISK_ON');
  });

  it('skor rendah dan RISK_OFF saat semua menekan risiko', () => {
    const r = svc.score(allMoving(false));
    expect(r.score).toBe(0);
    expect(r.regime).toBe('RISK_OFF');
  });

  it('DXY naik menurunkan skor — polaritas terbalik dihormati', () => {
    const naik = svc.score(padded(quote('DXY', 1.0)));
    const turun = svc.score(padded(quote('DXY', -1.0)));
    expect(naik.score).toBeLessThan(50);
    expect(turun.score).toBeGreaterThan(50);
  });

  it('NASDAQ naik menaikkan skor', () => {
    const naik = svc.score(padded(quote('NASDAQ', 2.0)));
    const turun = svc.score(padded(quote('NASDAQ', -2.0)));
    expect(naik.score).toBeGreaterThan(50);
    expect(turun.score).toBeLessThan(50);
  });

  // ─── Normalisasi per instrumen ───────────────────────────────────────────

  it('VIX tidak mendominasi DXY walau persen gerakannya jauh lebih besar', () => {
    // VIX +8% dan DXY +0,5% keduanya satu "gerakan besar" pada skalanya.
    // Dibandingkan pada bobot yang mirip (15 vs 18), sumbangannya harus sebanding.
    const vix = 50 - svc.score(padded(quote('VIX', 8))).score;
    const dxy = 50 - svc.score(padded(quote('DXY', 0.5))).score;
    expect(vix).toBeGreaterThan(0);
    expect(dxy).toBeGreaterThan(0);
    expect(Math.abs(vix - dxy)).toBeLessThanOrEqual(4);
  });

  it('gerakan ekstrem dibatasi agar satu instrumen tidak memborong skor', () => {
    const wajar = svc.score(padded(quote('VIX', 8)));
    const gila = svc.score(padded(quote('VIX', 400)));
    expect(gila.score).toBe(wajar.score);
    // Dan batasnya memang terasa, bukan sekadar dua angka netral yang sama.
    expect(wajar.score).toBeLessThan(50);
  });

  // ─── Data kedaluwarsa ────────────────────────────────────────────────────

  it('harga kedaluwarsa TIDAK ikut menilai', () => {
    // Pasar tutup: penutupan Jumat tidak boleh menjadi kondisi Minggu.
    const segar = svc.score(padded(quote('NASDAQ', -5)));
    const basi = svc.score(padded(quote('NASDAQ', -5, { stale: true, ageHours: 60 })));
    expect(segar.score).toBeLessThan(50);
    expect(basi.score).toBe(50);
  });

  it('harga kedaluwarsa tetap ditampilkan dan dihitung jumlahnya', () => {
    const r = svc.score(
      padded(quote('NASDAQ', -5, { stale: true }), quote('SP500', -5, { stale: true })),
    );
    expect(r.staleCount).toBe(2);
    expect(r.quotes).toHaveLength(GLOBAL_SYMBOLS.length);
  });

  it('pasar saham tutup sementara crypto jalan: sisanya masih bisa menilai', () => {
    // Akhir pekan — saham dan futures kedaluwarsa, tetapi DXY/VIX/yield yang
    // masih segar berbobot 48, di bawah ambang. Hasilnya harus TIDAK TAHU.
    const r = svc.score(
      padded(
        quote('NASDAQ', 0, { stale: true }),
        quote('SP500', 0, { stale: true }),
        quote('GOLD', 0, { stale: true }),
        quote('OIL', 0, { stale: true }),
      ),
    );
    expect(r.staleCount).toBe(4);
    expect(r.inconclusive).toBe(true);
  });

  // ─── Data tidak cukup ────────────────────────────────────────────────────

  it('data terlalu sedikit menghasilkan TIDAK TAHU, bukan skor ekstrem', () => {
    // Hanya emas (bobot 6) berhasil diambil. Tanpa pengaman, emas -1% akan
    // menghasilkan skor 0 dan membaca seluruh dunia sebagai RISK_OFF.
    const r = svc.score([quote('GOLD', -1)], ['SP500', 'NASDAQ', 'DXY', 'US10Y', 'VIX', 'OIL']);
    expect(r.inconclusive).toBe(true);
    expect(r.score).toBe(50);
    expect(r.regime).toBe('MIXED');
  });

  it('menyebut instrumen yang gagal diambil, tidak mendiamkannya', () => {
    const r = svc.score([quote('GOLD', 0)], ['DXY', 'VIX']);
    expect(r.unavailable).toEqual(['DXY', 'VIX']);
    expect(r.caveat).toMatch(/tidak cukup/i);
  });

  it('seluruh instrumen gagal tetap aman, tidak melempar', () => {
    const r = svc.score([], GLOBAL_SYMBOLS.map((s) => s.symbol));
    expect(r.inconclusive).toBe(true);
    expect(r.score).toBe(50);
  });

  it('bobot cukup besar sudah bisa menyimpulkan', () => {
    // NASDAQ + DXY + US10Y = 55, di atas ambang 50.
    const r = svc.score([quote('NASDAQ', -1.2), quote('DXY', 0.5), quote('US10Y', 2)]);
    expect(r.inconclusive).toBe(false);
    expect(r.score).toBeLessThan(20);
  });

  // ─── Penjelasan ──────────────────────────────────────────────────────────

  it('menyebut penekan terbesar agar operator tahu sebabnya', () => {
    const r = svc.score(padded(quote('NASDAQ', -2), quote('DXY', 1), quote('GOLD', 0.1)));
    expect(r.drivers.length).toBeGreaterThan(0);
    expect(r.drivers[0]).toContain('NASDAQ');
    expect(r.drivers.join(' ')).not.toContain('Emas');
  });

  it('selalu membawa peringatan bahwa korelasinya tidak stabil', () => {
    expect(svc.score(allMoving(true)).caveat).toMatch(/tidak stabil/i);
  });

  it('bobot seluruh instrumen berjumlah 100', () => {
    expect(GLOBAL_SYMBOLS.reduce((s, x) => s + x.weight, 0)).toBe(100);
  });
});
