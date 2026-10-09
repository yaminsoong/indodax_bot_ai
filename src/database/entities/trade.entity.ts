import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TradeStatus = 'PENDING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'CANCELLED' | 'FAILED';
export type TradeType = 'BUY' | 'SELL';
export type TradeMode = 'SIMULATION' | 'LIVE' | 'BACKTEST';

@Entity('trades')
@Index(['status'])
@Index(['pair', 'status'])
export class Trade {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  pair: string;

  @Column({ type: 'text' })
  type: TradeType;

  /**
   * PENDING  = order masuk, belum dikonfirmasi terisi
   * OPEN     = posisi aktif (sudah terkonfirmasi fill)
   * CLOSING  = order jual sudah dikirim, menunggu fill
   * FAILED   = order gagal / tidak terisi sampai timeout
   */
  @Column({ type: 'text' })
  status: TradeStatus;

  @Column({ type: 'text' })
  mode: TradeMode;

  /** Strategi yang memicu trade ini — untuk membandingkan performa antar strategi. */
  @Column({ type: 'text', default: 'UNKNOWN' })
  strategy: string;

  // ─── Entry ────────────────────────────────────────────────────────────────

  /** Harga entry sesungguhnya dari exchange (bukan harga sinyal). */
  @Column({ type: 'real' })
  entryPrice: number;

  /** Harga saat sinyal muncul — selisihnya dengan entryPrice adalah slippage. */
  @Column({ type: 'real', default: 0 })
  signalPrice: number;

  /**
   * Zona entry yang disetujui strategi.
   *
   * Dicatat agar bisa diperiksa belakangan apakah entry yang benar-benar
   * terjadi berada di dalam zona, atau bot mengejar harga yang sudah lari.
   */
  @Column({ type: 'real', nullable: true })
  entryZoneLow: number;

  @Column({ type: 'real', nullable: true })
  entryZoneHigh: number;

  /** Kuantitas koin yang benar-benar diterima (setelah fee). */
  @Column({ type: 'real' })
  quantity: number;

  /** Kuantitas yang masih dipegang; berkurang saat partial take profit. */
  @Column({ type: 'real', default: 0 })
  remainingQuantity: number;

  /** Nilai IDR yang dikeluarkan termasuk fee. */
  @Column({ type: 'real' })
  totalValue: number;

  @Column({ type: 'real', default: 0 })
  entryFee: number;

  @Column({ nullable: true })
  entryOrderId: string;

  // ─── Exit ─────────────────────────────────────────────────────────────────

  @Column({ type: 'real', nullable: true })
  exitPrice: number;

  @Column({ type: 'real', default: 0 })
  exitFee: number;

  @Column({ nullable: true })
  exitOrderId: string;

  /** P&L bersih setelah seluruh fee. */
  @Column({ type: 'real', nullable: true })
  profitLoss: number;

  @Column({ type: 'real', nullable: true })
  profitLossPercent: number;

  /** P&L dalam satuan R (kelipatan risiko awal) — metrik utama evaluasi sistem. */
  @Column({ type: 'real', nullable: true })
  rMultiple: number;

  /** Profit yang sudah direalisasi dari partial take profit. */
  @Column({ type: 'real', default: 0 })
  realizedPnl: number;

  // ─── Manajemen risiko ─────────────────────────────────────────────────────

  @Column({ type: 'real' })
  stopLossPrice: number;

  @Column({ type: 'real' })
  takeProfitPrice: number;

  @Column({ type: 'real', nullable: true })
  trailingStopPrice: number;

  /** Jarak risiko awal per koin (entry - stop). Basis perhitungan R. */
  @Column({ type: 'real', default: 0 })
  initialRiskPerUnit: number;

  /** Nilai IDR yang dipertaruhkan saat entry. */
  @Column({ type: 'real', default: 0 })
  riskAmountIdr: number;

  @Column({ type: 'integer', default: 0 })
  breakEvenMoved: number;

  /**
   * Jumlah tingkat take profit yang sudah tereksekusi (0-3).
   *
   * Menggantikan flag biner `partialTaken`: dengan tiga tingkat, bot perlu
   * tahu BERAPA yang sudah lewat, bukan sekadar apakah pernah ada partial.
   */
  @Column({ type: 'integer', default: 0 })
  tpLevelsFilled: number;

  /** Harga tiap tingkat take profit, disimpan sebagai JSON saat posisi dibuka. */
  @Column({ type: 'text', nullable: true })
  takeProfitPlan: string;

  /** Dipertahankan agar data lama tetap terbaca; tidak lagi ditulis. */
  @Column({ type: 'integer', default: 0 })
  partialTaken: number;

  /** Harga terbaik yang pernah dicapai — untuk menghitung MFE. */
  @Column({ type: 'real', default: 0 })
  highestPrice: number;

  /** Harga terburuk yang pernah dicapai — untuk menghitung MAE. */
  @Column({ type: 'real', default: 0 })
  lowestPrice: number;

  // ─── Metadata ─────────────────────────────────────────────────────────────

  @Column({ type: 'text', nullable: true })
  closeReason: string;

  @Column({ type: 'text', nullable: true })
  signalData: string;

  /**
   * Identitas sinyal yang memicu trade ini: `pair:strategi:waktuCandle`.
   *
   * Kunci idempotensi (bagian 23 spesifikasi). Indeks uniknya membuat order
   * ganda dari satu sinyal mustahil tersimpan, bahkan bila pemeriksaan di
   * lapisan aplikasi terlewat karena retry, timeout, atau restart.
   */
  @Index({ unique: true, where: 'signalRef IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  signalRef: string;

  /** Skor Market Intelligence saat entry - untuk evaluasi performa per skor. */
  @Column({ type: 'integer', nullable: true })
  intelligenceScore: number;

  /** Regime pasar saat entry - untuk evaluasi performa per regime. */
  @Column({ type: 'text', nullable: true })
  marketRegime: string;

  /** Tautan ke baris signal_analysis yang mendasari trade ini. */
  @Column({ type: 'integer', nullable: true })
  signalAnalysisId: number;

  @Column({ type: 'text', nullable: true })
  lastError: string;

  /** Jumlah percobaan tutup yang gagal — mencegah retry tanpa batas. */
  @Column({ type: 'integer', default: 0 })
  closeAttempts: number;

  @Column({ nullable: true })
  openedAt: Date;

  @Column({ nullable: true })
  closedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
