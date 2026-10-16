import { ScoreAttributionService } from './score-attribution.service';

/**
 * Pertanyaan yang menentukan arah seluruh proyek: apakah skor Market
 * Intelligence benar-benar meramalkan hasil?
 *
 * Pada walk-forward 16 Okt 2026 — dijalankan setelah bug pemotongan backtest
 * diperbaiki — hubungannya tampak TERBALIK: bucket 80-89 menghasilkan NOL
 * kemenangan dari tujuh trade, sementara bucket 70-79 masih 31%. Bila itu
 * nyata, menaikkan ambang skor justru MEMPERBURUK hasil.
 *
 * Tetapi peluang nol menang dari delapan trade pada win rate dasar ~37%
 * adalah ~2,5%: mengusik, bukan bukti. Karena itu sifat terpenting layanan
 * ini adalah MENOLAK MENYIMPULKAN sampai sampelnya cukup — `direction`
 * bernilai null, bukan "netral".
 */
describe('Atribusi skor terhadap hasil', () => {
  let svc: ScoreAttributionService;
  let tradeRepo: { find: jest.Mock };

  /** Trade tertutup dengan skor dan hasil yang bisa diatur. */
  const trade = (score: number | null, rMultiple: number, over: Record<string, unknown> = {}) => ({
    pair: 'btcidr',
    strategy: 'EMA_SCALPING_V2',
    status: 'CLOSED',
    mode: 'SIMULATION',
    rMultiple,
    profitLoss: rMultiple * 1000,
    intelligenceScore: score,
    marketRegime: 'BULL_TREND',
    openedAt: new Date('2026-10-01T00:00:00Z'),
    closedAt: new Date('2026-10-01T05:00:00Z'),
    ...over,
  });

  const build = (trades: any[]) => {
    tradeRepo = { find: jest.fn().mockResolvedValue(trades) };
    svc = Object.create(ScoreAttributionService.prototype) as ScoreAttributionService;
    Object.assign(svc, {
      tradeRepo,
      config: { mode: 'SIMULATION', params: () => ({ candleTimeframe: 60 }) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    return svc;
  };

  /** n trade dalam satu bucket dengan ekspektasi tertentu. */
  const banyak = (n: number, score: number, r: number) =>
    Array.from({ length: n }, () => trade(score, r));

  // ─── Menolak menyimpulkan dari sampel kecil ──────────────────────────────

  it('sampel kecil TIDAK melaporkan arah hubungan', async () => {
    // Persis bentuk data walk-forward: terbalik tetapi hanya 8 trade di 80+.
    const s = build([
      ...banyak(3, 67, -0.65),
      ...banyak(13, 75, -0.38),
      ...banyak(7, 85, -1.22),
      ...banyak(1, 95, -1.22),
    ]);

    const a = await s.attribute();

    expect(a.conclusive).toBe(false);
    // null, BUKAN 'TIDAK JELAS' — belum diukur berbeda dari sudah diukur
    // dan ternyata datar.
    expect(a.direction).toBeNull();
    expect(a.caveat).toMatch(/BELUM bisa disimpulkan/);
  });

  it('bucket tetap ditampilkan walau belum cukup — datanya tetap berguna', async () => {
    const s = build([...banyak(3, 67, -0.65), ...banyak(7, 85, -1.22)]);
    const a = await s.attribute();

    expect(a.byScore.length).toBe(2);
    expect(a.readyBuckets).toBe(0);
  });

  it('satu bucket cukup saja belum memenuhi syarat', async () => {
    // Hubungan butuh minimal dua titik untuk dibandingkan.
    const s = build([...banyak(25, 75, -0.3), ...banyak(5, 85, -1.0)]);
    const a = await s.attribute();

    expect(a.readyBuckets).toBe(1);
    expect(a.conclusive).toBe(false);
    expect(a.direction).toBeNull();
  });

  // ─── Setelah sampelnya cukup ─────────────────────────────────────────────

  it('hubungan TERBALIK dilaporkan ketika sampelnya cukup', async () => {
    // Inilah temuan yang akan mengubah arah proyek bila terbukti.
    const s = build([...banyak(25, 75, +0.4), ...banyak(25, 85, -0.6)]);
    const a = await s.attribute();

    expect(a.conclusive).toBe(true);
    expect(a.direction).toBe('TERBALIK');
  });

  it('hubungan SEARAH dilaporkan ketika skor tinggi memang lebih baik', async () => {
    const s = build([...banyak(25, 75, -0.5), ...banyak(25, 85, +0.5)]);
    expect((await s.attribute()).direction).toBe('SEARAH');
  });

  it('selisih di bawah 0,1R dinyatakan TIDAK JELAS, bukan dipaksa berarah', async () => {
    // Di bawah itu galat baku khas sudah lebih besar daripada selisihnya.
    const s = build([...banyak(25, 75, -0.30), ...banyak(25, 85, -0.35)]);
    expect((await s.attribute()).direction).toBe('TIDAK JELAS');
  });

  it('bucket bersampel kecil TIDAK boleh menentukan arah', async () => {
    // Bucket berisi 2 trade tidak boleh membalik kesimpulan yang dibangun
    // dari bucket berisi 25.
    const s = build([
      ...banyak(25, 75, -0.5),
      ...banyak(25, 85, +0.5),
      ...banyak(2, 95, -3.0),
    ]);

    expect((await s.attribute()).direction).toBe('SEARAH');
  });

  // ─── Kebersihan data ─────────────────────────────────────────────────────

  it('trade tanpa skor tidak masuk atribusi, tetapi tetap dihitung totalnya', async () => {
    const s = build([...banyak(5, 75, -0.3), trade(null, -1), trade(null, +1)]);
    const a = await s.attribute();

    expect(a.totalClosed).toBe(7);
    expect(a.scored).toBe(5);
  });

  it('hanya mode yang sedang berjalan yang diambil', async () => {
    // Trade simulasi tidak boleh mencemari atribusi LIVE, dan sebaliknya.
    const s = build([]);
    await s.attribute();

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { status: 'CLOSED', mode: 'SIMULATION' },
    });
  });

  it('tanpa trade sama sekali tidak melempar', async () => {
    const a = await build([]).attribute();
    expect(a.byScore).toEqual([]);
    expect(a.direction).toBeNull();
    expect(a.totalClosed).toBe(0);
  });

  it('lama tahan diturunkan dari waktu buka-tutup, bukan field tersimpan', async () => {
    // Timeframe bisa berubah; waktu buka-tutup tidak. Menyimpan holdingBars
    // akan membuatnya salah setelah timeframe diubah.
    const s = build(banyak(25, 75, -0.3));
    const a = await s.attribute();

    // 5 jam pada bar 60 menit = 5 bar.
    expect(a.byScore[0].avgHoldingBars).toBe(5);
  });
});
