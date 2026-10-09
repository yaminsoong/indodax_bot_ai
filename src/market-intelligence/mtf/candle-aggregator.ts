import { Candle } from '../../indodax/indodax.types';

/**
 * Gabungkan candle timeframe kecil menjadi timeframe besar.
 *
 * Dibutuhkan karena endpoint chart Indodax hanya menerima timeframe
 * 1, 5, 15, 30, 60, dan 240 menit. Candle HARIAN tidak bisa diminta langsung
 * (tf=1440 ditolak dan mengembalikan data kosong tanpa pesan galat), jadi
 * candle 1D dibentuk dari enam candle 4H.
 *
 * @param candles candle sumber, urut menaik menurut waktu.
 * @param targetMinutes panjang candle hasil dalam menit (mis. 1440 untuk 1D).
 * @param sourceMinutes panjang candle sumber dalam menit (mis. 240 untuk 4H).
 */
export function aggregateCandles(
  candles: Candle[],
  targetMinutes: number,
  sourceMinutes: number,
): Candle[] {
  if (!candles.length) return [];
  if (targetMinutes <= sourceMinutes) return candles;

  const bucketSec = targetMinutes * 60;
  const sourceSec = sourceMinutes * 60;
  const expectedPerBucket = Math.round(bucketSec / sourceSec);

  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const key = Math.floor(c.time / bucketSec) * bucketSec;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }

  const lastSourceTime = candles[candles.length - 1].time;
  const out: Candle[] = [];

  for (const [key, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    /**
     * Hanya bucket yang PERIODENYA SUDAH LEWAT yang boleh dipakai.
     *
     * Bucket terakhir hampir selalu belum lengkap - ia baru berisi sebagian
     * candle 4H dari hari yang sedang berjalan. Memakainya sama saja dengan
     * menghitung indikator pada candle yang belum tutup: nilainya berubah tiap
     * beberapa jam dan hasil backtest tidak bisa direproduksi.
     */
    const bucketEnd = key + bucketSec;
    const complete = lastSourceTime + sourceSec >= bucketEnd;
    if (!complete) continue;

    // Bucket dengan candle bolong (data exchange hilang) dilewati: OHLC-nya
    // akan salah dan lebih berbahaya daripada tidak ada data sama sekali.
    if (group.length < expectedPerBucket) continue;

    const sorted = group.sort((a, b) => a.time - b.time);
    out.push({
      time: key,
      open: sorted[0].open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((s, c) => s + c.volume, 0),
    });
  }

  return out;
}
