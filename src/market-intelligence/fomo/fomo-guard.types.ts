/**
 * Gerbang FOMO — menolak entry yang mengejar gerakan yang sudah terjadi.
 *
 * Mengapa lapisan ini ada, dan mengapa khususnya untuk memecoin:
 *
 * Seluruh filter lain menanyakan "apakah arahnya benar?". Tidak satu pun
 * menanyakan "apakah kita sudah terlambat?". Pada pair bergerak lambat
 * perbedaannya kecil. Pada memecoin perbedaannya menentukan hasil — kenaikan
 * 30% dalam dua jam membuat SELURUH indikator tren terlihat sempurna justru
 * pada titik di mana risikonya paling besar. EMA tersusun naik, momentum kuat,
 * volume melonjak, RSI tinggi. Semua sinyal menyala tepat ketika gerakannya
 * sudah habis.
 *
 * Itulah bentuk FOMO yang merugikan: bukan perasaan, melainkan kondisi pasar
 * yang secara sistematis menipu indikator. Gerbang ini mengukurnya.
 *
 * Seperti lapisan luar lainnya, ia HANYA MENOLAK. Tidak adanya tanda FOMO
 * bukan alasan untuk membeli.
 */

export type FomoSeverity = 'NONE' | 'WATCH' | 'BLOCK';

/** Satu tanda bahwa harga sudah berjalan terlalu jauh. */
export interface FomoSignal {
  code:
    | 'PRICE_ALREADY_RAN'
    | 'EXTENDED_FROM_MEAN'
    | 'PARABOLIC'
    | 'BLOWOFF_VOLUME'
    | 'OVERBOUGHT_STACK'
    | 'HYPE_WITHOUT_STRUCTURE';
  /** Penjelasan siap tampil, memuat angkanya. */
  detail: string;
  /** Seberapa jauh ambangnya terlampaui, 0-1 setelah dibatasi. */
  magnitude: number;
}

export interface FomoAssessment {
  /** 0-100. Lebih tinggi = makin terlambat untuk masuk. */
  score: number;
  severity: FomoSeverity;
  signals: FomoSignal[];
  /** Alasan tegas menolak; kosong bila tidak memblokir. */
  blockers: string[];
  /**
   * True bila data yang dibutuhkan tidak lengkap.
   *
   * Dibedakan dari "tidak ada FOMO": tidak tahu bukan sama dengan aman.
   * Pemanggil tidak boleh membaca ini sebagai izin.
   */
  inconclusive: boolean;
  caveat: string;
}

export interface FomoThresholds {
  /**
   * Kenaikan persen dalam `lookbackBars` yang dianggap "sudah berjalan".
   *
   * Dinyatakan sebagai KELIPATAN ATR, bukan persen tetap. Kenaikan 10% pada
   * BTC (ATR 0,36%) adalah 28 kali gejolak normalnya — peristiwa luar biasa.
   * Kenaikan 10% pada FARTCOIN (ATR 1,66%) hanya 6 kali, masih dalam wajar.
   * Satu ambang persen akan salah untuk salah satunya.
   */
  runAtrMultiple: number;
  lookbackBars: number;
  /** Jarak harga di atas EMA21 yang dianggap terlalu jauh, kelipatan ATR. */
  extensionAtrMultiple: number;
  /** Jumlah bar naik berurutan sebelum dianggap parabolik. */
  consecutiveUpBars: number;
  /** Volume relatif yang dianggap blow-off saat harga sudah terentang. */
  blowoffRelativeVolume: number;
  /** RSI di atas ini pada timeframe acuan dianggap jenuh beli. */
  overboughtRsi: number;
  /** Skor FOMO di atas ini menolak entry. */
  blockAboveScore: number;
}

/**
 * Ambang bawaan.
 *
 * Dinyatakan relatif terhadap ATR agar satu set angka berlaku untuk BTC maupun
 * memecoin. Tidak ada backtest yang membenarkan angka-angka ini — dan itu
 * disengaja: mengoptimalkannya pada data lampau hanya menghasilkan kecocokan
 * palsu. Ia dipasang untuk MENOLAK kasus yang jelas, bukan untuk memilih entry.
 */
export const DEFAULT_FOMO: FomoThresholds = {
  runAtrMultiple: 6,
  lookbackBars: 12,
  extensionAtrMultiple: 2.5,
  consecutiveUpBars: 5,
  blowoffRelativeVolume: 3,
  overboughtRsi: 75,
  blockAboveScore: 60,
};

/**
 * Ambang yang lebih ketat untuk pair bergejolak tinggi.
 *
 * Memecoin bergerak pada hype, dan hype berbalik lebih cepat daripada tren.
 * Yang diperketat bukan ATR-nya (itu sudah dinormalkan), melainkan toleransi
 * terhadap pengejaran: lebih sedikit bar naik berurutan yang diterima, dan
 * ambang blokir lebih rendah.
 */
export const STRICT_FOMO: FomoThresholds = {
  ...DEFAULT_FOMO,
  runAtrMultiple: 4,
  extensionAtrMultiple: 1.8,
  consecutiveUpBars: 4,
  blowoffRelativeVolume: 2.5,
  overboughtRsi: 70,
  blockAboveScore: 45,
};

export const FOMO_CAVEAT =
  'Gerbang FOMO hanya menolak entry yang mengejar gerakan yang sudah terjadi. ' +
  'Tidak adanya tanda FOMO BUKAN alasan untuk membeli.';
