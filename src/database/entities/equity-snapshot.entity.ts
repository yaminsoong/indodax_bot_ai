import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Rekaman berkala nilai portofolio.
 *
 * Tanpa deret ini, drawdown tidak bisa dihitung — dan drawdown maksimum adalah
 * angka yang paling menentukan apakah sebuah sistem trading layak dijalankan.
 */
@Entity('equity_snapshots')
@Index(['createdAt'])
export class EquitySnapshot {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  mode: string;

  /** Kas IDR yang tersedia. */
  @Column({ type: 'real' })
  cashIdr: number;

  /** Nilai pasar seluruh posisi terbuka. */
  @Column({ type: 'real' })
  positionsValueIdr: number;

  /** cashIdr + positionsValueIdr. */
  @Column({ type: 'real' })
  equityIdr: number;

  /** Ekuitas tertinggi sepanjang riwayat — pembanding untuk drawdown. */
  @Column({ type: 'real', default: 0 })
  peakEquityIdr: number;

  @Column({ type: 'real', default: 0 })
  drawdownPercent: number;

  @Column({ type: 'integer', default: 0 })
  openPositions: number;

  @Column({ type: 'real', default: 0 })
  unrealizedPnl: number;

  @CreateDateColumn()
  createdAt: Date;
}
