import { SignalScannerService } from './signal-scanner.service';

/**
 * Penyaringan likuiditas adalah gerbang pertama scanner, dan kekeliruannya
 * mahal dalam dua arah: terlalu longgar menghabiskan rate limit pada ratusan
 * pair, terlalu ketat membuat scanner tidak pernah menemukan apa pun.
 */
describe('SignalScannerService.prefilter', () => {
  const market = [
    { pair: 'usdtidr', last: 17500, volumeIdr: 120_000_000_000, change24h: 0.1 },
    { pair: 'btcidr', last: 1_500_000_000, volumeIdr: 28_000_000_000, change24h: -1 },
    { pair: 'usdcidr', last: 17490, volumeIdr: 6_700_000_000, change24h: 0 },
    { pair: 'ethidr', last: 44_000_000, volumeIdr: 10_000_000_000, change24h: -2 },
    { pair: 'receh1idr', last: 100, volumeIdr: 5_000_000, change24h: 30 },
    { pair: 'receh2idr', last: 50, volumeIdr: 1_000_000, change24h: -20 },
    { pair: 'maintidr', last: 900, volumeIdr: 9_000_000_000, change24h: 3 },
  ];

  const make = (params: Partial<Record<string, number>> = {}) => {
    const config = {
      params: () => ({
        scannerMinVolumeIdr: params.scannerMinVolumeIdr ?? 1_000_000_000,
        scannerMaxPairs: params.scannerMaxPairs ?? 25,
      }),
    };
    const indodax = { getMarketSummary: jest.fn().mockResolvedValue(market) };
    const pairs = {
      // Satu pair sengaja sedang maintenance.
      isTradable: (p: string) =>
        p === 'maintidr' ? { ok: false, reason: 'maintenance' } : { ok: true },
    };
    return new SignalScannerService({} as any, config as any, indodax as any, pairs as any);
  };

  it('menyingkirkan pair stablecoin walau volumenya tertinggi', async () => {
    const r = await make().prefilter();

    // usdtidr adalah pair bervolume terbesar di Indodax; tanpa pengecualian ini
    // ia akan menduduki puncak peringkat pada hampir setiap pemindaian.
    expect(r.candidates).not.toContain('usdtidr');
    expect(r.candidates).not.toContain('usdcidr');
    expect(r.rejected.stablecoin).toBe(2);
  });

  it('menolak pair bervolume di bawah ambang', async () => {
    const r = await make().prefilter();
    expect(r.candidates).not.toContain('receh1idr');
    expect(r.candidates).not.toContain('receh2idr');
    expect(r.rejected.volume).toBe(2);
  });

  it('menolak pair yang sedang maintenance', async () => {
    const r = await make().prefilter();
    expect(r.candidates).not.toContain('maintidr');
    expect(r.rejected.untradable).toBe(1);
  });

  it('meloloskan pair likuid yang layak', async () => {
    const r = await make().prefilter();
    expect(r.candidates).toEqual(['btcidr', 'ethidr']);
  });

  it('mengurutkan dari volume terbesar', async () => {
    // Pair paling likuid adalah yang paling mudah dimasuki DAN dikeluari,
    // dan itu menentukan untuk modal kecil.
    const r = await make().prefilter();
    expect(r.candidates[0]).toBe('btcidr');
  });

  it('menghormati batas jumlah pair', async () => {
    const r = await make({ scannerMaxPairs: 1 }).prefilter();
    expect(r.candidates).toHaveLength(1);
  });

  it('filter eksplisit menimpa konfigurasi', async () => {
    const r = await make().prefilter({ minVolumeIdr: 20_000_000_000 });
    // Hanya btcidr yang melewati 20 miliar di antara non-stablecoin.
    expect(r.candidates).toEqual(['btcidr']);
  });

  it('melaporkan jumlah total pair yang diperiksa', async () => {
    const r = await make().prefilter();
    expect(r.totalPairs).toBe(market.length);
  });

  it('mengembalikan daftar kosong, bukan error, bila tidak ada yang lolos', async () => {
    const r = await make({ scannerMinVolumeIdr: 1e15 }).prefilter();
    expect(r.candidates).toEqual([]);
  });
});
