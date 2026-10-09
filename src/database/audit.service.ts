import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AuditCategory, AuditLog } from './entities/audit-log.entity';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  /** Mencatat audit tidak boleh menjatuhkan alur trading — error ditelan sengaja. */
  async log(entry: {
    category: AuditCategory;
    event: string;
    pair?: string;
    tradeId?: number;
    message?: string;
    data?: any;
    durationMs?: number;
    isError?: boolean;
  }): Promise<void> {
    try {
      await this.repo.save({
        category: entry.category,
        event: entry.event,
        pair: entry.pair ?? null,
        tradeId: entry.tradeId ?? null,
        message: entry.message ?? null,
        data: entry.data === undefined ? null : safeStringify(entry.data),
        durationMs: entry.durationMs ?? 0,
        isError: entry.isError ? 1 : 0,
      });
    } catch (err) {
      this.logger.warn(`Gagal menulis audit log: ${err.message}`);
    }
  }

  async recent(limit = 100, category?: AuditCategory): Promise<AuditLog[]> {
    return this.repo.find({
      where: category ? { category } : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async errors(limit = 50): Promise<AuditLog[]> {
    return this.repo.find({ where: { isError: 1 }, order: { createdAt: 'DESC' }, take: limit });
  }

  /** Buang log lama agar SQLite tidak membengkak tanpa batas. */
  async prune(olderThanDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
    const res = await this.repo.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }
}

function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return String(value);
  }
}
