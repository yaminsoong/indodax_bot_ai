import { HealthService } from './health.service';

/**
 * Alarm yang menyala saat tidak ada yang rusak melatih operator untuk
 * mengabaikannya — dan alarm yang diabaikan tidak berguna saat benar-benar ada
 * yang rusak.
 *
 * Versi sebelumnya menandai setiap entri candle 5m yang berumur lebih dari 10
 * menit sebagai "pengambilan candle macet". Itu keliru karena cache-nya LAZY:
 * ia hanya terisi ketika ada yang meminta, dan tidak ada proses yang
 * menyegarkannya di latar belakang.
 *
 * Akibatnya terukur pada bot yang berjalan. Scanner berjalan tiap 15 menit dan
 * mengisi cache 5m untuk ~30 pair; TTL 5m hanya 75 detik. Pada menit ke-10
 * setelah pemindaian pemeriksaan ini berteriak STALE, lalu pada menit ke-15
 * scanner menyegarkannya lagi. Jumlah yang dilaporkan pun hanya mencerminkan
 * berapa pair yang terakhir dipindai — 30 tepat setelah pindai, 5 beberapa
 * saat kemudian.
 */
describe('Health check data pasar', () => {
  let svc: HealthService;
  let marketData: { cacheAges: jest.Mock };

  /** Satu entri cache berumur `umur` detik. */
  const entri = (key: string, umur: number, bars = 300) => ({
    key,
    ageSeconds: umur,
    bars,
  });

  beforeEach(() => {
    marketData = { cacheAges: jest.fn().mockReturnValue([]) };

    svc = Object.create(HealthService.prototype) as HealthService;
    Object.assign(svc, {
      marketData,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  const periksa = () => (svc as any).checkMarketData();

  // ─── Keadaan normal TIDAK boleh memicu alarm ─────────────────────────────

  it('entri 5m berumur 10 menit BUKAN kerusakan bila ada data yang baru', async () => {
    // Keadaan nyata beberapa menit setelah pemindaian: entri 5m menua di
    // tempat karena tidak ada yang memintanya lagi, sementara pengambilan
    // candle sendiri berjalan normal.
    marketData.cacheAges.mockReturnValue([
      entri('btcidr|5m', 700),
      entri('ethidr|5m', 700),
      entri('btcidr|1H', 40),
    ]);

    const r = await periksa();
    expect(r.status).not.toBe('ERROR');
    expect(r.label).not.toBe('STALE');
  });

  it('30 entri 5m yang menua sekaligus tetap bukan kerusakan', async () => {
    // Inilah bentuk peringatan palsu yang diterima operator: "30 timeframe 5m
    // tidak diperbarui lebih dari 10 menit".
    const ages = Array.from({ length: 30 }, (_, i) => entri(`pair${i}idr|5m`, 900));
    ages.push(entri('btcidr|1H', 30));
    marketData.cacheAges.mockReturnValue(ages);

    expect((await periksa()).label).not.toBe('STALE');
  });

  it('seluruh entri masih muda jelas sehat', async () => {
    marketData.cacheAges.mockReturnValue([entri('btcidr|5m', 20), entri('btcidr|1H', 45)]);

    const r = await periksa();
    expect(r.status).toBe('OK');
    expect(r.label).toBe('ONLINE');
  });

  // ─── Macet yang SUNGGUHAN harus tetap terdeteksi ─────────────────────────

  it('tidak ada satu pun candle baru dalam 25 menit = macet', async () => {
    // Penanda yang jujur: entri PALING BARU. Bila tidak ada apa pun yang
    // berhasil diambil lebih lama daripada jeda penyegar terjadwal,
    // pengambilannya memang macet.
    marketData.cacheAges.mockReturnValue([
      entri('btcidr|5m', 1800),
      entri('btcidr|1H', 2000),
      entri('ethidr|1H', 1700),
    ]);

    const r = await periksa();
    expect(r.status).toBe('ERROR');
    expect(r.label).toBe('STALE');
    expect(r.detail).toMatch(/Tidak ada candle yang berhasil diambil/);
  });

  it('pesan macet menyebut lama dan ambangnya, bukan jumlah entri', async () => {
    // Jumlah entri stale menyesatkan: ia mencerminkan berapa pair yang
    // terakhir dipindai, bukan tingkat kerusakan.
    marketData.cacheAges.mockReturnValue([entri('btcidr|1H', 1800)]);

    const r = await periksa();
    expect(r.detail).toMatch(/30 menit/);
    expect(r.detail).toMatch(/ambang 25 menit/);
    expect(r.detail).not.toMatch(/timeframe 5m/);
  });

  it('tepat di ambang belum dianggap macet', async () => {
    marketData.cacheAges.mockReturnValue([entri('btcidr|1H', 25 * 60)]);
    expect((await periksa()).label).not.toBe('STALE');
  });

  it('satu detik di atas ambang sudah dianggap macet', async () => {
    marketData.cacheAges.mockReturnValue([entri('btcidr|1H', 25 * 60 + 1)]);
    expect((await periksa()).label).toBe('STALE');
  });

  // ─── Keadaan lain tetap dilaporkan ───────────────────────────────────────

  it('cache kosong dilaporkan sebagai belum ada data, bukan macet', async () => {
    marketData.cacheAges.mockReturnValue([]);

    const r = await periksa();
    expect(r.status).toBe('UNKNOWN');
    expect(r.label).toBe('BELUM ADA DATA');
  });

  it('pair tanpa riwayat chart BUKAN gangguan, hanya diterangkan', async () => {
    // Sebagian pair aktif di Indodax memang tidak punya riwayat chart —
    // terukur pada SHOWIDR: volume Rp878 juta, naik 6,85%, tetapi 0 candle.
    // Melaporkannya sebagai gangguan membuat health kuning selamanya untuk
    // sesuatu yang tidak bisa diperbaiki, dan peringatan yang tak pernah
    // hilang akan diabaikan saat benar-benar ada masalah.
    marketData.cacheAges.mockReturnValue([
      entri('btcidr|1H', 30, 300),
      entri('showidr|5m', 40, 0),
    ]);

    const r = await periksa();
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/tanpa riwayat chart/);
    expect(r.detail).toMatch(/bukan gangguan bot/);
    expect(r.detail).toMatch(/showidr/);
  });

  it('macet diperiksa LEBIH DULU daripada entri kosong', async () => {
    // Bila pengambilan macet, entri kosong hanyalah akibat — dan melaporkan
    // akibat mengaburkan sebabnya.
    marketData.cacheAges.mockReturnValue([
      entri('btcidr|1H', 1800, 0),
      entri('ethidr|1H', 1900, 0),
    ]);

    expect((await periksa()).label).toBe('STALE');
  });
});
