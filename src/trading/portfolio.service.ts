import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { EquitySnapshot } from '../database/entities/equity-snapshot.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { BotConfigService } from '../config/bot-config.service';

export interface PortfolioState {
  mode: string;
  cashIdr: number;
  positionsValueIdr: number;
  equityIdr: number;
  peakEquityIdr: number;
  drawdownPercent: number;
  openPositions: number;
  unrealizedPnl: number;
  /** Rincian per posisi terbuka pada harga pasar terkini. */
  positions: Array<{
    tradeId: number;
    pair: string;
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    valueIdr: number;
    unrealizedPnl: number;
    unrealizedPercent: number;
    rMultiple: number;
    /**
     * True bila harga pasar pair ini TIDAK terbaca dan angka di atas memakai
     * harga entry sebagai pengganti.
     *
     * Tanpa penanda ini, posisi yang harganya gagal dibaca menampilkan P&L
     * tepat 0,00 — tidak bisa dibedakan dari posisi yang memang datar.
     * Operator akan membacanya sebagai "aman", padahal yang sebenarnya
     * terjadi adalah "tidak diketahui".
     */
    priceStale: boolean;
  }>;
  /** True bila saldo tidak dapat dibaca dari exchange. */
  degraded: boolean;
  /**
   * Apa saja yang gagal dibaca, satu baris per kegagalan.
   *
   * `degraded` hanya menjawab "ada yang salah"; ini menjawab "yang mana" —
   * dan tindakannya berbeda antara saldo yang tidak terbaca dan harga satu
   * pair yang tidak terbaca.
   */
  degradedReasons: string[];
  /** Kapan potret ini diambil. */
  asOf: string;
}

/**
 * Sumber tunggal untuk nilai portofolio.
 *
 * Versi lama menaksir portofolio sebagai `saldoIDR + jumlahTradeTerbuka * 10`
 * — dengan `jumlahTradeTerbuka` berupa cacah, dikalikan sepuluh rupiah. Akibatnya
 * batas kerugian harian dan position sizing dihitung dari angka yang tidak
 * berarti. Di sini nilai posisi dihitung dari harga pasar sesungguhnya.
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  /** Kas simulasi diikuti secara internal agar tidak menyentuh saldo asli. */
  private simulatedCash: number | null = null;
  private priceCache = new Map<string, { at: number; price: number }>();

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(EquitySnapshot)
    private readonly equityRepo: Repository<EquitySnapshot>,
  ) {}

  // ─── Harga ────────────────────────────────────────────────────────────────

  /** Harga terkini dengan cache 10 detik agar satu siklus tidak membanjiri API. */
  async getPrice(pair: string): Promise<number> {
    const cached = this.priceCache.get(pair);
    if (cached && Date.now() - cached.at < 10_000) return cached.price;

    const ticker = await this.indodax.getTicker(pair);
    this.priceCache.set(pair, { at: Date.now(), price: ticker.last });
    return ticker.last;
  }

  // ─── Kas ──────────────────────────────────────────────────────────────────

  /**
   * Kas IDR yang tersedia.
   *
   * Di mode LIVE ini WAJIB berasal dari exchange; bila gagal, error dilempar
   * agar pemanggil membatalkan entry. Versi lama diam-diam memakai angka
   * 1.000.000 sebagai fallback dan tetap mengirim order dengan uang sungguhan.
   */
  async getCashIdr(): Promise<number> {
    if (this.config.isLive) {
      /**
       * Dana yang DITAHAN order terbuka ikut dihitung sebagai kas.
       *
       * Indodax memindahkan IDR dari `balance` ke `balance_hold` begitu order
       * limit dipasang. Uang itu belum dibelanjakan — ia masih milik akun dan
       * akan kembali bila ordernya dibatalkan. Mengabaikannya membuat ekuitas
       * jatuh seketika setiap kali order dipasang.
       *
       * Akibatnya terukur pada 2026-10-12, mode LIVE:
       *   saldo         Rp16.998
       *   order + fee   Rp11.071  (ditahan)
       *   kas terbaca   Rp5.927
       *   drawdown      1 - 5.927/16.998 = 65,13%
       *   log bot       "Drawdown 65.14% >= batas 15%"
       *
       * Kill switch lalu menghentikan seluruh entry — padahal bot belum
       * membukukan satu trade pun dan tidak kehilangan uang sama sekali.
       * Memasang order seharusnya tidak pernah terlihat seperti kerugian.
       */
      const { available, hold } = await this.indodax.getBalanceWithHold();
      return (available.idr ?? 0) + (hold.idr ?? 0);
    }

    if (this.simulatedCash === null) {
      this.simulatedCash = await this.deriveSimulatedCash();
    }
    return this.simulatedCash;
  }

  /** Rekonstruksi kas simulasi dari modal awal dikurangi hasil trade tercatat. */
  private async deriveSimulatedCash(): Promise<number> {
    const trades = await this.tradeRepo.find({
      where: { mode: 'SIMULATION', status: In(['OPEN', 'PENDING', 'CLOSING', 'CLOSED']) },
    });

    let cash = this.config.simulationCapitalIdr;
    for (const t of trades) {
      cash -= t.totalValue || 0;
      if (t.status === 'CLOSED') {
        cash += (t.totalValue || 0) + (t.profitLoss || 0);
      } else {
        cash += t.realizedPnl || 0;
      }
    }
    return Math.max(0, cash);
  }

  /** Sesuaikan kas simulasi setelah entry/exit. Tidak berlaku di mode LIVE. */
  adjustSimulatedCash(delta: number): void {
    if (this.config.isLive) return;
    if (this.simulatedCash === null) return;
    this.simulatedCash = Math.max(0, this.simulatedCash + delta);
  }

  resetSimulatedCash(): void {
    this.simulatedCash = null;
  }

  // ─── Ekuitas ──────────────────────────────────────────────────────────────

  async getState(): Promise<PortfolioState> {
    const openTrades = await this.tradeRepo.find({ where: { status: In(['OPEN', 'CLOSING']) } });

    let cashIdr = 0;
    let degraded = false;
    const degradedReasons: string[] = [];
    try {
      cashIdr = await this.getCashIdr();
    } catch (err) {
      this.logger.error(`Gagal membaca saldo: ${err.message}`);
      degraded = true;
      degradedReasons.push(`Saldo kas TIDAK terbaca: ${err.message}`);
    }

    const positions: PortfolioState['positions'] = [];
    let positionsValueIdr = 0;
    let unrealizedPnl = 0;

    for (const t of openTrades) {
      let currentPrice = t.entryPrice;
      let priceStale = false;
      try {
        currentPrice = await this.getPrice(t.pair);
      } catch (err) {
        this.logger.warn(`Harga ${t.pair} tidak terbaca, memakai harga entry: ${err.message}`);
        degraded = true;
        priceStale = true;
        degradedReasons.push(
          `Harga ${t.pair.toUpperCase()} TIDAK terbaca — P&L posisi #${t.id} memakai harga entry, ` +
            'jadi angkanya 0 karena TIDAK DIKETAHUI, bukan karena datar',
        );
      }

      const qty = t.remainingQuantity || t.quantity;
      const valueIdr = qty * currentPrice;
      const pnl = (currentPrice - t.entryPrice) * qty + (t.realizedPnl || 0);

      positionsValueIdr += valueIdr;
      unrealizedPnl += pnl;

      positions.push({
        tradeId: t.id,
        pair: t.pair,
        quantity: qty,
        entryPrice: t.entryPrice,
        currentPrice,
        valueIdr,
        unrealizedPnl: pnl,
        unrealizedPercent: t.entryPrice > 0 ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100 : 0,
        rMultiple:
          t.initialRiskPerUnit > 0 ? (currentPrice - t.entryPrice) / t.initialRiskPerUnit : 0,
        priceStale,
      });
    }

    const equityIdr = cashIdr + positionsValueIdr;
    const peakEquityIdr = Math.max(await this.getPeakEquity(), equityIdr);
    const drawdownPercent =
      peakEquityIdr > 0 ? ((peakEquityIdr - equityIdr) / peakEquityIdr) * 100 : 0;

    return {
      mode: this.config.mode,
      cashIdr,
      positionsValueIdr,
      equityIdr,
      peakEquityIdr,
      drawdownPercent,
      openPositions: openTrades.length,
      unrealizedPnl,
      positions,
      degraded,
      degradedReasons,
      asOf: new Date().toISOString(),
    };
  }

  private async getPeakEquity(): Promise<number> {
    const row = await this.equityRepo
      .createQueryBuilder('e')
      .select('MAX(e.equityIdr)', 'peak')
      .where('e.mode = :mode', { mode: this.config.mode })
      .getRawOne();
    return Number(row?.peak) || 0;
  }

  /** Simpan snapshot ekuitas — menyusun equity curve dan riwayat drawdown. */
  async snapshot(): Promise<EquitySnapshot | null> {
    try {
      const state = await this.getState();
      if (state.degraded) {
        this.logger.warn('Snapshot ekuitas dilewati: data portofolio tidak lengkap');
        return null;
      }
      return this.equityRepo.save({
        mode: state.mode,
        cashIdr: state.cashIdr,
        positionsValueIdr: state.positionsValueIdr,
        equityIdr: state.equityIdr,
        peakEquityIdr: state.peakEquityIdr,
        drawdownPercent: state.drawdownPercent,
        openPositions: state.openPositions,
        unrealizedPnl: state.unrealizedPnl,
      });
    } catch (err) {
      this.logger.error(`Snapshot ekuitas gagal: ${err.message}`);
      return null;
    }
  }

  async getEquityCurve(days = 30): Promise<EquitySnapshot[]> {
    const since = new Date(Date.now() - days * 86400_000);
    return this.equityRepo.find({
      where: { mode: this.config.mode, createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'ASC' },
    });
  }

  /** Drawdown maksimum historis dari equity curve. */
  async getMaxDrawdown(days = 90): Promise<{ maxDrawdownPercent: number; currentDrawdownPercent: number }> {
    const curve = await this.getEquityCurve(days);
    if (!curve.length) return { maxDrawdownPercent: 0, currentDrawdownPercent: 0 };

    let peak = curve[0].equityIdr;
    let maxDd = 0;
    for (const point of curve) {
      peak = Math.max(peak, point.equityIdr);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - point.equityIdr) / peak) * 100);
    }

    const lastEquity = curve[curve.length - 1].equityIdr;
    return {
      maxDrawdownPercent: maxDd,
      currentDrawdownPercent: peak > 0 ? ((peak - lastEquity) / peak) * 100 : 0,
    };
  }
}
