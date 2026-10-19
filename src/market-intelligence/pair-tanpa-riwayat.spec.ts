import { MarketDataProvider } from './mtf/market-data.provider';

/**
 * Sebagian pair AKTIF di Indodax tidak punya riwayat di endpoint chart.
 *
 * Terukur pada SHOWIDR (2026-10-19): volume Rp878 juta, harga naik 6,85%,
 * bid/ask hidup — tetapi `history_v2` mengembalikan 0 candle untuk SEMUA
 * timeframe.
 *
 * Dua akibat yang harus dicegah:
 *
 * 1. **Permintaan terbuang tanpa akhir.** Syarat hit cache menuntut jumlah
 *    candle mencukupi, sehingga entri KOSONG tidak pernah memenuhi syarat
 *    itu — setiap pemindaian mengambil ulang untuk hasil yang sudah
 *    diketahui nol.
 *
 * 2. **Health check kuning selamanya.** Entri kosong dilaporkan sebagai
 *    komponen "degraded" untuk sesuatu yang tidak bisa dan tidak perlu
 *    diperbaiki — dan peringatan yang tidak pernah hilang akan diabaikan
 *    saat benar-benar ada masalah.
 */
describe('Pair tanpa riwayat chart', () => {
  let svc: MarketDataProvider;
  let indodax: { getCandles: jest.Mock };

  const candle = (i: number) => ({
    time: 1_780_000_000 + i * 3600,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  });

  const build = (hasil: any[]) => {
    indodax = { getCandles: jest.fn().mockResolvedValue(hasil) };
    svc = Object.create(MarketDataProvider.prototype) as MarketDataProvider;
    Object.assign(svc, {
      indodax,
      cache: new Map(),
      tanpaRiwayat: new Map(),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    return svc;
  };

  // ─── Berhenti menanyai pair yang terbukti kosong ─────────────────────────

  it('hasil kosong TIDAK ditanyai ulang pada permintaan berikutnya', async () => {
    const s = build([]);

    expect(await s.getCandles('showidr', '1H', 100)).toEqual([]);
    expect(await s.getCandles('showidr', '1H', 100)).toEqual([]);
    expect(await s.getCandles('showidr', '1H', 100)).toEqual([]);

    // Satu kali saja — dua sisanya dijawab dari penanda.
    expect(indodax.getCandles).toHaveBeenCalledTimes(1);
  });

  it('penandanya per timeframe, bukan per pair', async () => {
    // 1H kosong tidak berarti 1D juga kosong; masing-masing harus dicoba.
    const s = build([]);

    await s.getCandles('showidr', '1H', 100);
    await s.getCandles('showidr', '1D', 100);

    expect(indodax.getCandles).toHaveBeenCalledTimes(2);
  });

  it('pair tanpa riwayat bisa didaftar untuk dilaporkan', async () => {
    const s = build([]);
    await s.getCandles('showidr', '1H', 100);

    expect(s.pairTanpaRiwayat()).toContain('showidr|1H');
  });

  it('penanda kedaluwarsa, karena pair baru listing akhirnya punya riwayat', async () => {
    const s = build([]);
    await s.getCandles('showidr', '1H', 100);

    // Majukan waktu melewati batas penanda.
    (s as any).tanpaRiwayat.set('showidr|1H', Date.now() - 31 * 60_000);

    await s.getCandles('showidr', '1H', 100);

    // Ditanyai LAGI — itu intinya. Karena masih kosong, penandanya dipasang
    // ulang; yang salah justru bila ia berhenti mencoba selamanya.
    expect(indodax.getCandles).toHaveBeenCalledTimes(2);
    expect(s.pairTanpaRiwayat()).toContain('showidr|1H');
  });

  // ─── Pair yang SEHAT tidak terpengaruh ───────────────────────────────────

  it('hasil berisi di-cache seperti biasa', async () => {
    const s = build(Array.from({ length: 100 }, (_, i) => candle(i)));

    const a = await s.getCandles('btcidr', '1H', 100);
    const b = await s.getCandles('btcidr', '1H', 100);

    expect(a).toHaveLength(100);
    expect(b).toHaveLength(100);
    // Permintaan kedua dijawab cache.
    expect(indodax.getCandles).toHaveBeenCalledTimes(1);
    expect(s.pairTanpaRiwayat()).toHaveLength(0);
  });

  it('pair yang SEBELUMNYA kosong lalu berisi, penandanya dibuang', async () => {
    // Pair baru listing: kosong hari ini, berisi besok. Penanda yang tidak
    // dibuang akan membuatnya terus dianggap kosong walau datanya sudah ada.
    const s = build([]);
    await s.getCandles('showidr', '1H', 100);
    expect(s.pairTanpaRiwayat()).toContain('showidr|1H');

    indodax.getCandles.mockResolvedValue(Array.from({ length: 100 }, (_, i) => candle(i)));
    (s as any).tanpaRiwayat.set('showidr|1H', Date.now() - 31 * 60_000);

    const hasil = await s.getCandles('showidr', '1H', 100);

    expect(hasil).toHaveLength(100);
    expect(s.pairTanpaRiwayat()).toHaveLength(0);
  });
});
