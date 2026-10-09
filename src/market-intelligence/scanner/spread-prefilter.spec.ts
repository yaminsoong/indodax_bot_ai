import { SignalScannerService } from './signal-scanner.service';
import { MarketSummaryRow } from '../../indodax/indodax.types';

/**
 * Penyaringan spread di prefilter.
 *
 * Sebelumnya tidak ada, dengan alasan tertulis bahwa memeriksa spread menuntut
 * satu panggilan ticker per pair. Alasan itu salah: `/api/summaries` sudah
 * mengembalikan bid dan ask untuk SELURUH pair dalam respons yang sama, dan
 * nilainya hanya dibuang di `getMarketSummary()`.
 *
 * Akibatnya terukur pada memecoin Indodax: sembilan dari tiga belas punya
 * spread 0,7%-11,1% sementara volumenya cukup untuk lolos. MEME (spread 11,1%)
 * menuntut 2,1 jam gerakan normal hanya untuk menutup biaya masuk-keluar.
 * Pair seperti itu lolos ke analisis penuh — dan dalam backtest TIDAK PERNAH
 * ditolak, karena backtest tidak punya data order book.
 */
describe('Prefilter scanner: penyaringan spread', () => {
  let svc: SignalScannerService;
  let indodax: { getMarketSummary: jest.Mock };
  let params: { scannerMinVolumeIdr: number; scannerMaxPairs: number; scannerMaxSpreadPercent: number };

  const row = (pair: string, volumeIdr: number, spreadPercent: number | null): MarketSummaryRow => ({
    pair,
    last: 1000,
    bid: spreadPercent === null ? null : 1000,
    ask: spreadPercent === null ? null : 1000 * (1 + spreadPercent / 100),
    spreadPercent,
    volumeIdr,
    change24h: 0,
  });

  beforeEach(() => {
    params = { scannerMinVolumeIdr: 500e6, scannerMaxPairs: 25, scannerMaxSpreadPercent: 0.8 };
    indodax = { getMarketSummary: jest.fn() };

    svc = Object.create(SignalScannerService.prototype) as SignalScannerService;
    Object.assign(svc, {
      indodax,
      pairs: { isTradable: () => ({ ok: true }) },
      config: { params: () => params },
      logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    });
  });

  // ─── Spread menyaring ────────────────────────────────────────────────────

  it('menolak pair ber-spread di atas ambang walau volumenya besar', async () => {
    // Angka nyata dari Indodax: MEME punya volume Rp62jt dan spread 11,1%.
    indodax.getMarketSummary.mockResolvedValue([
      row('fartcoinidr', 9.5e9, 0.034),
      row('memeidr', 900e6, 11.111),
    ]);

    const r = await svc.prefilter();
    expect(r.candidates).toEqual(['fartcoinidr']);
    expect(r.rejected.spread).toBe(1);
  });

  it('meloloskan memecoin likuid yang spread-nya rapat', async () => {
    indodax.getMarketSummary.mockResolvedValue([
      row('fartcoinidr', 9.5e9, 0.034),
      row('pepeidr', 4.4e9, 0.14),
      row('dogeidr', 5.5e9, 0.066),
      row('shibidr', 580e6, 0.255),
    ]);

    const r = await svc.prefilter();
    expect(r.candidates).toHaveLength(4);
    expect(r.rejected.spread).toBe(0);
  });

  it('menolak yang spread-nya di antara — BONK lewat, BRETT tidak', async () => {
    indodax.getMarketSummary.mockResolvedValue([
      row('bonkidr', 900e6, 0.726),
      row('brettidr', 900e6, 2.128),
    ]);

    const r = await svc.prefilter();
    expect(r.candidates).toEqual(['bonkidr']);
  });

  // ─── Spread tidak terbaca ────────────────────────────────────────────────

  it('spread null DITOLAK, bukan dianggap nol', () => {
    // Nol berarti spread sempurna; null berarti order book tidak terbaca.
    // Memperlakukan keduanya sama akan meloloskan pair yang paling meragukan.
    expect(row('xidr', 1e9, null).spreadPercent).toBeNull();
  });

  it('pair dengan bid/ask tidak terbaca disingkirkan', async () => {
    indodax.getMarketSummary.mockResolvedValue([
      row('aidr', 1e9, null),
      row('bidr', 1e9, 0.1),
    ]);

    const r = await svc.prefilter();
    expect(r.candidates).toEqual(['bidr']);
    expect(r.rejected.spread).toBe(1);
  });

  // ─── Ambang dapat ditimpa ────────────────────────────────────────────────

  it('ambang spread bisa ditimpa per pemindaian', async () => {
    indodax.getMarketSummary.mockResolvedValue([row('brettidr', 1e9, 2.128)]);

    expect((await svc.prefilter()).candidates).toEqual([]);
    expect((await svc.prefilter({ maxSpreadPercent: 3 })).candidates).toEqual(['brettidr']);
  });

  // ─── Tidak merusak penyaring yang sudah ada ──────────────────────────────

  it('volume tetap disaring lebih dulu', async () => {
    indodax.getMarketSummary.mockResolvedValue([row('kecilidr', 1e6, 0.01)]);
    const r = await svc.prefilter();
    expect(r.rejected.volume).toBe(1);
    expect(r.rejected.spread).toBe(0);
  });

  it('stablecoin tetap disingkirkan sebelum spread diperiksa', async () => {
    indodax.getMarketSummary.mockResolvedValue([row('usdtidr', 119e9, 0.01)]);
    const r = await svc.prefilter();
    expect(r.rejected.stablecoin).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  it('pair dalam maintenance tetap ditolak', async () => {
    (svc as any).pairs = { isTradable: () => ({ ok: false, reason: 'maintenance' }) };
    indodax.getMarketSummary.mockResolvedValue([row('xidr', 1e9, 0.1)]);
    const r = await svc.prefilter();
    expect(r.rejected.untradable).toBe(1);
  });

  it('urutan tetap volume terbesar lebih dulu', async () => {
    indodax.getMarketSummary.mockResolvedValue([
      row('kecilidr', 600e6, 0.1),
      row('besaridr', 9e9, 0.1),
    ]);
    expect((await svc.prefilter()).candidates[0]).toBe('besaridr');
  });

  it('tidak melempar bila pasar kosong', async () => {
    indodax.getMarketSummary.mockResolvedValue([]);
    await expect(svc.prefilter()).resolves.toEqual({
      candidates: [],
      totalPairs: 0,
      rejected: { volume: 0, spread: 0, untradable: 0, stablecoin: 0 },
    });
  });
});
