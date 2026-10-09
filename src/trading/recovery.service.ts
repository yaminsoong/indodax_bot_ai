import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { BotConfigService } from '../config/bot-config.service';
import { NotificationService } from '../notification/notification.service';
import { AuditService } from '../database/audit.service';
import { RiskService } from './risk.service';
import { ExecutionService } from './execution.service';
import { PortfolioService } from './portfolio.service';
import { KeyedMutex } from '../common/mutex';
import { fmtPrice, idr } from '../common/num';

export type RecoveryOutcome =
  /** Posisi ternyata sudah tidak ada di exchange; catatan diselaraskan. */
  | 'RECONCILED_CLOSED'
  /** Koin masih dipegang dan berhasil dijual pada percobaan pemulihan. */
  | 'RECOVERED_SOLD'
  /** Butuh tindakan manual operator. */
  | 'MANUAL_ACTION_REQUIRED'
  /** Belum bisa diputuskan (data exchange tidak terbaca). */
  | 'UNRESOLVED';

export interface RecoveryResult {
  tradeId: number;
  pair: string;
  outcome: RecoveryOutcome;
  detail: string;
}

export interface RecoveryReport {
  ranAt: string;
  mode: string;
  failedTrades: number;
  stuckClosing: number;
  results: RecoveryResult[];
  /** True bila masih ada posisi yang butuh tangan manusia. */
  needsAttention: boolean;
}

/** Berapa lama posisi boleh berstatus CLOSING sebelum dianggap menggantung. */
const STUCK_CLOSING_MINUTES = 15;

/**
 * Pemulihan kegagalan (bagian 22 spesifikasi).
 *
 * Alur yang ditegakkan di sini:
 *
 *     FAILED -> DETECT -> ALERT -> RECONCILE -> RECOVER / MANUAL ACTION
 *
 * Sebelum ini, posisi berstatus FAILED adalah jalan buntu: bot berhenti
 * mencoba, mengirim satu pemberitahuan, lalu melupakannya. Yang tersisa adalah
 * baris database yang tidak lagi mewakili apa pun, sementara koinnya mungkin
 * masih benar-benar ada di exchange - tanpa stop loss.
 *
 * Yang dikerjakan lapisan ini:
 *  1. DETECT   - cari posisi FAILED dan yang menggantung di status CLOSING.
 *  2. RECONCILE- tanyakan ke exchange: koinnya masih ada atau tidak?
 *  3. RECOVER  - bila masih ada, coba jual sekali lagi (bila diizinkan).
 *  4. MANUAL   - bila tetap gagal, nyatakan dengan jelas apa yang harus
 *                dilakukan operator, dan JANGAN berhenti mengingatkan.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly tradeMutex = new KeyedMutex();
  private lastReport: RecoveryReport | null = null;

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly execution: ExecutionService,
    private readonly portfolio: PortfolioService,
    private readonly risk: RiskService,
    private readonly notification: NotificationService,
    private readonly audit: AuditService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  getLastReport(): RecoveryReport | null {
    return this.lastReport;
  }

  /** Apakah masih ada posisi yang statusnya belum jelas. */
  async hasUnresolvedPositions(): Promise<boolean> {
    const count = await this.tradeRepo.count({ where: { status: 'FAILED' } });
    return count > 0;
  }

  // --- Alur utama ----------------------------------------------------------

  async recover(): Promise<RecoveryReport> {
    const failed = await this.tradeRepo.find({ where: { status: 'FAILED' } });
    const stuck = await this.findStuckClosing();

    const report: RecoveryReport = {
      ranAt: new Date().toISOString(),
      mode: this.config.mode,
      failedTrades: failed.length,
      stuckClosing: stuck.length,
      results: [],
      needsAttention: false,
    };

    for (const trade of [...failed, ...stuck]) {
      try {
        const result = await this.recoverOne(trade);
        report.results.push(result);
        if (result.outcome === 'MANUAL_ACTION_REQUIRED' || result.outcome === 'UNRESOLVED') {
          report.needsAttention = true;
        }
      } catch (err) {
        this.logger.error(`Pemulihan #${trade.id} gagal: ${err.message}`);
        report.results.push({
          tradeId: trade.id,
          pair: trade.pair,
          outcome: 'UNRESOLVED',
          detail: `Pemulihan melempar galat: ${err.message}`,
        });
        report.needsAttention = true;
      }
    }

    this.lastReport = report;

    if (report.results.length) {
      await this.audit.log({
        category: 'RECONCILE',
        event: 'RECOVERY_RUN',
        message: `${report.results.length} posisi diperiksa, ${report.needsAttention ? 'ada' : 'tidak ada'} yang butuh tindakan manual`,
        data: report.results,
        isError: report.needsAttention,
      });
      await this.publish(report);
    }

    return report;
  }

  /** Posisi yang terlalu lama tertahan di status CLOSING. */
  private async findStuckClosing(): Promise<Trade[]> {
    const candidates = await this.tradeRepo.find({ where: { status: In(['CLOSING']) } });
    const cutoff = Date.now() - STUCK_CLOSING_MINUTES * 60_000;
    return candidates.filter((t) => new Date(t.updatedAt ?? t.createdAt).getTime() < cutoff);
  }

  // --- Pemulihan satu posisi ----------------------------------------------

  private async recoverOne(trade: Trade): Promise<RecoveryResult> {
    return this.tradeMutex.runExclusive(String(trade.id), async () => {
      const fresh = await this.tradeRepo.findOne({ where: { id: trade.id } });
      if (!fresh) {
        return { tradeId: trade.id, pair: trade.pair, outcome: 'RECONCILED_CLOSED' as const, detail: 'Trade sudah tidak ada' };
      }
      if (!['FAILED', 'CLOSING'].includes(fresh.status)) {
        return {
          tradeId: fresh.id,
          pair: fresh.pair,
          outcome: 'RECONCILED_CLOSED' as const,
          detail: `Status sudah berubah menjadi ${fresh.status}`,
        };
      }

      // Mode simulasi tidak punya saldo exchange untuk dibandingkan. Menutup
      // paksa di sini akan mengarang harga keluar yang tidak pernah terjadi,
      // jadi posisi dibiarkan menunggu keputusan operator.
      if (!this.config.isLive) {
        return {
          tradeId: fresh.id,
          pair: fresh.pair,
          outcome: 'MANUAL_ACTION_REQUIRED' as const,
          detail:
            'Mode simulasi: tidak ada saldo exchange untuk diperiksa. ' +
            'Tutup manual lewat dashboard bila posisi ini memang harus diakhiri.',
        };
      }

      if (!this.indodax.hasCredentials()) {
        return {
          tradeId: fresh.id,
          pair: fresh.pair,
          outcome: 'UNRESOLVED' as const,
          detail: 'Kredensial Indodax tidak tersedia - status tidak bisa diperiksa',
        };
      }

      // --- RECONCILE: apakah koinnya masih ada? ---------------------------
      const info = this.pairs.require(fresh.pair);
      const balance = await this.indodax.getBalance();
      const held = balance[info.tradedCurrency] ?? 0;
      const expected = fresh.remainingQuantity || fresh.quantity;

      // Toleransi 1%: fee dan pembulatan membuat saldo tidak pernah persis sama.
      if (held < expected * 0.01) {
        return this.markReconciledClosed(fresh, held);
      }

      // --- RECOVER: koin masih ada, coba jual sekali lagi ------------------
      if (!this.autoRetryEnabled()) {
        return {
          tradeId: fresh.id,
          pair: fresh.pair,
          outcome: 'MANUAL_ACTION_REQUIRED' as const,
          detail:
            `Koin masih ada di exchange (${held}). Percobaan otomatis dimatikan ` +
            `(RECOVERY_AUTO_RETRY=false) - jual manual di Indodax lalu tutup trade ini.`,
        };
      }

      return this.retrySell(fresh, Math.min(held, expected));
    });
  }

  /**
   * Koin sudah tidak ada: order penutup ternyata BERHASIL terisi, hanya saja
   * bot kehilangan konfirmasinya (timeout, restart, atau jaringan terputus).
   *
   * Harga keluar diambil dari riwayat trade exchange bila tersedia; bila tidak,
   * posisi ditutup dengan penanda bahwa P&L-nya tidak dapat dipastikan. Menebak
   * harga keluar akan mencemari seluruh statistik performa dengan angka karangan.
   */
  private async markReconciledClosed(trade: Trade, heldCoin: number): Promise<RecoveryResult> {
    let exitPrice = 0;
    let source = 'tidak diketahui';

    try {
      const history = await this.indodax.getTradeHistory(trade.pair);
      const sells = (history || [])
        .filter((h: any) => String(h.type).toLowerCase() === 'sell')
        .sort((a: any, b: any) => Number(b.trade_time ?? 0) - Number(a.trade_time ?? 0));
      if (sells.length) {
        exitPrice = parseFloat(sells[0].price ?? '0');
        source = 'riwayat trade exchange';
      }
    } catch (err) {
      this.logger.warn(`Riwayat trade ${trade.pair} tidak terbaca: ${err.message}`);
    }

    const pnl = exitPrice > 0 ? this.risk.calculatePnL(trade, exitPrice) : null;

    await this.tradeRepo.update(trade.id, {
      status: 'CLOSED',
      exitPrice: exitPrice > 0 ? exitPrice : null,
      profitLoss: pnl ? pnl.profitLoss + (trade.realizedPnl || 0) : null,
      profitLossPercent: pnl ? pnl.profitLossPercent : null,
      rMultiple: pnl ? pnl.rMultiple : null,
      remainingQuantity: 0,
      closeReason: 'RECOVERED_RECONCILED',
      closedAt: new Date(),
      lastError:
        exitPrice > 0
          ? null
          : 'Ditutup lewat rekonsiliasi; harga keluar tidak dapat dipastikan sehingga P&L tidak dihitung',
    });

    const detail =
      `Koin sudah tidak ada di exchange (saldo ${heldCoin}). Order penutup ternyata terisi. ` +
      (exitPrice > 0
        ? `Harga keluar ${fmtPrice(exitPrice)} diambil dari ${source}, P&L ${idr(pnl!.profitLoss)}.`
        : `Harga keluar tidak dapat dipastikan - P&L sengaja dikosongkan agar statistik tidak tercemar angka karangan.`);

    this.logger.log(`♻️ Pemulihan #${trade.id} ${trade.pair.toUpperCase()}: ${detail}`);
    await this.audit.log({
      category: 'RECONCILE',
      event: 'RECOVERY_RECONCILED_CLOSED',
      pair: trade.pair,
      tradeId: trade.id,
      message: detail,
    });

    return { tradeId: trade.id, pair: trade.pair, outcome: 'RECONCILED_CLOSED', detail };
  }

  /** Percobaan jual terakhir untuk posisi yang koinnya memang masih dipegang. */
  private async retrySell(trade: Trade, quantity: number): Promise<RecoveryResult> {
    const ticker = await this.indodax.getTicker(trade.pair);

    const outcome = await this.execution.execute({
      pair: trade.pair,
      side: 'sell',
      amount: quantity,
      referencePrice: ticker.last,
      // Pemulihan selalu mendesak: posisi ini sudah kehilangan perlindungan
      // stop loss-nya sejak percobaan tutup yang pertama gagal.
      urgent: true,
      style: 'TAKER',
    });

    if (!outcome.success || outcome.filledCoin <= 0) {
      const detail =
        `Percobaan jual ulang gagal: ${outcome.error ?? 'order tidak terisi'}. ` +
        `Koin ${quantity} masih dipegang TANPA stop loss - tangani manual di Indodax.`;

      await this.tradeRepo.update(trade.id, { status: 'FAILED', lastError: detail });

      await this.audit.log({
        category: 'ORDER',
        event: 'RECOVERY_SELL_FAILED',
        pair: trade.pair,
        tradeId: trade.id,
        message: detail,
        isError: true,
      });

      return { tradeId: trade.id, pair: trade.pair, outcome: 'MANUAL_ACTION_REQUIRED', detail };
    }

    const pnl = this.risk.calculatePnL(trade, outcome.avgPrice, outcome.filledCoin);
    const totalPnl = pnl.profitLoss + (trade.realizedPnl || 0);
    const totalRisk = trade.initialRiskPerUnit * trade.quantity;

    await this.tradeRepo.update(trade.id, {
      status: 'CLOSED',
      exitPrice: outcome.avgPrice,
      exitOrderId: outcome.orderId,
      exitFee: (trade.exitFee || 0) + outcome.feeIdr,
      profitLoss: totalPnl,
      profitLossPercent: trade.totalValue > 0 ? (totalPnl / trade.totalValue) * 100 : 0,
      rMultiple: totalRisk > 0 ? totalPnl / totalRisk : 0,
      remainingQuantity: 0,
      closeReason: 'RECOVERED_SOLD',
      closedAt: new Date(),
      lastError: null,
    });

    this.portfolio.adjustSimulatedCash(outcome.filledIdr - outcome.feeIdr);

    const detail =
      `Posisi berhasil dijual pada percobaan pemulihan: ${outcome.filledCoin} @ ` +
      `${fmtPrice(outcome.avgPrice)}, P&L ${idr(totalPnl)}.`;

    this.logger.log(`♻️ Pemulihan #${trade.id} ${trade.pair.toUpperCase()}: ${detail}`);
    await this.audit.log({
      category: 'ORDER',
      event: 'RECOVERY_SOLD',
      pair: trade.pair,
      tradeId: trade.id,
      message: detail,
      data: { price: outcome.avgPrice, quantity: outcome.filledCoin, profitLoss: totalPnl },
    });

    return { tradeId: trade.id, pair: trade.pair, outcome: 'RECOVERED_SOLD', detail };
  }

  // --- Utilitas ------------------------------------------------------------

  private autoRetryEnabled(): boolean {
    return this.config.bool('RECOVERY_AUTO_RETRY', true);
  }

  /** Kirim ringkasan ke operator; yang butuh tangan manusia ditegaskan. */
  private async publish(report: RecoveryReport): Promise<void> {
    const manual = report.results.filter(
      (r) => r.outcome === 'MANUAL_ACTION_REQUIRED' || r.outcome === 'UNRESOLVED',
    );

    if (!manual.length) {
      const recovered = report.results.filter((r) => r.outcome !== 'UNRESOLVED');
      if (recovered.length) {
        await this.notification.sendInfo(
          `♻️ Pemulihan selesai: ${recovered.length} posisi diselaraskan kembali, ` +
            `tidak ada yang butuh tindakan manual.`,
        );
      }
      return;
    }

    await this.notification.sendAlert(
      `🚨 ${manual.length} POSISI BUTUH TINDAKAN MANUAL\n\n` +
        manual
          .map((r) => `• #${r.tradeId} ${r.pair.toUpperCase()}\n  ${r.detail}`)
          .join('\n\n') +
        `\n\nSelama posisi ini belum jelas, bot TIDAK akan membuka posisi baru.`,
    );
  }
}
