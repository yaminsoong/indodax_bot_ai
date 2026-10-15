import { ConfluenceEngineService } from './confluence/confluence-engine.service';
import { DEFAULT_NO_TRADE, DEFAULT_WEIGHTS } from './confluence/confluence.types';

/**
 * Satu pertanyaan menentukan apakah sebuah pair layak ditrade dengan modal
 * kecil: APAKAH GERAKAN KHASNYA SANGGUP MENUTUP BIAYA MASUK-KELUAR?
 *
 * Versi sebelumnya tidak pernah menanyakannya. Ia memakai pita ATR absolut —
 * 0,8-3% dianggap baik, di atas 5% dihukum — sehingga pair yang tenang DAN
 * mahal tampak sama baiknya dengan pair yang tenang dan murah.
 *
 * Diukur dengan spread nyata pada 2026-10-15:
 *
 *   ZEREBRO  ATR 7,12%  biaya 0,76%  -> 0,11x    6 menit menutup biaya
 *   BTC      ATR 0,53%  biaya 0,40%  -> 0,76x   46 menit
 *   PAXG     ATR 0,53%  biaya 1,04%  -> 1,94x  116 menit
 *
 * Pita lama memberi BTC nilai TERTINGGI dan ZEREBRO 10 dari 100 — padahal
 * secara ekonomi urutannya justru terbalik.
 */
describe('Biaya dibanding gerakan', () => {
  let engine: ConfluenceEngineService;

  /** Analisis timeframe minimal dengan ATR yang bisa diatur. */
  const analisis = (atrPercent: number | null, over: Record<string, unknown> = {}) =>
    ({
      timeframe: '1H',
      trend: 'BULLISH',
      indicators: {
        volatility: { atrPercent, atrRatio: 1, squeeze: false },
        volume: { relativeVolume: 1.5 },
        momentum: { rsi: 55 },
      },
      ...over,
    }) as any;

  const skorVolatilitas = (atrPercent: number | null, cost?: number) => {
    const reasons: any[] = [];
    const risks: string[] = [];
    const dim = (engine as any).scoreVolatility(
      analisis(atrPercent),
      { roundTripCostPercent: cost },
      DEFAULT_WEIGHTS,
      reasons,
      risks,
    );
    return { raw: dim.raw, reasons, risks };
  };

  beforeEach(() => {
    engine = Object.create(ConfluenceEngineService.prototype) as ConfluenceEngineService;
    Object.assign(engine, {
      logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    });
  });

  // ─── Urutan nilai mengikuti ekonomi, bukan ATR mentah ────────────────────

  it('pair bergejolak yang murah dinilai LEBIH TINGGI dari pair tenang yang mahal', () => {
    // Inilah pembalikan yang menjadi inti perubahan ini.
    const zerebro = skorVolatilitas(7.12, 0.76); // 0,11x
    const paxg = skorVolatilitas(0.53, 1.04); // 1,94x

    expect(zerebro.raw).toBeGreaterThan(paxg.raw);
  });

  it('biaya 11% dari gerakan satu jam mendapat nilai terbaik', () => {
    const r = skorVolatilitas(7.12, 0.76);
    expect(r.raw).toBeGreaterThan(70);
    expect(r.reasons.map((x) => x.text).join(' ')).toMatch(/menit untuk menutupnya/);
  });

  it('biaya di bawah separuh gerakan masih dinilai positif', () => {
    // HYPE: ATR 1,07%, biaya 0,43% -> 0,41x
    expect(skorVolatilitas(1.07, 0.43).raw).toBeGreaterThan(50);
  });

  it('biaya menghabiskan tiga per empat gerakan dihukum', () => {
    // BTC: ATR 0,53%, biaya 0,40% -> 0,76x. Pita lama memberinya nilai tinggi.
    const r = skorVolatilitas(0.53, 0.4);
    expect(r.raw).toBeLessThan(50);
    expect(r.risks.join(' ')).toMatch(/kembali ke titik nol/);
  });

  it('gerakan yang TIDAK menutup biaya dihukum paling berat', () => {
    const r = skorVolatilitas(0.53, 1.04);
    expect(r.raw).toBeLessThan(20);
    expect(r.risks.join(' ')).toMatch(/TIDAK menutup biaya/);
  });

  it('alasan menyebut berapa MENIT untuk menutup biaya', () => {
    // Menit lebih bisa dinilai manusia daripada rasio tanpa satuan.
    const r = skorVolatilitas(0.53, 0.4);
    expect(r.risks.join(' ')).toMatch(/~45 menit/);
  });

  // ─── ATR ekstrem tidak dihukum dua kali ──────────────────────────────────

  it('ATR ekstrem TIDAK dihukum di dimensi ini', () => {
    // Volatilitas ekstrem adalah masalah UKURAN POSISI, dan sudah ditangani
    // `maxAtrPercent` sebagai penolak tegas. Menghukumnya di sini juga membuat
    // dimensi ini menilai hal yang sama dengan gerbang di atasnya.
    const r = skorVolatilitas(9, 0.5); // 0,06x, sangat murah relatif gerakan
    expect(r.raw).toBeGreaterThan(70);
    expect(r.risks.join(' ')).not.toMatch(/ekstrem/);
  });

  // ─── Jalur cadangan tanpa data biaya ─────────────────────────────────────

  it('tanpa data biaya kembali ke pita ATR absolut', () => {
    // Backtest tidak punya spread historis. Kehilangan ketajaman satu dimensi
    // lebih baik daripada memakai biaya yang dikarang.
    const r = skorVolatilitas(1.5, undefined);
    expect(r.raw).toBeGreaterThan(50);
    expect(r.reasons.map((x) => x.text).join(' ')).toMatch(/volatilitas normal/);
  });

  it('biaya nol diperlakukan sebagai tidak diketahui, bukan sempurna', () => {
    // Biaya nol tidak pernah nyata; memperlakukannya sebagai ideal akan
    // memberi nilai tertinggi kepada pair yang datanya justru hilang.
    const r = skorVolatilitas(1.5, 0);
    expect(r.reasons.map((x) => x.text).join(' ')).toMatch(/volatilitas normal/);
  });

  it('ATR tidak terbaca ditandai tidak tersedia, bukan dinilai nol', () => {
    const reasons: any[] = [];
    const risks: string[] = [];
    const dim = (engine as any).scoreVolatility(
      analisis(null),
      { roundTripCostPercent: 0.4 },
      DEFAULT_WEIGHTS,
      reasons,
      risks,
    );
    expect(dim.unavailable).toBe(true);
  });

  // ─── Penolak tegas ───────────────────────────────────────────────────────

  describe('Penolak biaya', () => {
    const blockers = (atrPercent: number, cost?: number) =>
      (engine as any).findBlockers(
        { timeframes: {}, alignment: { direction: 'BULLISH', conflicts: [] } },
        analisis(atrPercent),
        'LONG',
        null,
        { ...DEFAULT_NO_TRADE, maxAtrPercent: 99, minRelativeVolume: 0 },
        cost,
      ) as string[];

    it('pair yang mustahil secara aritmetika ditolak tegas', () => {
      const b = blockers(0.53, 1.04).join(' | ');
      expect(b).toMatch(/Biaya masuk-keluar/);
      expect(b).toMatch(/1\.96x|1\.9[0-9]x/);
    });

    it('pesan penolakan menyebut biaya, gerakan, batas, DAN menitnya', () => {
      // Operator harus bisa menghitung ulang kesimpulannya sendiri.
      const b = blockers(0.53, 1.04).find((x) => x.includes('Biaya masuk-keluar')) ?? '';
      expect(b).toMatch(/1\.04%/);
      expect(b).toMatch(/0\.53%/);
      expect(b).toMatch(/batas 1x/);
      expect(b).toMatch(/menit/);
    });

    it('pair yang biayanya tertutup TIDAK ditolak', () => {
      expect(blockers(7.12, 0.76).join(' ')).not.toMatch(/Biaya masuk-keluar/);
    });

    it('tepat di batas belum ditolak', () => {
      // rasio 1,00x: gerakan satu bar pas menutup biaya.
      expect(blockers(1.0, 1.0).join(' ')).not.toMatch(/Biaya masuk-keluar/);
    });

    it('tanpa data biaya tidak menolak apa pun', () => {
      expect(blockers(0.53, undefined).join(' ')).not.toMatch(/Biaya masuk-keluar/);
    });
  });
});
