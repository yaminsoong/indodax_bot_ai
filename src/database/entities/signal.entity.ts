import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

@Entity('signals')
@Index(['pair', 'createdAt'])
export class Signal {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  pair: string;

  @Column({ type: 'text' })
  action: SignalAction;

  @Column({ type: 'text', default: 'UNKNOWN' })
  strategy: string;

  @Column({ type: 'real' })
  price: number;

  @Column({ type: 'real', default: 0 })
  ema5: number;

  @Column({ type: 'real', default: 0 })
  ema13: number;

  @Column({ type: 'real', default: 0 })
  ema21: number;

  @Column({ type: 'real', default: 0 })
  ema50: number;

  @Column({ type: 'real', default: 0 })
  rsi: number;

  @Column({ type: 'real', default: 0 })
  macdHistogram: number;

  @Column({ type: 'real', default: 0 })
  atr: number;

  @Column({ type: 'real', default: 0 })
  atrPercent: number;

  @Column({ type: 'real', default: 0 })
  adx: number;

  @Column({ type: 'real', default: 0 })
  choppiness: number;

  @Column({ type: 'real', default: 0 })
  volume: number;

  @Column({ type: 'real', default: 0 })
  volumeAvg: number;

  @Column({ type: 'text', default: 'NEUTRAL' })
  trend: string;

  @Column({ type: 'text', default: 'RANGING' })
  regime: string;

  @Column({ type: 'text', default: 'UNKNOWN' })
  htfTrend: string;

  @Column({ type: 'real', default: 0 })
  orderBookImbalance: number;

  @Column({ type: 'integer', default: 0 })
  strength: number;

  @Column({ type: 'text', nullable: true })
  reason: string;

  /**
   * Filter mana yang menahan sinyal ini. Tanpa catatan ini, bot yang pasif
   * tidak bisa dibedakan antara "tidak ada peluang" dan "filter kelewat ketat".
   */
  @Column({ type: 'text', nullable: true })
  blockedBy: string;

  @Column({ type: 'integer', default: 0 })
  executed: number;

  @CreateDateColumn()
  createdAt: Date;
}
