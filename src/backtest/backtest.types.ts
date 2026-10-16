import { BotParams } from '../config/bot-config.service';

export interface BacktestConfig {
  pairs: string[];
  timeframe: number;
  /** Jumlah candle historis yang diuji. */
  bars: number;
  /**
   * Jumlah candle TERBARU yang dibuang sebelum pengujian.
   *
   * Endpoint chart selalu mengembalikan N candle terakhir, sehingga tanpa
   * offset ini mustahil memilih potongan waktu di tengah riwayat — dan
   * walk-forward akan menguji rentang yang sama berulang kali.
   */
  barsOffsetFromEnd?: number;
  initialCapital: number;
  /**
   * Hentikan pengujian setelah N kerugian beruntun, seperti LIVE.
   *
   * Default FALSE, dan itu keputusan sadar. Di LIVE, kill switch kerugian
   * beruntun adalah lapisan PELINDUNG MODAL yang menuntut manusia menilai
   * ulang: `getConsecutiveLosses` hanya bersih setelah ada trade untung, dan
   * selama entry diblokir trade untung tidak mungkin terjadi. Di LIVE itu
   * benar — ada operator yang bisa mengubah setelan atau turun tangan.
   *
   * Di backtest TIDAK ADA operator. Mengaktifkannya berarti setiap pengujian
   * berhenti di deret rugi PERTAMA lalu tetap melaporkan periode penuh.
   * Terukur pada 16 Okt 2026: uji 25 pair / 102 hari hanya benar-benar
   * berdagang 4 HARI (4% periode), uji 8 pair / 60 hari hanya 16 hari (27%).
   * Seluruh pengukuran hari itu — P&L kotor, perbandingan maker, sweep offset
   * — diam-diam dihitung dari potongan sekecil itu.
   *
   * Keunggulan strategi dan pelindung modal adalah dua hal berbeda. Yang
   * pertama diukur di sini; yang kedua dilaporkan terpisah lewat
   * `killSwitchWouldFireAt`.
   */
  haltOnConsecutiveLosses?: boolean;
  strategy: string;
  /** Fee taker per sisi dalam persen; default mengikuti data pair Indodax. */
  feePercentOverride?: number;
  /** Slippage tambahan per sisi (persen) di atas fee. */
  slippagePercent: number;
  /**
   * Modelkan entry sebagai order maker: fee separuh, tetapi order hanya terisi
   * bila harga bar berikutnya benar-benar turun menyentuh level limit kita.
   * Tanpa syarat sentuhan itu, backtest akan memberi diskon fee sekaligus
   * eksekusi sempurna — kombinasi yang tidak ada di dunia nyata.
   */
  makerEntry?: boolean;
  /** Seberapa jauh di bawah harga acuan order maker dipasang (persen). */
  makerOffsetPercent?: number;
  /**
   * Spread pasar per sisi dalam persen, bila diketahui.
   *
   * Terpisah dari slippage: slippage adalah pergerakan harga saat order
   * diproses, spread adalah biaya menyeberangi buku order. Keduanya nyata dan
   * keduanya dibebankan pada order taker.
   */
  spreadPercent?: number;
  /**
   * Jalankan Market Intelligence pada setiap sinyal BUY.
   *
   * Timeframe tambahan DIBENTUK dengan mengagregasi candle yang sudah ada,
   * bukan dengan mengambil data baru — agregasi hanya memakai bar yang sudah
   * tertutup, sehingga tidak ada satu pun informasi masa depan yang bocor.
   */
  useIntelligence?: boolean;
  /** Override sebagian parameter untuk keperluan sweep. */
  paramOverrides?: Partial<BotParams>;
}

export interface BacktestTrade {
  pair: string;
  strategy: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  positionValue: number;
  stopLoss: number;
  takeProfit: number;
  /** P&L bersih setelah fee dan slippage. */
  profitLoss: number;
  profitLossPercent: number;
  rMultiple: number;
  fees: number;
  closeReason: string;
  holdingBars: number;
  /** Keuntungan mengambang tertinggi (Maximum Favourable Excursion), dalam R. */
  mfeR: number;
  /** Kerugian mengambang terdalam (Maximum Adverse Excursion), dalam R. */
  maeR: number;
  reasons: string[];
  /** Skor Market Intelligence saat entry; null bila lapisan itu tidak aktif. */
  intelligenceScore?: number | null;
  /** Regime pasar saat entry. */
  marketRegime?: string | null;
  /** Keputusan Market Intelligence saat entry. */
  intelligenceDecision?: string | null;
}

/** Irisan performa menurut satu dimensi (bucket skor, regime, dan sebagainya). */
export interface PerformanceSlice {
  label: string;
  trades: number;
  winRate: number;
  expectancyR: number;
  /** Galat baku ekspektasi — irisan bersampel kecil selalu tidak bisa dipercaya. */
  expectancyStdErrorR: number;
  netProfit: number;
  profitFactor: number | null;
  avgHoldingBars: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdownPercent: number;
  openPositions: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  initialCapital: number;
  finalEquity: number;
  totalReturnPercent: number;
  /** Return tahunan setara (CAGR). */
  annualizedReturnPercent: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  totalFees: number;
  /** Porsi profit kotor yang habis dimakan biaya. */
  feeDragPercent: number | null;
  profitFactor: number | null;
  expectancyR: number;
  /** Simpangan baku R per trade — dasar menghitung ketidakpastian ekspektasi. */
  expectancyStdevR: number;
  /** Galat baku ekspektasi (stdev / akar n). Makin kecil, makin bisa dipercaya. */
  expectancyStdErrorR: number;
  avgWinR: number;
  avgLossR: number;
  maxDrawdownPercent: number;
  maxDrawdownIdr: number;
  /** Kerugian beruntun terpanjang. */
  maxConsecutiveLosses: number;
  maxConsecutiveWins: number;
  sharpeRatio: number;
  sortinoRatio: number;
  /** Return tahunan dibagi drawdown maksimum. */
  calmarRatio: number | null;
  avgHoldingBars: number;
  exposurePercent: number;
  closeReasons: Record<string, number>;
  perPair: Record<string, { trades: number; netProfit: number; winRate: number }>;
  /**
   * Performa dipecah menurut bucket skor Market Intelligence.
   *
   * Inilah satu-satunya cara membuktikan apakah skor tinggi benar-benar lebih
   * menguntungkan. Jangan pernah mengasumsikannya — bagian 15 spesifikasi.
   */
  byScoreBucket: PerformanceSlice[];
  /** Performa dipecah menurut regime pasar saat entry. */
  byRegime: PerformanceSlice[];
  /** Ringkasan Market Intelligence selama backtest. */
  intelligence: {
    enabled: boolean;
    /** Sinyal strategi yang ditolak Market Intelligence. */
    rejected: number;
    /** Sinyal strategi yang diloloskan. */
    accepted: number;
    avgScore: number | null;
    /** Alasan penolakan terbanyak. */
    topRejections: Array<{ reason: string; count: number }>;
  };
}

export interface BacktestReport {
  config: BacktestConfig;
  /**
   * Rentang yang BENAR-BENAR berdagang, bukan rentang yang diminta.
   *
   * `barsTested` menghitung bar yang dilewati simulasi; angka itu bisa jauh
   * lebih besar daripada bar yang masih membuka posisi bila ada yang
   * menghentikan entry di tengah jalan. Melaporkan hanya `barsTested`
   * membuat hasil dari 4 hari tampak sebagai hasil 102 hari.
   */
  tradedSpan: {
    firstEntry: string | null;
    lastExit: string | null;
    daysRequested: number;
    daysTraded: number;
    percentOfPeriod: number;
  };
  /**
   * Kapan kill switch kerugian beruntun AKAN menyala, bila diaktifkan.
   *
   * Selalu dihitung, bahkan ketika kill switch tidak diaktifkan — informasinya
   * tetap berharga: ia memberi tahu kapan seorang operator LIVE akan dipaksa
   * berhenti dan menilai ulang.
   */
  killSwitchWouldFireAt: string | null;
  params: BotParams;
  periodStart: string;
  periodEnd: string;
  barsTested: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  /** Peringatan tentang keterbatasan hasil (data pendek, trade terlalu sedikit, dsb). */
  warnings: string[];
}

export interface WalkForwardWindow {
  label: string;
  inSampleStart: string;
  inSampleEnd: string;
  outOfSampleStart: string;
  outOfSampleEnd: string;
  bestParams: Record<string, number>;
  inSampleReturn: number;
  outOfSampleReturn: number;
  outOfSampleTrades: number;
  outOfSampleMaxDd: number;
}
