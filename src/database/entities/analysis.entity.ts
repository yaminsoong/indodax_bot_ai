import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('daily_analysis')
export class DailyAnalysis {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  date: string;

  @Column({ type: 'text' })
  topGainers: string;

  @Column({ type: 'text' })
  topLosers: string;

  @Column({ type: 'text' })
  marketSummary: string;

  @Column({ type: 'text' })
  pairAnalysis: string;

  @Column({ type: 'real', default: 0 })
  totalProfit: number;

  @Column({ type: 'integer', default: 0 })
  totalTrades: number;

  @Column({ type: 'integer', default: 0 })
  winTrades: number;

  @Column({ type: 'integer', default: 0 })
  lossTrades: number;

  @Column({ type: 'real', default: 0 })
  winRate: number;

  @CreateDateColumn()
  createdAt: Date;
}
