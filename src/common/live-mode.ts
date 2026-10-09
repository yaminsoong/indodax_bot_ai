export type TradingMode = 'SIMULATION' | 'LIVE';

/** Nilai persis yang harus diisikan pada LIVE_TRADING_CONFIRMED. */
export const LIVE_CONFIRMATION_PHRASE = 'I_UNDERSTAND_REAL_MONEY';

export interface LiveModeResolution {
  mode: TradingMode;
  /** Mode yang diminta konfigurasi, sebelum penjagaan diterapkan. */
  requested: TradingMode;
  /** Terisi bila LIVE diminta tetapi ditolak. */
  blockedReason?: string;
}

/**
 * Menentukan mode trading yang benar-benar berlaku.
 *
 * LIVE membutuhkan DUA pernyataan terpisah (bagian 20 dan 25 spesifikasi):
 *
 *   TRADING_MODE=LIVE
 *   LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY
 *
 * Alasannya sederhana: TRADING_MODE adalah satu kata yang gampang tersalin
 * dari contoh konfigurasi, tertinggal dari sesi pengujian, atau ikut terbawa
 * saat menyalin .env dari mesin lain. Frasa konfirmasi tidak pernah muncul
 * secara kebetulan — seseorang harus mengetiknya dengan sadar.
 *
 * Bila LIVE diminta tanpa konfirmasi, bot TIDAK berhenti. Ia turun ke
 * SIMULATION dan menyatakannya dengan keras. Berhenti total akan membuat bot
 * mati justru saat operator mengira ia sedang berjalan; turun ke simulasi
 * menjaga pemantauan tetap hidup tanpa mempertaruhkan uang.
 *
 * @param get pembaca konfigurasi (env atau override database).
 */
export function resolveTradingMode(get: (key: string) => string | undefined): LiveModeResolution {
  const requested: TradingMode =
    (get('TRADING_MODE') ?? 'SIMULATION').toUpperCase() === 'LIVE' ? 'LIVE' : 'SIMULATION';

  if (requested !== 'LIVE') return { mode: 'SIMULATION', requested };

  const confirmation = (get('LIVE_TRADING_CONFIRMED') ?? '').trim();
  if (confirmation !== LIVE_CONFIRMATION_PHRASE) {
    return {
      mode: 'SIMULATION',
      requested,
      blockedReason:
        `TRADING_MODE=LIVE diminta, tetapi LIVE_TRADING_CONFIRMED belum berisi ` +
        `"${LIVE_CONFIRMATION_PHRASE}". Bot berjalan dalam mode SIMULATION. ` +
        `Isi nilai itu hanya setelah backtest, walk-forward, dan uji simulasi ` +
        `benar-benar diperiksa.`,
    };
  }

  return { mode: 'LIVE', requested };
}
