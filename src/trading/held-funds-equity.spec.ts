import { PortfolioService } from './portfolio.service';

/**
 * Dana yang ditahan order terbuka harus ikut dihitung sebagai kas.
 *
 * Indodax memindahkan IDR dari `balance` ke `balance_hold` begitu order limit
 * dipasang. Uang itu belum dibelanjakan — ia kembali bila ordernya dibatalkan.
 *
 * Mengabaikannya membuat ekuitas jatuh seketika setiap kali order dipasang,
 * dan pada akun kecil akibatnya fatal. Terukur 2026-10-12 di mode LIVE:
 *
 *   saldo tersedia  Rp16.998
 *   order + fee     Rp11.071  (dipindahkan ke hold)
 *   kas terbaca     Rp5.927
 *   drawdown        1 - 5.927/16.998 = 65,13%
 *   log bot         "Entry dihentikan: Drawdown 65.14% >= batas 15%"
 *
 * Kill switch menghentikan SELURUH entry, padahal bot belum membukukan satu
 * trade pun dan tidak kehilangan uang sama sekali. Memasang order tidak boleh
 * pernah terlihat seperti kerugian.
 */
describe('Ekuitas LIVE: dana tertahan order terbuka', () => {
  let svc: PortfolioService;
  let indodax: { getBalance: jest.Mock; getBalanceWithHold: jest.Mock };
  let isLive: boolean;

  const build = () => {
    const s = Object.create(PortfolioService.prototype) as PortfolioService;
    Object.assign(s, {
      indodax,
      config: {
        get isLive() {
          return isLive;
        },
        get mode() {
          return isLive ? 'LIVE' : 'SIMULATION';
        },
        simulationCapitalIdr: 10_000_000,
      },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      simulatedCash: null,
    });
    return s;
  };

  beforeEach(() => {
    isLive = true;
    indodax = {
      getBalance: jest.fn().mockResolvedValue({ idr: 5927 }),
      getBalanceWithHold: jest.fn().mockResolvedValue({
        available: { idr: 5927 },
        hold: { idr: 11071 },
      }),
    };
    svc = build();
  });

  // ─── Inti perbaikan ──────────────────────────────────────────────────────

  it('kas LIVE mencakup dana yang ditahan order terbuka', async () => {
    // Angka persis dari kejadian nyata.
    await expect(svc.getCashIdr()).resolves.toBe(5927 + 11071);
  });

  it('kas tidak berubah saat order dipasang', async () => {
    const sebelum = await svc.getCashIdr();

    // Order dipasang: Rp11.071 berpindah dari tersedia ke tertahan.
    indodax.getBalanceWithHold.mockResolvedValue({
      available: { idr: 16998 },
      hold: { idr: 0 },
    });
    const sesudah = await svc.getCashIdr();

    expect(sebelum).toBe(sesudah);
  });

  it('memakai getBalanceWithHold, BUKAN getBalance', async () => {
    // getBalance hanya mengembalikan saldo tersedia — itulah sumber bug-nya.
    await svc.getCashIdr();
    expect(indodax.getBalanceWithHold).toHaveBeenCalled();
    expect(indodax.getBalance).not.toHaveBeenCalled();
  });

  it('drawdown tidak lagi melonjak karena order terbuka', async () => {
    const puncak = 16998;
    const kas = await svc.getCashIdr();
    const drawdown = ((puncak - kas) / puncak) * 100;
    expect(drawdown).toBeCloseTo(0, 5);
  });

  it('perhitungan LAMA memang menghasilkan 65% — membuktikan sebabnya', async () => {
    // Dipertahankan sebagai bukti, bukan sebagai perilaku yang diinginkan.
    const puncak = 16998;
    const kasLama = 5927; // hanya saldo tersedia
    expect(((puncak - kasLama) / puncak) * 100).toBeCloseTo(65.13, 1);
  });

  // ─── Masukan menyimpang ──────────────────────────────────────────────────

  it('hold tidak ada diperlakukan sebagai nol, bukan NaN', async () => {
    indodax.getBalanceWithHold.mockResolvedValue({
      available: { idr: 16998 },
      hold: {},
    });
    await expect(svc.getCashIdr()).resolves.toBe(16998);
  });

  it('available tidak ada tidak merusak hitungan', async () => {
    indodax.getBalanceWithHold.mockResolvedValue({ available: {}, hold: { idr: 500 } });
    await expect(svc.getCashIdr()).resolves.toBe(500);
  });

  it('kedua sisi kosong menghasilkan nol', async () => {
    indodax.getBalanceWithHold.mockResolvedValue({ available: {}, hold: {} });
    await expect(svc.getCashIdr()).resolves.toBe(0);
  });

  // ─── Mode simulasi tidak terpengaruh ─────────────────────────────────────

  it('SIMULASI tidak memanggil exchange sama sekali', async () => {
    isLive = false;
    svc = build();
    (svc as any).simulatedCash = 10_000_000;

    await expect(svc.getCashIdr()).resolves.toBe(10_000_000);
    expect(indodax.getBalanceWithHold).not.toHaveBeenCalled();
    expect(indodax.getBalance).not.toHaveBeenCalled();
  });
});
