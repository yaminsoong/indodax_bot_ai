import { PortfolioService } from './portfolio.service';

/**
 * Mengubah modal simulasi TIDAK membuat ekuitas turun — ia memulai percobaan
 * yang berbeda. Tetapi puncak ekuitas lama tetap tersimpan, dan drawdown lalu
 * dihitung terhadap basis yang sudah tidak berlaku.
 *
 * Terukur 2026-10-16: `SIMULATION_CAPITAL_IDR` diubah 10.000.000 -> 1.000.000,
 * puncak lama dari 9 September masih 10.000.000, sehingga
 *
 *     (10.000.000 - 1.000.000) / 10.000.000 = 90,00%
 *
 * Kill switch menyala 55 kali dalam 24 jam dan memblokir SELURUH entry —
 * termasuk 24 sinyal BUY yang sudah lolos semua filter. Simulasi tampak
 * berjalan padahal tidak pernah bisa membuka satu posisi pun, dan laporan
 * menyalahkan filter teknikal.
 *
 * Bentuk bug yang sama pernah terjadi di LIVE: dana tertahan dibaca sebagai
 * drawdown 65%. Keduanya berasal dari puncak yang dibandingkan terhadap basis
 * berbeda.
 */
describe('Drawdown hantu dari modal simulasi yang berubah', () => {
  let svc: PortfolioService;

  const build = (opts: { live: boolean; modal: number; puncakTersimpan: number; kas: number }) => {
    const equityRepo = {
      createQueryBuilder: () => ({
        select: () => ({
          where: () => ({
            getRawOne: async () => ({ peak: opts.puncakTersimpan }),
          }),
        }),
      }),
    };

    svc = Object.create(PortfolioService.prototype) as PortfolioService;
    Object.assign(svc, {
      equityRepo,
      tradeRepo: { find: jest.fn().mockResolvedValue([]) },
      config: {
        mode: opts.live ? 'LIVE' : 'SIMULATION',
        isLive: opts.live,
        simulationCapitalIdr: opts.modal,
      },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getCashIdr: jest.fn().mockResolvedValue(opts.kas),
      getPrice: jest.fn().mockResolvedValue(1),
    });
    return svc;
  };

  // ─── Kasus yang memicu tes ini ───────────────────────────────────────────

  it('modal simulasi diperkecil TIDAK menghasilkan drawdown', async () => {
    const s = build({ live: false, modal: 1_000_000, puncakTersimpan: 10_000_000, kas: 1_000_000 });

    const st = await s.getState();

    expect(st.drawdownPercent).toBe(0);
    expect(st.peakEquityIdr).toBe(1_000_000);
  });

  it('snapshot dari modal berbeda dicatat sebagai diabaikan, bukan dibuang diam-diam', async () => {
    // Operator harus bisa tahu mengapa puncaknya berubah.
    const s = build({ live: false, modal: 1_000_000, puncakTersimpan: 10_000_000, kas: 1_000_000 });
    await s.getState();

    const pesan = ((s as any).logger.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(pesan).toMatch(/melebihi modal awal/);
    expect(pesan).toMatch(/DIABAIKAN/);
  });

  // ─── Drawdown simulasi yang NYATA tetap terbaca ──────────────────────────

  it('kerugian simulasi yang sungguhan tetap menghasilkan drawdown', async () => {
    // Puncak sama dengan modal, kas tinggal separuh: itu drawdown asli dan
    // tidak boleh ikut tersembunyi oleh perbaikan ini.
    const s = build({ live: false, modal: 1_000_000, puncakTersimpan: 1_000_000, kas: 500_000 });

    const st = await s.getState();

    expect(st.peakEquityIdr).toBe(1_000_000);
    expect(st.drawdownPercent).toBeCloseTo(50, 1);
  });

  it('puncak di bawah modal awal dipakai apa adanya', async () => {
    // Simulasi yang belum pernah menyentuh modal penuh: puncaknya yang benar.
    const s = build({ live: false, modal: 1_000_000, puncakTersimpan: 800_000, kas: 800_000 });

    const st = await s.getState();
    expect(st.peakEquityIdr).toBe(800_000);
    expect(st.drawdownPercent).toBe(0);
  });

  // ─── LIVE tidak boleh dibatasi ───────────────────────────────────────────

  it('pada LIVE puncak TIDAK dibatasi — drawdown nyata harus terlihat', async () => {
    // Di LIVE puncak adalah riwayat uang sungguhan. Membatasinya akan
    // menyembunyikan drawdown yang benar-benar terjadi.
    const s = build({ live: true, modal: 1_000_000, puncakTersimpan: 10_000_000, kas: 1_000_000 });

    const st = await s.getState();

    expect(st.peakEquityIdr).toBe(10_000_000);
    expect(st.drawdownPercent).toBeCloseTo(90, 1);
  });

  it('pada LIVE modal simulasi tidak berpengaruh sama sekali', async () => {
    const s = build({ live: true, modal: 50, puncakTersimpan: 20_000, kas: 16_819 });

    const st = await s.getState();
    expect(st.peakEquityIdr).toBe(20_000);
  });

  // ─── Keadaan kosong ──────────────────────────────────────────────────────

  it('tanpa snapshot sama sekali, puncak mengikuti ekuitas sekarang', async () => {
    const s = build({ live: false, modal: 1_000_000, puncakTersimpan: 0, kas: 1_000_000 });

    const st = await s.getState();
    expect(st.peakEquityIdr).toBe(1_000_000);
    expect(st.drawdownPercent).toBe(0);
  });
});
