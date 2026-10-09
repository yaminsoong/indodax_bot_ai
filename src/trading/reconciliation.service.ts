import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { BotConfigService } from '../config/bot-config.service';
import { NotificationService } from '../notification/notification.service';
import { AuditService } from '../database/audit.service';

export interface ReconciliationReport {
  ranAt: string;
  mode: string;
  checked: number;
  discrepancies: Array<{
    type: string;
    tradeId?: number;
    pair: string;
    detail: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
  }>;
  orphanOrders: number;
  autoFixed: number;
}

/** Toleransi selisih saldo koin sebelum dianggap menyimpang (0,5%). */
const QUANTITY_TOLERANCE = 0.005;

/**
 * Menyelaraskan catatan bot dengan keadaan sesungguhnya di exchange.
 *
 * Bot bisa saja crash tepat setelah order terkirim, atau order terisi setelah
 * bot menyerah menunggu. Tanpa pemeriksaan berkala, database perlahan menyimpang
 * dari kenyataan — bot akan mencoba menjual koin yang tidak dimilikinya, atau
 * membiarkan posisi nyata tanpa stop loss.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private lastReport: ReconciliationReport | null = null;

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly notification: NotificationService,
    private readonly audit: AuditService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  getLastReport(): ReconciliationReport | null {
    return this.lastReport;
  }

  async reconcile(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      ranAt: new Date().toISOString(),
      mode: this.config.mode,
      checked: 0,
      discrepancies: [],
      orphanOrders: 0,
      autoFixed: 0,
    };

    // Rekonsiliasi hanya bermakna terhadap saldo exchange sungguhan.
    if (!this.config.isLive) {
      report.discrepancies.push({
        type: 'SKIPPED',
        pair: '-',
        detail: 'Mode simulasi — tidak ada saldo exchange untuk dibandingkan',
        severity: 'INFO',
      });
      this.lastReport = report;
      return report;
    }

    if (!this.indodax.hasCredentials()) {
      report.discrepancies.push({
        type: 'NO_CREDENTIALS',
        pair: '-',
        detail: 'API key belum dikonfigurasi',
        severity: 'WARNING',
      });
      this.lastReport = report;
      return report;
    }

    let balance: Awaited<ReturnType<IndodaxService['getBalanceWithHold']>>;
    try {
      balance = await this.indodax.getBalanceWithHold();
    } catch (err) {
      this.logger.error(`Rekonsiliasi gagal membaca saldo: ${err.message}`);
      report.discrepancies.push({
        type: 'BALANCE_UNREADABLE',
        pair: '-',
        detail: err.message,
        severity: 'CRITICAL',
      });
      this.lastReport = report;
      return report;
    }

    const openTrades = await this.tradeRepo.find({
      where: { status: In(['OPEN', 'PENDING', 'CLOSING']) },
    });
    report.checked = openTrades.length;

    // ── 1. Posisi tercatat vs saldo koin sesungguhnya ────────────────────
    const expectedByCoin = new Map<string, { qty: number; trades: number[] }>();
    for (const t of openTrades) {
      const info = this.pairs.get(t.pair);
      if (!info) continue;
      const entry = expectedByCoin.get(info.tradedCurrency) ?? { qty: 0, trades: [] };
      entry.qty += t.remainingQuantity || t.quantity;
      entry.trades.push(t.id);
      expectedByCoin.set(info.tradedCurrency, entry);
    }

    for (const [coin, expected] of expectedByCoin) {
      const actual = (balance.available[coin] || 0) + (balance.hold[coin] || 0);
      const diff = actual - expected.qty;
      const relDiff = expected.qty > 0 ? Math.abs(diff) / expected.qty : 0;

      if (relDiff > QUANTITY_TOLERANCE) {
        const severity = actual < expected.qty * (1 - QUANTITY_TOLERANCE) ? 'CRITICAL' : 'WARNING';
        report.discrepancies.push({
          type: actual < expected.qty ? 'MISSING_COIN' : 'EXTRA_COIN',
          pair: coin,
          detail:
            `Bot mencatat ${expected.qty.toFixed(8)} ${coin.toUpperCase()} ` +
            `(trade #${expected.trades.join(', #')}), saldo exchange ${actual.toFixed(8)} ` +
            `(selisih ${diff >= 0 ? '+' : ''}${diff.toFixed(8)})`,
          severity,
        });
      }
    }

    // ── 2. Trade PENDING yang ternyata sudah terisi ──────────────────────
    for (const trade of openTrades.filter((t) => t.status === 'PENDING' && t.entryOrderId)) {
      try {
        const fill = await this.indodax.getOrderFill(trade.pair, trade.entryOrderId, 'buy');
        if (fill.filledCoin > 0 && fill.status === 'filled') {
          const feeRate = this.pairs.takerFeeRate(trade.pair);
          await this.tradeRepo.update(trade.id, {
            status: 'OPEN',
            entryPrice: fill.avgPrice,
            quantity: fill.filledCoin * (1 - feeRate),
            remainingQuantity: fill.filledCoin * (1 - feeRate),
            totalValue: fill.filledIdr + fill.feeIdr,
            entryFee: fill.feeIdr,
            openedAt: trade.openedAt ?? new Date(),
          });
          report.autoFixed++;
          report.discrepancies.push({
            type: 'PENDING_RESOLVED',
            tradeId: trade.id,
            pair: trade.pair,
            detail: `Order ${trade.entryOrderId} ternyata sudah terisi @ ${fill.avgPrice} — status diperbarui ke OPEN`,
            severity: 'INFO',
          });
        } else if (fill.status === 'cancelled' && fill.filledCoin === 0) {
          await this.tradeRepo.update(trade.id, {
            status: 'CANCELLED',
            lastError: 'Order dibatalkan tanpa fill (ditemukan saat rekonsiliasi)',
          });
          report.autoFixed++;
          report.discrepancies.push({
            type: 'PENDING_CANCELLED',
            tradeId: trade.id,
            pair: trade.pair,
            detail: `Order ${trade.entryOrderId} dibatalkan tanpa terisi — trade ditutup sebagai CANCELLED`,
            severity: 'INFO',
          });
        }
      } catch (err) {
        this.logger.warn(`Cek order pending #${trade.id} gagal: ${err.message}`);
      }
    }

    // ── 3. Open order yatim (tidak dikenali database) ────────────────────
    try {
      const knownOrderIds = new Set(
        openTrades.flatMap((t) => [t.entryOrderId, t.exitOrderId].filter(Boolean)),
      );
      const exchangeOrders = await this.indodax.getOpenOrders();

      for (const order of exchangeOrders) {
        const orderId = String(order.order_id);
        if (knownOrderIds.has(orderId)) continue;

        report.orphanOrders++;
        report.discrepancies.push({
          type: 'ORPHAN_ORDER',
          pair: String(order.pair ?? '?'),
          detail:
            `Order ${orderId} (${order.type}) aktif di Indodax tapi tidak dikenali bot. ` +
            `Kemungkinan sisa dari crash atau order manual — periksa dan batalkan bila perlu.`,
          severity: 'WARNING',
        });
      }
    } catch (err) {
      this.logger.warn(`Gagal membaca open orders: ${err.message}`);
    }

    // ── 4. Posisi tanpa perlindungan stop ────────────────────────────────
    for (const trade of openTrades.filter((t) => t.status === 'OPEN')) {
      if (!(trade.stopLossPrice > 0)) {
        report.discrepancies.push({
          type: 'NO_STOP_LOSS',
          tradeId: trade.id,
          pair: trade.pair,
          detail: 'Posisi terbuka tanpa stop loss valid — modal tidak terlindungi',
          severity: 'CRITICAL',
        });
      }
    }

    this.lastReport = report;
    await this.publish(report);
    return report;
  }

  private async publish(report: ReconciliationReport): Promise<void> {
    const critical = report.discrepancies.filter((d) => d.severity === 'CRITICAL');
    const warnings = report.discrepancies.filter((d) => d.severity === 'WARNING');

    await this.audit.log({
      category: 'RECONCILE',
      event: 'RECONCILIATION_RUN',
      message: `${report.checked} posisi diperiksa, ${report.discrepancies.length} temuan, ${report.autoFixed} diperbaiki otomatis`,
      data: report,
      isError: critical.length > 0,
    });

    if (report.autoFixed > 0) {
      this.logger.log(`Rekonsiliasi memperbaiki ${report.autoFixed} catatan trade`);
    }

    if (critical.length === 0 && warnings.length === 0) {
      this.logger.log(`Rekonsiliasi bersih (${report.checked} posisi diperiksa)`);
      return;
    }

    for (const d of [...critical, ...warnings]) {
      this.logger.warn(`[${d.severity}] ${d.type} ${d.pair}: ${d.detail}`);
    }

    if (critical.length > 0) {
      await this.notification.sendAlert(
        `🚨 REKONSILIASI MENEMUKAN MASALAH SERIUS\n\n` +
          critical.map((d) => `• ${d.type} (${d.pair.toUpperCase()})\n  ${d.detail}`).join('\n\n') +
          `\n\nCatatan bot tidak cocok dengan Indodax. Periksa akun Anda.`,
      );
    } else if (warnings.length > 0) {
      await this.notification.sendAlert(
        `⚠️ Rekonsiliasi menemukan ${warnings.length} hal yang perlu diperiksa:\n\n` +
          warnings.map((d) => `• ${d.type} (${d.pair.toUpperCase()}): ${d.detail}`).join('\n'),
      );
    }
  }
}
