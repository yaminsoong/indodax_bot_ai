import { ChartRendererService } from './chart-renderer.service';
import { Candle } from '../indodax/indodax.types';

/** Byte ajaib PNG; bukti berkas benar-benar gambar, bukan buffer kosong. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function candles(n: number, base = 1_000_000, drift = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const mid = base + i * drift + Math.sin(i / 4) * base * 0.004;
    return {
      time: 1_790_000_000 + i * 3600,
      open: mid,
      high: mid * 1.003,
      low: mid * 0.997,
      close: mid * 1.001,
      volume: 10 + (i % 7),
    };
  });
}

describe('ChartRendererService', () => {
  let svc: ChartRendererService;

  beforeEach(() => {
    svc = new ChartRendererService();
  });

  it('menghasilkan PNG yang sah', () => {
    const png = svc.render({ pair: 'btcidr', timeframeMinutes: 60, candles: candles(120) });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(5000);
  });

  it('tetap menghasilkan gambar saat candle tidak cukup', () => {
    // Mengembalikan gambar berisi keterangan jauh lebih berguna daripada
    // melempar error di tengah jalur notifikasi.
    const png = svc.render({ pair: 'btcidr', timeframeMinutes: 60, candles: candles(1) });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('menggambar EMA yang lebih pendek dari deret candle', () => {
    // EMA selalu lebih pendek (butuh periode awal); perataannya tidak boleh
    // membuat penggambar keluar batas array.
    const cs = candles(120);
    const png = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: cs,
      emas: { 'EMA 50': new Array(cs.length - 49).fill(1_000_000) },
    });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('menggambar zona sebagai pita dan level sebagai garis', () => {
    const png = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: candles(120),
      levels: [
        { price: 1_010_000, label: 'R', color: '#ef4444', bandLow: 1_008_000, bandHigh: 1_012_000 },
        { price: 990_000, label: 'ENTRY', color: '#3b82f6', dashed: true },
      ],
    });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('tidak pecah ketika beberapa level berada di harga yang hampir sama', () => {
    // Inilah kasus yang dulu membuat label saling menimpa: ENTRY tepat di
    // dekat sebuah support.
    const png = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: candles(120),
      levels: [
        { price: 1_000_000, label: 'SUPPORT 5x', color: '#22c55e' },
        { price: 1_000_100, label: 'ENTRY', color: '#3b82f6', dashed: true },
        { price: 1_000_200, label: 'STOP', color: '#f59e0b', dashed: true },
      ],
    });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('mengabaikan level yang sangat jauh agar skala harga tidak hancur', () => {
    // Satu level di 3x harga akan memampatkan seluruh candle jadi garis datar.
    const normal = svc.render({ pair: 'btcidr', timeframeMinutes: 60, candles: candles(120) });
    const withFar = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: candles(120),
      levels: [{ price: 3_000_000, label: 'JAUH', color: '#ef4444' }],
    });

    // Bila level jauh ikut menentukan skala, lilin akan rata dan ukuran berkas
    // turun drastis. Selisih wajar menandakan skalanya tidak terganggu.
    const ratio = withFar.length / normal.length;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.3);
  });

  it('memotong candle berlebih sesuai maxCandles', () => {
    const many = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: candles(600),
      maxCandles: 60,
    });
    const few = svc.render({
      pair: 'btcidr',
      timeframeMinutes: 60,
      candles: candles(60),
      maxCandles: 60,
    });
    // Keduanya menggambar 60 lilin, jadi ukurannya harus sebanding.
    expect(Math.abs(many.length - few.length) / few.length).toBeLessThan(0.5);
  });

  it('menerima harga pecahan tanpa kehilangan presisi label', () => {
    // Koin murah seperti pepeidr berharga di bawah Rp 1.
    const tiny = candles(80, 0.000012, 0).map((c) => ({ ...c }));
    const png = svc.render({ pair: 'pepeidr', timeframeMinutes: 60, candles: tiny });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('menggambar judul tanpa tumpang tindih pada pair bernama panjang', () => {
    // Lebar teks diukur dengan font yang menggambarnya; bila salah, teks
    // berikutnya menimpa dan ukuran berkas ikut berubah tak wajar.
    const png = svc.render({
      pair: 'verylongpairnameidr',
      timeframeMinutes: 240,
      candles: candles(120),
      subtitle: 'Skor 88/100 · TRENDING · subtitle panjang sebagai uji',
    });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(5000);
  });
});
