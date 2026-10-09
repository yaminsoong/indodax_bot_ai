import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Jejak setiap keputusan analitis Market Intelligence (bagian 13 spesifikasi).
 *
 * Tujuannya satu: agar setiap trade - dan setiap trade yang TIDAK diambil -
 * bisa dianalisis kembali berbulan-bulan kemudian. Tanpa catatan ini,
 * pertanyaan "apakah setup berskor 80 benar-benar lebih menguntungkan daripada
 * yang berskor 65" tidak bisa dijawab dengan data, hanya dengan dugaan.
 *
 * Mengapa hanya SATU tabel, bukan tujuh seperti daftar saran di bagian 21:
 * struktur, zona, dan regime selalu dibaca bersama satu analisis dan tidak
 * pernah dikueri sendiri. Menyimpannya sebagai JSON pada baris yang sama
 * menghindari lima tabel tambahan beserta join-nya, tanpa kehilangan satu pun
 * informasi. Kolom yang memang dipakai untuk memfilter dan mengagregasi -
 * skor, regime, keputusan, timeframe - tetap menjadi kolom tersendiri.
 */
@Entity('signal_analysis')
@Index(['pair', 'createdAt'])
@Index(['strategy', 'decision'])
@Index(['score'])
export class SignalAnalysis {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  pair: string;

  /** Waktu candle acuan (epoch detik) - BUKAN jam sistem. */
  @Column({ type: 'integer', default: 0 })
  barTime: number;

  @Column({ type: 'text', default: 'UNKNOWN' })
  strategy: string;

  /** Timeframe acuan setup. */
  @Column({ type: 'text', default: '1H' })
  timeframe: string;

  /** LONG | SHORT | NONE */
  @Column({ type: 'text', default: 'NONE' })
  direction: string;

  /** 0-100 quality score. */
  @Column({ type: 'integer', default: 0 })
  score: number;

  /** NO_TRADE | WATCH | TRADE_SETUP | HIGH_QUALITY_SETUP */
  @Column({ type: 'text', default: 'NO_TRADE' })
  decision: string;

  @Column({ type: 'text', default: 'SIDEWAYS' })
  marketRegime: string;

  // --- Rincian skor per dimensi -------------------------------------------

  @Column({ type: 'real', default: 0 })
  trendScore: number;

  @Column({ type: 'real', default: 0 })
  structureScore: number;

  @Column({ type: 'real', default: 0 })
  momentumScore: number;

  @Column({ type: 'real', default: 0 })
  volumeScore: number;

  @Column({ type: 'real', default: 0 })
  supportResistanceScore: number;

  @Column({ type: 'real', default: 0 })
  volatilityScore: number;

  @Column({ type: 'real', default: 0 })
  orderBookScore: number;

  @Column({ type: 'real', default: 0 })
  riskRewardScore: number;

  // --- Setup analitis ------------------------------------------------------

  @Column({ type: 'real', default: 0 })
  entryPrice: number;

  @Column({ type: 'real', default: 0 })
  stopLoss: number;

  @Column({ type: 'real', default: 0 })
  takeProfit1: number;

  @Column({ type: 'real', default: 0 })
  takeProfit2: number;

  @Column({ type: 'real', default: 0 })
  takeProfit3: number;

  @Column({ type: 'real', default: 0 })
  riskReward: number;

  @Column({ type: 'real', default: 0 })
  atrPercent: number;

  // --- Penjelasan ----------------------------------------------------------

  /** Alasan positif, satu per baris. */
  @Column({ type: 'text', nullable: true })
  reasons: string;

  /** Alasan penolakan tegas (No Trade Engine). */
  @Column({ type: 'text', nullable: true })
  blockers: string;

  /** Peringatan yang tidak menolak trade tetapi perlu diketahui. */
  @Column({ type: 'text', nullable: true })
  riskFactors: string;

  /** JSON: bias & regime tiap timeframe, event struktur, zona S/R. */
  @Column({ type: 'text', nullable: true })
  context: string;

  /** Apakah analisis ini benar-benar diikuti oleh order. */
  @Column({ type: 'integer', default: 0 })
  executed: number;

  /** Id trade yang dihasilkan, bila ada - penghubung ke hasil sesungguhnya. */
  @Column({ type: 'integer', nullable: true })
  tradeId: number;

  /** SIMULATION | LIVE | BACKTEST */
  @Column({ type: 'text', default: 'SIMULATION' })
  mode: string;

  /** True bila Market Intelligence sedang hanya mengamati (MI_ENFORCE=false). */
  @Column({ type: 'integer', default: 0 })
  observeOnly: number;

  @CreateDateColumn()
  createdAt: Date;
}
