/**
 * Helper numerik untuk harga & kuantitas order.
 *
 * Indodax menetapkan `pricescale` (tick harga) per pair — mis. btcidr = 1000
 * (harga harus kelipatan Rp 1.000) dan pepeidr = 0.000001. Membulatkan harga
 * dengan Math.floor() jelas salah untuk pair berharga di bawah Rp 1.
 */

/**
 * Toleransi relatif untuk mengoreksi galat representasi biner.
 *
 * `1.005 / 0.01` menghasilkan 100.49999999999999, bukan 100.5, karena 1.005
 * tidak bisa direpresentasikan tepat sebagai double. Tanpa koreksi, nilai yang
 * secara desimal tepat di batas setengah tick akan dibulatkan ke arah yang
 * salah. Toleransi ini jauh lebih kecil daripada presisi harga mana pun,
 * sehingga tidak pernah mempengaruhi nilai yang benar-benar berbeda.
 */
const FP_TOLERANCE = 1e-12;

/** Bulatkan ke kelipatan `step` terdekat. */
export function roundToStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  const quotient = value / step;
  const corrected = quotient + Math.sign(quotient) * Math.abs(quotient) * FP_TOLERANCE;
  return round(Math.round(corrected) * step, decimalsOf(step));
}

/** Bulatkan ke bawah ke kelipatan `step` (untuk kuantitas jual: jangan melebihi saldo). */
export function floorToStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  const quotient = value / step;
  // Koreksi hanya sebesar galat representasi, agar 0.12345678 tidak terpotong
  // menjadi 0.12345677 hanya karena hasil baginya 12345677.999999998.
  const corrected = quotient + Math.abs(quotient) * FP_TOLERANCE;
  return round(Math.floor(corrected) * step, decimalsOf(step));
}

/** Pembulatan desimal yang tahan galat floating point. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Potong ke bawah pada N desimal (tidak pernah membulatkan naik). */
export function floorDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

/** Jumlah desimal yang dibutuhkan untuk merepresentasikan `step`. */
export function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const s = step.toExponential();
  const [mantissa, expPart] = s.split('e');
  const exp = parseInt(expPart, 10);
  const mantissaDecimals = (mantissa.split('.')[1] || '').length;
  return Math.max(0, mantissaDecimals - exp);
}

/**
 * Format angka sebagai string desimal biasa (tanpa notasi eksponen).
 * Indodax menolak "1e-7"; harus dikirim sebagai "0.0000001".
 */
export function toPlainString(value: number, maxDecimals: number): string {
  const fixed = value.toFixed(Math.min(Math.max(maxDecimals, 0), 20));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rata-rata aritmetik; mengembalikan 0 untuk array kosong. */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Standar deviasi populasi. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** Format rupiah untuk log & pesan Telegram. */
export function idr(value: number): string {
  return `Rp ${Math.round(value).toLocaleString('id-ID')}`;
}

/** Format harga dengan desimal secukupnya (koin murah butuh banyak desimal). */
export function fmtPrice(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString('id-ID');
  if (value >= 1) return value.toFixed(2);
  return toPlainString(value, 8);
}
