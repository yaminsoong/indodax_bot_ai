import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { BotConfigService } from '../config/bot-config.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { IndodaxService } from '../indodax/indodax.service';
import { PortfolioService } from './portfolio.service';
import { AuditService } from '../database/audit.service';
import { clamp } from '../common/num';
import { normalizeTakeProfitLevels } from '../common/take-profit';

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
  /** Nilai IDR yang akan dibelanjakan (sudah termasuk cadangan fee). */
  positionSize: number;
  quantity: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  riskAmountIdr: number;
  initialRiskPerUnit: number;
}

export interface KillSwitchState {
  halted: boolean;
  reasons: string[];
}

/** WIB adalah UTC+7 sepanjang tahun (tidak ada daylight saving). */
const WIB_OFFSET_MS = 7 * 3600_000;

/**
 * Awal hari menurut WIB, dikembalikan sebagai instan absolut.
 *
 * Versi lama memakai `setHours(0,0,0,0)` pada waktu lokal server. Di server UTC
 * jendela "hari ini" untuk batas kerugian meleset 7 jam dari jadwal laporan
 * harian yang memang dipatok ke Asia/Jakarta.
 */
export function startOfTradingDay(now: Date = new Date()): Date {
  const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
  const midnightWib = Date.UTC(
    wibNow.getUTCFullYear(),
    wibNow.getUTCMonth(),
    wibNow.getUTCDate(),
  );
  return new Date(midnightWib - WIB_OFFSET_MS);
}

/**
 * Penjaga risiko.
 *
 * Perubahan mendasar dari versi awal:
 *  - Ukuran posisi dihitung dari risiko (jarak ke stop), bukan persen kas tetap.
 *  - Batas kerugian harian memakai ekuitas sesungguhnya, dan menghitung waktu
 *    dalam WIB agar sejalan dengan jadwal laporan.
 *  - Ada kill switch: drawdown maksimum dan rentetan kerugian menghentikan bot.
 *  - Ada cooldown setelah rugi, dan batas posisi per kelompok aset berkorelasi.
 *  - Fee masuk ke dalam perhitungan sejak awal.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    private readonly config: BotConfigService,
    private readonly pairs: PairRegistryService,
    private readonly indodax: IndodaxService,
    private readonly portfolio: PortfolioService,
    private readonly audit: AuditService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  // ─── Kill switch ──────────────────────────────────────────────────────────

  /**
   * Kondisi yang menghentikan seluruh entry baru.
   * Dicek sebelum evaluasi per-pair supaya satu kegagalan sistemik tidak
   * berlanjut menjadi rentetan kerugian.
   */
  async checkKillSwitch(): Promise<KillSwitchState> {
    const params = this.config.params();
    const reasons: string[] = [];

    if (!params.tradingEnabled) {
      reasons.push('Trading dinonaktifkan secara manual');
    }

    // Kerugian harian (realisasi + belum terealisasi).
    const daily = await this.getDailyStats();
    const state = await this.portfolio.getState();

    if (state.equityIdr > 0) {
      const dailyLossPercent = (Math.min(0, daily.totalPnL) / state.equityIdr) * -100;
      if (dailyLossPercent >= params.maxDailyLossPercent) {
        reasons.push(
          `Batas rugi harian tercapai: ${dailyLossPercent.toFixed(2)}% >= ${params.maxDailyLossPercent}%`,
        );
      }
    }

    // Drawdown dari puncak ekuitas.
    if (state.drawdownPercent >= params.maxDrawdownPercent) {
      reasons.push(
        `Drawdown ${state.drawdownPercent.toFixed(2)}% >= batas ${params.maxDrawdownPercent}%`,
      );
    }

    // Rentetan kerugian beruntun.
    const streak = await this.getConsecutiveLosses();
    if (streak >= params.maxConsecutiveLosses) {
      reasons.push(`${streak} kerugian beruntun >= batas ${params.maxConsecutiveLosses}`);
    }

    /**
     * Posisi yang statusnya belum jelas (bagian 22 spesifikasi).
     *
     * Selama ada trade berstatus FAILED, bot TIDAK boleh membuka posisi baru.
     * Alasannya bukan kehati-hatian berlebihan: posisi FAILED berarti bot tidak
     * tahu apakah koinnya masih dipegang atau tidak. Membuka posisi baru di
     * atas ketidaktahuan itu bisa berarti eksposur dua kali lipat terhadap aset
     * yang sama, atau perintah jual untuk koin yang sudah tidak ada.
     */
    if (this.config.bool('HALT_ON_FAILED_TRADES', true)) {
      const failed = await this.tradeRepo.count({ where: { status: 'FAILED' } });
      if (failed > 0) {
        reasons.push(
          `${failed} posisi berstatus FAILED - status sesungguhnya belum jelas. ` +
            `Jalankan pemulihan (POST /api/control/recover) atau tangani manual di Indodax.`,
        );
      }
    }

    return { halted: reasons.length > 0, reasons };
  }

  /** Jumlah trade rugi beruntun paling akhir. */
  async getConsecutiveLosses(): Promise<number> {
    const recent = await this.tradeRepo.find({
      where: { status: 'CLOSED', mode: this.config.mode as any },
      order: { closedAt: 'DESC' },
      take: 20,
    });

    let streak = 0;
    for (const t of recent) {
      if ((t.profitLoss ?? 0) < 0) streak++;
      else break;
    }
    return streak;
  }

  // ─── Keputusan entry ──────────────────────────────────────────────────────

  /**
   * Evaluasi apakah entry baru diperbolehkan dan berapa ukurannya.
   *
   * @param suggestedStop stop loss usulan strategi (berbasis ATR/struktur).
   */
  async evaluateEntry(
    pair: string,
    entryPrice: number,
    suggestedStop: number,
    suggestedTarget: number,
  ): Promise<RiskDecision> {
    const params = this.config.params();
    const deny = (reason: string): RiskDecision => ({
      allowed: false,
      reason,
      positionSize: 0,
      quantity: 0,
      stopLossPrice: 0,
      takeProfitPrice: 0,
      riskAmountIdr: 0,
      initialRiskPerUnit: 0,
    });

    // ── Kelayakan pair ──────────────────────────────────────────────────
    const tradable = this.pairs.isTradable(pair);
    if (!tradable.ok) return deny(tradable.reason!);

    // ── Batas jumlah posisi ─────────────────────────────────────────────
    const openTrades = await this.tradeRepo.find({ where: { status: In(['OPEN', 'PENDING', 'CLOSING']) } });

    if (openTrades.length >= params.maxConcurrentTrades) {
      return deny(
        `Sudah ada ${openTrades.length} posisi terbuka, batasnya ${params.maxConcurrentTrades}. ` +
          'Tutup salah satu dulu bila ingin beli yang ini.',
      );
    }

    if (openTrades.some((t) => t.pair === pair)) {
      return deny(
        `${pair.toUpperCase()} sudah Anda pegang. Bot tidak menambah di koin yang sama.`,
      );
    }

    // ── Batas korelasi ──────────────────────────────────────────────────
    // btcidr/ethidr/bnbidr bergerak hampir bersamaan; tiga posisi di sana
    // bukan diversifikasi, melainkan satu taruhan berukuran tiga kali lipat.
    const group = this.config.correlationGroup(pair);
    if (group !== 'OTHER') {
      const sameGroup = openTrades.filter((t) => this.config.correlationGroup(t.pair) === group);
      if (sameGroup.length >= params.maxPositionsPerCorrelationGroup) {
        return deny(
          `Kelompok ${group} sudah punya ${sameGroup.length} posisi (maks ${params.maxPositionsPerCorrelationGroup}): ${sameGroup.map((t) => t.pair).join(', ')}`,
        );
      }
    }

    // ── Cooldown setelah rugi ───────────────────────────────────────────
    const cooldown = await this.checkCooldown(pair, params.cooldownMinutesAfterLoss);
    if (cooldown) return deny(cooldown);

    // ── Kill switch ─────────────────────────────────────────────────────
    const kill = await this.checkKillSwitch();
    if (kill.halted) return deny(`Bot sedang menghentikan diri sendiri. Sebabnya: ${kill.reasons.join('; ')}`);

    // ── Validasi stop ───────────────────────────────────────────────────
    let stopLossPrice = suggestedStop;
    if (!(stopLossPrice > 0) || stopLossPrice >= entryPrice) {
      // Cadangan bila strategi tidak memberi stop yang masuk akal.
      stopLossPrice = entryPrice * (1 - params.minStopPercent / 100);
      this.logger.warn(`Stop usulan tidak valid untuk ${pair}, memakai ${params.minStopPercent}%`);
    }

    const stopDistancePercent = ((entryPrice - stopLossPrice) / entryPrice) * 100;
    if (stopDistancePercent > params.maxStopPercent) {
      return deny(
        `Koin ini bergerak terlalu liar. Supaya tidak kena jual karena gerakan ` +
        `biasa, batas ruginya harus dipasang ${stopDistancePercent.toFixed(2)}% di bawah ` +
        `harga — sedangkan setelan Anda hanya mengizinkan ${params.maxStopPercent}%. ` +
        'Bot memilih tidak beli daripada memasang batas yang pasti kena.',
      );
    }

    const initialRiskPerUnit = entryPrice - stopLossPrice;
    if (initialRiskPerUnit <= 0) return deny('Jarak risiko nol - stop tidak valid');

    // ── Sizing berbasis risiko ──────────────────────────────────────────
    const state = await this.portfolio.getState();
    if (state.degraded) {
      return deny('Data portofolio tidak lengkap (saldo/harga tidak terbaca) - entry dibatalkan');
    }

    const equity = state.equityIdr;
    if (equity <= 0) return deny('Ekuitas nol');

    const riskAmountIdr = equity * (params.riskPerTradePercent / 100);
    let quantity = riskAmountIdr / initialRiskPerUnit;
    let positionSize = quantity * entryPrice;

    // Batas atas: satu posisi tidak boleh menyerap terlalu banyak modal,
    // berapa pun ketatnya stop.
    const maxPosition = equity * (params.maxPositionPercent / 100);
    if (positionSize > maxPosition) {
      positionSize = maxPosition;
      quantity = positionSize / entryPrice;
    }

    // ── Fee & kas ───────────────────────────────────────────────────────
    // Fee taker dibebankan pada entry maupun exit. Menyisihkannya di sini
    // mencegah order ditolak karena kas kurang tipis.
    const feeRate = this.pairs.takerFeeRate(pair);
    const totalCost = positionSize * (1 + feeRate);

    if (totalCost > state.cashIdr) {
      positionSize = state.cashIdr / (1 + feeRate);
      quantity = positionSize / entryPrice;
    }

    const info = this.pairs.require(pair);
    if (positionSize < info.minOrderIdr) {
      return deny(
        `Uangnya tidak cukup untuk beli dengan aman. Dengan batas rugi sejauh ini, ` +
          `bot hanya boleh membelikan Rp ${Math.round(positionSize).toLocaleString('id-ID')} — ` +
          `sedangkan Indodax mewajibkan minimal Rp ${info.minOrderIdr.toLocaleString('id-ID')}. ` +
          `Uang bebas Anda Rp ${Math.round(state.cashIdr).toLocaleString('id-ID')}.`,
      );
    }

    // ── Target ──────────────────────────────────────────────────────────
    let takeProfitPrice = suggestedTarget;
    if (!(takeProfitPrice > entryPrice)) {
      takeProfitPrice = entryPrice + initialRiskPerUnit * (params.atrTargetMultiplier / params.atrStopMultiplier);
    }

    /**
     * Target harus menutup SELURUH biaya pulang-pergi agar rasio risk/reward
     * tetap jujur: fee dua sisi DAN spread.
     *
     * Spread sebelumnya tidak dihitung, dan akibatnya terukur. Dengan fee
     * 0,2% per sisi, target minimum lamanya +0,5% — cukup untuk FARTCOIN
     * (spread 0,03%, biaya nyata 0,43%), tetapi RUGI untuk setiap pair
     * ber-spread di atas 0,1%:
     *
     *   PEPE  spread 0,14% -> biaya nyata 0,54% > target 0,50%
     *   SHIB  spread 0,26% -> biaya nyata 0,66% > target 0,50%
     *   BONK  spread 0,73% -> biaya nyata 1,13% > target 0,50%
     *
     * Artinya posisi bisa mencapai take profit dan tetap kehilangan uang,
     * tanpa satu pun catatan yang menjelaskan sebabnya. Pada backtest
     * memecoin, PEPE menunjukkan fee drag 52% dan profit factor 0,24.
     *
     * Margin 0,1% di akhir menyisakan ruang untuk slippage kecil.
     */
    const spreadCost = this.spreadCostRate(pair, entryPrice);
    const minProfitablePrice = entryPrice * (1 + feeRate * 2 + spreadCost + 0.001);
    if (takeProfitPrice < minProfitablePrice) {
      takeProfitPrice = minProfitablePrice;
    }

    /**
     * Rasio imbalan/risiko (bagian 10 spesifikasi).
     *
     * Diperiksa di sini, bukan di Market Intelligence, karena Risk Engine-lah
     * yang memegang otoritas akhir atas keputusan risiko. Market Intelligence
     * boleh punya ambangnya sendiri yang lebih ketat; yang tidak boleh adalah
     * trade lolos ke exchange tanpa pernah melewati pemeriksaan ini.
     */
    if (params.minRiskReward > 0) {
      const riskReward = (takeProfitPrice - entryPrice) / initialRiskPerUnit;
      if (riskReward < params.minRiskReward) {
        return deny(
          `Untung yang mungkin didapat cuma ${riskReward.toFixed(2)}x dari yang dipertaruhkan. ` +
          `Setelan Anda mewajibkan minimal ${params.minRiskReward}x, supaya sekali menang ` +
          'bisa menutup beberapa kali kalah.',
        );
      }
    }

    return {
      allowed: true,
      positionSize,
      quantity,
      stopLossPrice,
      takeProfitPrice,
      riskAmountIdr: quantity * initialRiskPerUnit,
      initialRiskPerUnit,
    };
  }

  /** Tolak entry ulang pada pair yang baru saja merugi. */
  private async checkCooldown(pair: string, cooldownMinutes: number): Promise<string | null> {
    if (cooldownMinutes <= 0) return null;

    const lastClosed = await this.tradeRepo.findOne({
      where: { pair, status: 'CLOSED' },
      order: { closedAt: 'DESC' },
    });

    if (!lastClosed?.closedAt || (lastClosed.profitLoss ?? 0) >= 0) return null;

    const elapsedMin = (Date.now() - new Date(lastClosed.closedAt).getTime()) / 60000;
    if (elapsedMin < cooldownMinutes) {
      return `Cooldown ${pair}: ${Math.ceil(cooldownMinutes - elapsedMin)} menit lagi setelah trade rugi`;
    }
    return null;
  }

  // ─── Manajemen posisi berjalan ────────────────────────────────────────────

  /**
   * Hitung stop loss baru untuk posisi terbuka.
   *
   * Menerapkan dua tahap:
   *  1. Break-even — setelah profit mencapai N×R, stop digeser ke titik impas
   *     termasuk fee, sehingga trade tidak bisa lagi berubah menjadi kerugian.
   *  2. Trailing berbasis ATR — mengikuti harga pada jarak volatilitas, bukan
   *     persentase tetap.
   */
  calculateStopUpdate(
    trade: Trade,
    currentPrice: number,
    atr: number,
  ): { newStop: number; movedToBreakEven: boolean; reason: string } | null {
    const params = this.config.params();
    const currentStop = trade.trailingStopPrice || trade.stopLossPrice;

    if (trade.initialRiskPerUnit <= 0) return null;

    const rMultiple = (currentPrice - trade.entryPrice) / trade.initialRiskPerUnit;
    const feeRate = this.safeFeeRate(trade.pair);
    // Titik impas sesungguhnya: harga entry ditambah fee dua sisi.
    const breakEvenPrice = trade.entryPrice * (1 + feeRate * 2);

    let newStop = currentStop;
    let movedToBreakEven = false;
    let reason = '';

    if (!trade.breakEvenMoved && rMultiple >= params.breakEvenAtR) {
      if (breakEvenPrice > newStop) {
        newStop = breakEvenPrice;
        movedToBreakEven = true;
        reason = `Break-even terkunci di ${rMultiple.toFixed(2)}R`;
      }
    }

    if (rMultiple >= params.breakEvenAtR && atr > 0) {
      const trailStop = currentPrice - atr * params.trailingAtrMultiplier;
      if (trailStop > newStop) {
        newStop = trailStop;
        reason = reason || `Trailing ATR pada ${rMultiple.toFixed(2)}R`;
      }
    }

    // Stop hanya boleh naik, tidak pernah turun.
    if (newStop <= currentStop) return null;

    return { newStop, movedToBreakEven, reason };
  }

  /**
   * Tarif fee untuk memperkirakan biaya keluar.
   *
   * Sengaja memakai tarif TAKER meski entry mungkin maker: exit terburuk adalah
   * stop loss, dan stop loss selalu dieksekusi sebagai taker. Menaksir biaya
   * dengan tarif maker akan membuat target terlihat lebih mudah tercapai
   * daripada kenyataannya.
   */
  private safeFeeRate(pair: string): number {
    try {
      return this.pairs.takerFeeRate(pair);
    } catch {
      return 0.002;
    }
  }

  /**
   * Biaya spread sebagai fraksi harga, dari tick size pair.
   *
   * Spread sesungguhnya hanya diketahui dari order book, yang TIDAK tersedia
   * saat backtest dan belum tentu segar saat evaluasi. Yang dipakai di sini
   * adalah batas bawah yang pasti: satu tick. Pair berharga rendah dengan tick
   * besar punya spread minimum yang signifikan — pada harga Rp1 dengan tick
   * Rp1, satu tick saja sudah 100%.
   *
   * Ini sengaja konservatif ke arah yang aman: meremehkan spread membuat target
   * terlihat menguntungkan padahal rugi, sedangkan melebihkannya hanya membuat
   * target sedikit lebih jauh.
   */
  private spreadCostRate(pair: string, entryPrice: number): number {
    if (!(entryPrice > 0)) return 0;

    // Spread NYATA dari cache ringkasan pasar. Upaya pertama memakai tick size
    // sebagai pengganti, dan itu salah besar: diukur langsung, tick meremehkan
    // spread sebenarnya sampai 133x pada PEPE dan 544x pada SHIB. Meremehkan
    // biaya adalah arah kesalahan yang paling berbahaya di sini — target jadi
    // terlihat menguntungkan padahal rugi.
    const real = this.indodax.getCachedSpreadPercent(pair);
    if (real !== null && real >= 0) {
      // Dibatasi 2%: pair dengan spread lebih lebar dari itu seharusnya sudah
      // ditolak penyaring likuiditas, bukan dikompensasi dengan target jauh.
      return Math.min(real / 100, 0.02);
    }

    // Cache belum terisi. Tick size dipakai hanya sebagai lantai — jauh lebih
    // baik daripada nol, yang berarti "tidak ada biaya spread sama sekali".
    try {
      const tick = this.pairs.require(pair).priceStep;
      return tick > 0 ? Math.min(tick / entryPrice, 0.02) : 0;
    } catch {
      return 0;
    }
  }

  shouldTriggerStopLoss(trade: Trade, currentPrice: number): boolean {
    const effectiveStop = Math.max(trade.stopLossPrice, trade.trailingStopPrice || 0);
    return currentPrice <= effectiveStop;
  }

  shouldTriggerTakeProfit(trade: Trade, currentPrice: number): boolean {
    return currentPrice >= trade.takeProfitPrice;
  }

  /**
   * Tingkat take profit berikutnya yang sudah tercapai, bila ada.
   *
   * Mengembalikan indeks tingkat beserta porsi posisi yang harus dijual.
   * Tingkat diperiksa berurutan: melewatkan TP1 lalu langsung menjual porsi
   * TP2 akan menyisakan porsi yang tidak pernah terjual sampai posisi ditutup.
   */
  nextTakeProfitLevel(
    trade: Trade,
    currentPrice: number,
  ): { index: number; atR: number; closePercent: number; isFinal: boolean } | null {
    // Dinormalkan di sini juga: parameter bisa datang lewat override backtest
    // yang tidak melewati pembacaan .env.
    const levels = normalizeTakeProfitLevels(this.config.params().takeProfitLevels);
    if (!levels.length) return null;
    if (trade.initialRiskPerUnit <= 0) return null;

    const filled = trade.tpLevelsFilled ?? 0;
    if (filled >= levels.length) return null;

    const level = levels[filled];
    const rMultiple = (currentPrice - trade.entryPrice) / trade.initialRiskPerUnit;
    if (rMultiple < level.atR) return null;

    return {
      index: filled,
      atR: level.atR,
      closePercent: level.closePercent,
      isFinal: filled === levels.length - 1,
    };
  }

  /** Harga tiap tingkat take profit untuk entry tertentu. */
  takeProfitPlan(entryPrice: number, riskPerUnit: number): Array<{
    level: number;
    atR: number;
    price: number;
    closePercent: number;
  }> {
    return normalizeTakeProfitLevels(this.config.params().takeProfitLevels).map((l, i) => ({
      level: i + 1,
      atR: l.atR,
      price: entryPrice + riskPerUnit * l.atR,
      closePercent: l.closePercent,
    }));
  }


  /** Tutup posisi yang menggantung terlalu lama — modal tertahan tanpa hasil. */
  isStale(trade: Trade): boolean {
    const params = this.config.params();
    if (params.maxHoldingHours <= 0) return false;
    const opened = trade.openedAt ?? trade.createdAt;
    if (!opened) return false;
    const hours = (Date.now() - new Date(opened).getTime()) / 3600_000;
    return hours >= params.maxHoldingHours;
  }

  // ─── P&L ──────────────────────────────────────────────────────────────────

  /**
   * P&L bersih setelah fee kedua sisi.
   *
   * Versi lama mengabaikan fee sepenuhnya, sehingga setiap trade tampak lebih
   * untung ~0,4% dari kenyataan — cukup untuk mengubah sistem yang sebenarnya
   * merugi menjadi terlihat menguntungkan di laporan.
   */
  calculatePnL(
    trade: Trade,
    exitPrice: number,
    quantity?: number,
  ): { profitLoss: number; profitLossPercent: number; exitFee: number; rMultiple: number } {
    const qty = quantity ?? trade.remainingQuantity ?? trade.quantity;
    const feeRate = this.safeFeeRate(trade.pair);

    const grossProceeds = exitPrice * qty;
    const exitFee = grossProceeds * feeRate;
    // Catatan: fee entry yang dipakai di bawah adalah nilai NYATA yang tercatat
    // saat order terisi (trade.entryFee), bukan taksiran — jadi entry maker
    // otomatis terhitung lebih murah.

    const netProceeds = grossProceeds - exitFee;

    // Biaya perolehan proporsional termasuk porsi fee entry.
    const totalQty = trade.quantity || qty;
    const entryCostPortion = (trade.entryPrice * qty) + (trade.entryFee || 0) * (qty / totalQty);

    const profitLoss = netProceeds - entryCostPortion;
    const profitLossPercent = entryCostPortion > 0 ? (profitLoss / entryCostPortion) * 100 : 0;
    const riskIdr = trade.initialRiskPerUnit * qty;

    return {
      profitLoss,
      profitLossPercent,
      exitFee,
      rMultiple: riskIdr > 0 ? profitLoss / riskIdr : 0,
    };
  }

  // ─── Statistik ────────────────────────────────────────────────────────────

  async getDailyStats(): Promise<{
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnL: number;
    totalFees: number;
    openTrades: number;
    avgRMultiple: number;
  }> {
    const todayStart = startOfTradingDay();

    const closedToday = await this.tradeRepo
      .createQueryBuilder('t')
      .where('t.status = :status', { status: 'CLOSED' })
      .andWhere('t.mode = :mode', { mode: this.config.mode })
      .andWhere('t.closedAt >= :start', { start: todayStart })
      .getMany();

    const openTrades = await this.tradeRepo.count({ where: { status: In(['OPEN', 'PENDING', 'CLOSING']) } });

    const winTrades = closedToday.filter((t) => (t.profitLoss ?? 0) > 0).length;
    const lossTrades = closedToday.filter((t) => (t.profitLoss ?? 0) <= 0).length;
    const totalPnL = closedToday.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const totalFees = closedToday.reduce((s, t) => s + (t.entryFee || 0) + (t.exitFee || 0), 0);
    const avgR =
      closedToday.length > 0
        ? closedToday.reduce((s, t) => s + (t.rMultiple || 0), 0) / closedToday.length
        : 0;

    return {
      totalTrades: closedToday.length,
      winTrades,
      lossTrades,
      winRate: closedToday.length > 0 ? (winTrades / closedToday.length) * 100 : 0,
      totalPnL,
      totalFees,
      openTrades,
      avgRMultiple: avgR,
    };
  }

  /** Sisa jatah risiko hari ini, dalam persen ekuitas. */
  async getRemainingDailyRisk(): Promise<number> {
    const params = this.config.params();
    const stats = await this.getDailyStats();
    const state = await this.portfolio.getState();
    if (state.equityIdr <= 0) return 0;

    const lossPercent = (Math.min(0, stats.totalPnL) / state.equityIdr) * -100;
    return clamp(params.maxDailyLossPercent - lossPercent, 0, params.maxDailyLossPercent);
  }
}
