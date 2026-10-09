import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Hasil satu run backtest, disimpan agar bisa dibandingkan antar parameter. */
@Entity('backtest_results')
export class BacktestResult {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  strategy: string;

  @Column({ type: 'text' })
  pairs: string;

  @Column({ type: 'integer' })
  timeframe: number;

  @Column({ type: 'text' })
  periodStart: string;

  @Column({ type: 'text' })
  periodEnd: string;

  @Column({ type: 'real' })
  initialCapital: number;

  @Column({ type: 'real' })
  finalEquity: number;

  @Column({ type: 'real' })
  totalReturnPercent: number;

  @Column({ type: 'integer' })
  totalTrades: number;

  @Column({ type: 'real' })
  winRate: number;

  @Column({ type: 'real' })
  profitFactor: number;

  @Column({ type: 'real' })
  maxDrawdownPercent: number;

  @Column({ type: 'real' })
  sharpeRatio: number;

  @Column({ type: 'real' })
  expectancyR: number;

  @Column({ type: 'real', default: 0 })
  totalFees: number;

  /** Parameter yang dipakai pada run ini (JSON). */
  @Column({ type: 'text' })
  params: string;

  /** Ringkasan metrik lengkap + equity curve (JSON). */
  @Column({ type: 'text' })
  report: string;

  @CreateDateColumn()
  createdAt: Date;
}
