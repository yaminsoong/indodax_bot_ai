/**
 * Tipe untuk lapisan Global Market (LEVEL 6 roadmap).
 *
 * Alasan lapisan ini ada: trader crypto tidak cukup melihat candle crypto.
 * Ketika DXY menguat atau yield naik tajam, aset berisiko tertekan bersamaan
 * dan setup teknikal yang tampak sempurna gagal karena sebab di luar chart.
 *
 * PERINGATAN PENTING YANG MELEKAT PADA SELURUH LAPISAN INI: korelasi antara
 * crypto dan aset makro TIDAK stabil. BTC pernah bergerak searah NASDAQ, pernah
 * berlawanan, pernah tidak berhubungan sama sekali. Karena itu skor di sini
 * dipakai HANYA untuk menahan entry saat kondisi jelas buruk — bukan untuk
 * menciptakan sinyal beli. Lihat `GlobalRiskAssessment.caveat`.
 */

/** Instrumen makro yang dipantau. */
export type GlobalSymbol =
  | 'SP500'
  | 'NASDAQ'
  | 'DXY'
  | 'GOLD'
  | 'OIL'
  | 'US10Y'
  | 'VIX';

/**
 * Arah pengaruh instrumen terhadap aset berisiko.
 *
 * `POSITIVE` berarti instrumen naik = kondisi lebih mendukung risiko
 * (saham naik). `INVERSE` berarti instrumen naik = kondisi menekan risiko
 * (DXY, yield, VIX naik).
 */
export type RiskPolarity = 'POSITIVE' | 'INVERSE';

export interface GlobalSymbolSpec {
  symbol: GlobalSymbol;
  /** Simbol di sumber data (Yahoo Finance). */
  source: string;
  label: string;
  polarity: RiskPolarity;
  /** Bobot dalam skor risiko global. Total seluruh instrumen = 100. */
  weight: number;
  /**
   * Perubahan persen yang dianggap "besar" untuk instrumen ini.
   *
   * Dipisah per instrumen karena skalanya sangat berbeda: DXY bergerak 0,5%
   * sehari itu besar, sementara VIX 5% sehari masih biasa. Memakai satu ambang
   * untuk semuanya membuat VIX mendominasi skor sepenuhnya.
   */
  significantMovePercent: number;
}

/** Satu instrumen beserta harga terakhirnya. */
export interface GlobalQuote {
  symbol: GlobalSymbol;
  label: string;
  price: number;
  previousClose: number;
  changePercent: number;
  /** Waktu harga terakhir menurut sumber data. */
  quotedAt: string;
  /**
   * Umur data dalam jam.
   *
   * Pasar saham tutup malam dan akhir pekan sementara crypto jalan terus.
   * Tanpa angka ini, harga penutupan hari Jumat terbaca sebagai kondisi
   * hari Minggu — kesalahan yang tidak menimbulkan galat apa pun.
   */
  ageHours: number;
  /** True bila data terlalu tua untuk dipercaya sebagai kondisi saat ini. */
  stale: boolean;
}

export type GlobalRegime = 'RISK_ON' | 'MIXED' | 'RISK_OFF';

export interface GlobalRiskAssessment {
  /**
   * 0-100. Lebih tinggi = kondisi makro lebih mendukung aset berisiko.
   *
   * Ini BUKAN probabilitas apa pun. Ia hanya ringkasan berbobot dari beberapa
   * perubahan harga, dan hanya sebaik asumsi korelasi di baliknya.
   */
  score: number;
  regime: GlobalRegime;
  quotes: GlobalQuote[];
  /** Instrumen yang paling menarik skor ke bawah, untuk ditampilkan. */
  drivers: string[];
  /** Instrumen yang gagal diambil, agar tidak diam-diam dianggap netral. */
  unavailable: GlobalSymbol[];
  /** Jumlah instrumen yang datanya kedaluwarsa (pasar tutup). */
  staleCount: number;
  /**
   * True bila data yang terkumpul tidak cukup untuk menyimpulkan apa pun.
   * Pemanggil WAJIB memperlakukan ini sebagai "tidak tahu", bukan "netral".
   */
  inconclusive: boolean;
  caveat: string;
  assessedAt: string;
}

/**
 * Bobot dipilih dari apa yang paling konsisten dibicarakan sebagai penggerak
 * aset berisiko, bukan dari hasil optimasi — tidak ada backtest yang
 * membenarkan angka-angka ini, dan itu disengaja: mengoptimalkannya pada data
 * lampau hanya akan menghasilkan korelasi palsu.
 */
export const GLOBAL_SYMBOLS: GlobalSymbolSpec[] = [
  { symbol: 'SP500', source: '^GSPC', label: 'S&P 500', polarity: 'POSITIVE', weight: 18, significantMovePercent: 1.0 },
  { symbol: 'NASDAQ', source: '^IXIC', label: 'NASDAQ', polarity: 'POSITIVE', weight: 22, significantMovePercent: 1.2 },
  { symbol: 'DXY', source: 'DX-Y.NYB', label: 'Dolar (DXY)', polarity: 'INVERSE', weight: 18, significantMovePercent: 0.5 },
  { symbol: 'US10Y', source: '^TNX', label: 'Yield 10Y AS', polarity: 'INVERSE', weight: 15, significantMovePercent: 2.0 },
  { symbol: 'VIX', source: '^VIX', label: 'VIX', polarity: 'INVERSE', weight: 15, significantMovePercent: 8.0 },
  { symbol: 'GOLD', source: 'GC=F', label: 'Emas', polarity: 'POSITIVE', weight: 6, significantMovePercent: 1.0 },
  { symbol: 'OIL', source: 'CL=F', label: 'Minyak', polarity: 'INVERSE', weight: 6, significantMovePercent: 2.5 },
];

export const GLOBAL_CAVEAT =
  'Korelasi crypto dengan aset makro tidak stabil dan berubah antar periode. ' +
  'Skor ini hanya dipakai untuk menahan entry saat kondisi jelas buruk, ' +
  'bukan sebagai alasan untuk membeli.';
