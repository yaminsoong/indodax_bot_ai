import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AuditCategory = 'ORDER' | 'RISK' | 'CONFIG' | 'SYSTEM' | 'RECONCILE' | 'API_ERROR';

/**
 * Catatan kejadian penting: order dikirim, risiko memblokir entry, kill switch
 * aktif, rekonsiliasi menemukan selisih. Tanpa jejak ini, mendiagnosa apa yang
 * terjadi tiga hari lalu praktis mustahil.
 */
@Entity('audit_logs')
@Index(['category', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  category: AuditCategory;

  @Column({ type: 'text' })
  event: string;

  @Column({ type: 'text', nullable: true })
  pair: string;

  @Column({ type: 'integer', nullable: true })
  tradeId: number;

  @Column({ type: 'text', nullable: true })
  message: string;

  /** Payload JSON: request/response, nilai sebelum-sesudah, dsb. */
  @Column({ type: 'text', nullable: true })
  data: string;

  @Column({ type: 'integer', default: 0 })
  durationMs: number;

  @Column({ type: 'integer', default: 0 })
  isError: number;

  @CreateDateColumn()
  createdAt: Date;
}
