export interface TakeProfitLevel {
  /** Kelipatan risiko tempat tingkat ini dipicu. */
  atR: number;
  /** Porsi posisi AWAL yang ditutup di tingkat ini, dalam persen. */
  closePercent: number;
}

/**
 * Rapikan daftar tingkat take profit agar selalu aman dipakai.
 *
 * Diterapkan di TITIK PAKAI, bukan hanya saat membaca `.env`. Parameter bisa
 * masuk dari beberapa jalur — berkas konfigurasi, override database, dan
 * `paramOverrides` pada backtest — dan pengaman yang hanya dipasang di salah
 * satunya akan terlewati diam-diam oleh yang lain. Total porsi melebihi 100%
 * berarti bot mencoba menjual lebih banyak daripada yang dimilikinya:
 * exchange menolak di tengah jalan dan posisi tertinggal setengah tertutup.
 */
export function normalizeTakeProfitLevels(
  levels: readonly TakeProfitLevel[] | undefined | null,
): TakeProfitLevel[] {
  if (!levels?.length) return [];

  const valid = levels
    .filter((l) => Number.isFinite(l.atR) && l.atR > 0 && Number.isFinite(l.closePercent) && l.closePercent > 0)
    .sort((a, b) => a.atR - b.atR);

  let budget = 100;
  const out: TakeProfitLevel[] = [];

  for (const level of valid) {
    if (budget <= 0) break;
    out.push({ atR: level.atR, closePercent: Math.min(level.closePercent, budget) });
    budget -= level.closePercent;
  }

  // Tingkat terakhir menyerap sisa porsi, supaya tidak ada remah posisi yang
  // tertinggal di bawah minimum order dan mustahil dijual.
  if (out.length && budget > 0) out[out.length - 1].closePercent += budget;

  return out;
}
