import { PortfolioService } from './portfolio.service';

/**
 * Angka yang TIDAK DIKETAHUI tidak boleh terlihat seperti angka yang baik.
 *
 * Ketika harga pasar sebuah pair gagal dibaca, versi lama diam-diam memakai
 * harga ENTRY sebagai gantinya. Akibatnya P&L posisi itu tampil tepat 0,00 —
 * tidak bisa dibedakan dari posisi yang memang datar. Operator membacanya
 * sebagai "aman", padahal yang sebenarnya terjadi adalah "tidak diketahui".
 *
 * Satu boolean `degraded` juga tidak cukup: ia menjawab "ada yang salah"
 * tanpa menjawab "yang mana", sedangkan tindakan untuk saldo yang tidak
 * terbaca berbeda dari tindakan untuk harga satu pair yang tidak terbaca.
 */
describe('Kesegaran data portofolio', () => {
  let svc: PortfolioService;
  let tradeRepo: { find: jest.Mock };

  const posisi = (over: Record<string, unknown> = {}) => ({
    id: 3,
    pair: 'btcidr',
    status: 'OPEN',
    quantity: 0.001,
    remainingQuantity: 0.001,
    entryPrice: 1_000_000,
    initialRiskPerUnit: 20_000,
    realizedPnl: 0,
    ...over,
  });

  const build = (opts: {
    cash?: number | Error;
    harga?: Record<string, number | Error>;
    trades?: any[];
  }) => {
    tradeRepo = { find: jest.fn().mockResolvedValue(opts.trades ?? []) };

    svc = Object.create(PortfolioService.prototype) as PortfolioService;
    Object.assign(svc, {
      tradeRepo,
      config: { mode: 'LIVE', isLive: true, simulationCapitalIdr: 1_000_000 },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getCashIdr: jest.fn().mockImplementation(() =>
        opts.cash instanceof Error ? Promise.reject(opts.cash) : Promise.resolve(opts.cash ?? 0),
      ),
      getPrice: jest.fn().mockImplementation((pair: string) => {
        const v = opts.harga?.[pair];
        if (v instanceof Error) return Promise.reject(v);
        return Promise.resolve(v ?? 1_000_000);
      }),
      getPeakEquity: jest.fn().mockResolvedValue(0),
      savePeakEquity: jest.fn().mockResolvedValue(undefined),
    });
    return svc;
  };

  // ─── Keadaan sehat ───────────────────────────────────────────────────────

  it('semua terbaca: tidak ada sebab kegagalan dan harga tidak ditandai basi', async () => {
    const s = build({ cash: 500_000, harga: { btcidr: 1_100_000 }, trades: [posisi()] });

    const st = await s.getState();

    expect(st.degraded).toBe(false);
    expect(st.degradedReasons).toEqual([]);
    expect(st.positions[0].priceStale).toBe(false);
    expect(st.positions[0].unrealizedPnl).toBeGreaterThan(0);
  });

  it('potret selalu membawa cap waktu', async () => {
    // Angka tanpa cap waktu tidak bisa dinilai masih berlaku atau tidak.
    const st = await build({ cash: 100 }).getState();
    expect(new Date(st.asOf).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  // ─── Harga tidak terbaca ─────────────────────────────────────────────────

  it('harga gagal dibaca MENANDAI posisi, bukan diam-diam memakai harga entry', async () => {
    const s = build({
      cash: 500_000,
      harga: { btcidr: new Error('ticker timeout') },
      trades: [posisi()],
    });

    const st = await s.getState();

    expect(st.positions[0].priceStale).toBe(true);
    expect(st.degraded).toBe(true);
  });

  it('sebabnya menyatakan P&L 0 berarti TIDAK DIKETAHUI, bukan datar', async () => {
    // Ini kalimat yang membedakan "aman" dari "tidak tahu".
    const s = build({
      cash: 500_000,
      harga: { btcidr: new Error('ticker timeout') },
      trades: [posisi()],
    });

    const st = await s.getState();
    const sebab = st.degradedReasons.join(' | ');

    expect(sebab).toMatch(/BTCIDR/);
    expect(sebab).toMatch(/TIDAK terbaca/);
    expect(sebab).toMatch(/TIDAK DIKETAHUI/i);
  });

  it('hanya posisi yang gagal yang ditandai, bukan semuanya', async () => {
    const s = build({
      cash: 500_000,
      harga: { btcidr: 1_100_000, ethidr: new Error('mati') },
      trades: [posisi(), posisi({ id: 4, pair: 'ethidr' })],
    });

    const st = await s.getState();
    const byPair = Object.fromEntries(st.positions.map((p) => [p.pair, p.priceStale]));

    expect(byPair['btcidr']).toBe(false);
    expect(byPair['ethidr']).toBe(true);
    expect(st.degradedReasons).toHaveLength(1);
  });

  // ─── Saldo tidak terbaca ─────────────────────────────────────────────────

  it('saldo gagal dibaca disebut terpisah dari harga', async () => {
    // Tindakannya berbeda: saldo menyentuh seluruh perhitungan ukuran posisi.
    const s = build({ cash: new Error('Invalid timestamp'), trades: [] });

    const st = await s.getState();

    expect(st.degraded).toBe(true);
    expect(st.degradedReasons.join(' ')).toMatch(/Saldo kas TIDAK terbaca/);
    expect(st.degradedReasons.join(' ')).toMatch(/Invalid timestamp/);
  });

  it('saldo DAN harga gagal menghasilkan dua sebab, bukan satu', async () => {
    const s = build({
      cash: new Error('Invalid timestamp'),
      harga: { btcidr: new Error('ticker timeout') },
      trades: [posisi()],
    });

    expect((await s.getState()).degradedReasons).toHaveLength(2);
  });
});
