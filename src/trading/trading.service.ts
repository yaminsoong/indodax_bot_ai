import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { Signal } from '../database/entities/signal.entity';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { TechnicalService } from '../indicators/technical.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { StrategyContext, StrategySignal } from '../strategy/strategy.interface';
import { BotConfigService } from '../config/bot-config.service';
import { NotificationService } from '../notification/notification.service';
import { ChartBuilderService } from '../notification/chart-builder.service';
import { AuditService } from '../database/audit.service';
import { RiskService } from './risk.service';
import { PortfolioService } from './portfolio.service';
import { ExecutionService } from './execution.service';
import { KeyedMutex, Mutex } from '../common/mutex';
import { fmtPrice, idr } from '../common/num';
import { MarketIntelligenceService, MarketIntelligenceReport } from '../market-intelligence/market-intelligence.service';
import { MarketIntelligenceConfigService } from '../market-intelligence/mi-config.service';
import { SignalAuditService } from '../market-intelligence/signal-audit.service';
import { GateDecision, StrategyGateService } from '../market-intelligence/strategy-gate.service';
import { TradingStrategy } from '../strategy/strategy.interface';

/** Batas percobaan menutup posisi sebelum bot berhenti mencoba dan memanggil operator. */
const MAX_CLOSE_ATTEMPTS = 5;

/** Satu irisan performa dari trade nyata yang sudah ditutup. */
export interface PerformanceBreakdownSlice {
  label: string;
  trades: number;
  winRate: number;
  expectancyR: number;
  /** Galat baku ekspektasi — irisan bersampel kecil selalu tidak bisa dipercaya. */
  expectancyStdErrorR: number;
  netPnl: number;
  profitFactor: number | null;
  maxDrawdownIdr: number;
}

/**
 * Rentetan kerugian terdalam (dalam IDR) pada urutan trade yang diberikan.
 *
 * Bukan drawdown ekuitas sesungguhnya — itu butuh kurva ekuitas dan sudah
 * tersedia di PortfolioService. Ini ukuran yang lebih sempit tetapi berguna
 * untuk membandingkan antar irisan: seberapa buruk rentetan terburuk sebuah
 * regime atau bucket skor.
 */
function worstRun(trades: Trade[]): number {
  let worst = 0;
  let running = 0;
  const ordered = [...trades].sort(
    (a, b) => new Date(a.closedAt ?? a.createdAt).getTime() - new Date(b.closedAt ?? b.createdAt).getTime(),
  );
  for (const t of ordered) {
    running = Math.min(0, running + (t.profitLoss ?? 0));
    worst = Math.min(worst, running);
  }
  return Math.abs(worst);
}

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  /** Mencegah dua siklus trading berjalan tumpang tindih. */
  private readonly cycleMutex = new Mutex();
  /**
   * Sinyal yang ordernya sedang dikirim.
   *
   * Pemeriksaan database saja tidak cukup: antara pengecekan duplikat dan
   * tersimpannya baris trade ada jeda beberapa detik menunggu order terisi.
   * Tanpa penanda dalam memori, dua pemanggilan yang beriringan sama-sama
   * melihat database bersih dan sama-sama mengirim order.
   */
  private readonly inFlightEntries = new Set<string>();
  /**
   * Kunci per trade. Cron siklus (5 menit) dan cron monitor (2 menit) dulu bisa
   * menjalankan monitorOpenTrades bersamaan; keduanya membaca status 'OPEN' lalu
   * sama-sama mengirim order jual untuk posisi yang sama.
   */
  private readonly tradeMutex = new KeyedMutex();
  private readonly monitorMutex = new Mutex();

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly technical: TechnicalService,
    private readonly strategies: StrategyRegistry,
    private readonly risk: RiskService,
    private readonly portfolio: PortfolioService,
    private readonly execution: ExecutionService,
    private readonly notification: NotificationService,
    private readonly charts: ChartBuilderService,
    private readonly audit: AuditService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly intelligenceConfig: MarketIntelligenceConfigService,
    private readonly intelligenceGate: StrategyGateService,
    private readonly signalAudit: SignalAuditService,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
  ) {}

  // ─── Siklus trading ───────────────────────────────────────────────────────

  async runTradingCycle(): Promise<void> {
    return this.cycleMutex.runExclusive(async () => {
      const params = this.config.params();
      const strategy = this.strategies.active();

      this.logger.log(
        `=== Siklus Trading (${strategy.name}, mode ${this.config.mode}) — ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} ===`,
      );

      await this.pairs.refreshIfStale();

      // Kill switch dicek sekali di depan; bila aktif, tidak ada entry sama sekali.
      const kill = await this.risk.checkKillSwitch();
      if (kill.halted) {
        this.logger.warn(`Entry dihentikan: ${kill.reasons.join('; ')}`);
        await this.audit.log({
          category: 'RISK',
          event: 'KILL_SWITCH_ACTIVE',
          message: kill.reasons.join('; '),
        });
        await this.notification.sendKillSwitchAlert(kill.reasons);
      }

      const marketSummary = await this.indodax.getMarketSummary().catch(() => []);
      const volumeByPair = new Map<string, number>(
        marketSummary.map((m) => [m.pair, m.volumeIdr] as [string, number]),
      );

      for (const pair of params.tradingPairs) {
        try {
          await this.processPair(pair, volumeByPair.get(pair), kill.halted);
        } catch (err) {
          this.logger.error(`Kesalahan memproses ${pair}: ${err.message}`);
          await this.audit.log({
            category: 'SYSTEM',
            event: 'PAIR_PROCESS_ERROR',
            pair,
            message: err.message,
            isError: true,
          });
        }
      }
    });
  }

  /** Evaluasi satu pair: hitung sinyal, catat, dan eksekusi bila lolos risiko. */
  private async processPair(
    pair: string,
    volumeIdr24h: number | undefined,
    entriesHalted: boolean,
  ): Promise<void> {
    const params = this.config.params();
    const strategy = this.strategies.active();

    const tradable = this.pairs.isTradable(pair);
    if (!tradable.ok) {
      this.logger.warn(`Melewati ${pair}: ${tradable.reason}`);
      return;
    }

    // Candle timeframe utama dan HTF. Keduanya hanya candle yang sudah tertutup.
    const [candles, htfCandles] = await Promise.all([
      this.indodax.getCandles(pair, params.candleTimeframe, params.candleLimit),
      params.requireHtfTrend
        ? this.indodax.getCandles(pair, params.htfTimeframe, 120).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (candles.length < strategy.minCandles) {
      this.logger.warn(`Candle ${pair} kurang: ${candles.length}/${strategy.minCandles}`);
      return;
    }

    const openTrade = await this.tradeRepo.findOne({
      where: { pair, status: In(['OPEN', 'PENDING', 'CLOSING']) },
    });

    // Order book hanya diambil bila berpotensi dipakai (hemat rate limit).
    let orderBook: StrategyContext['orderBook'];
    if (!openTrade && !entriesHalted) {
      try {
        orderBook = this.technical.analyzeOrderBook(await this.indodax.getOrderBook(pair));
      } catch (err) {
        this.logger.warn(`Order book ${pair} tidak terbaca: ${err.message}`);
      }
    }

    const ctx: StrategyContext = {
      pair,
      candles,
      htfCandles,
      orderBook,
      volumeIdr24h,
      params,
      hasOpenPosition: !!openTrade,
    };

    const signal = strategy.evaluate(ctx);
    const currentPrice = candles[candles.length - 1].close;

    this.logSignal(pair, currentPrice, signal);
    const saved = await this.saveSignal(pair, strategy.name, signal);

    // Sinyal keluar untuk posisi yang sedang berjalan.
    if (openTrade && signal.action === 'SELL' && openTrade.status === 'OPEN') {
      await this.closeTrade(openTrade.id, 'STRATEGY_EXIT', signal.reasons.join(' | '));
      await this.signalRepo.update(saved.id, { executed: 1 });
      return;
    }

    if (openTrade || entriesHalted) return;

    if (signal.action !== 'BUY') return;

    // ── Lapisan Market Intelligence ──────────────────────────────────────
    // Berjalan SETELAH strategi menghasilkan BUY, dan hanya bisa menolak.
    // Sinyal tidak pernah dibuat di sini.
    const gate = await this.runIntelligenceGate(pair, strategy, candles);

    if (gate && !gate.decision.allowed) {
      this.logger.log(
        `🧠 Market Intelligence menolak BUY ${pair.toUpperCase()} ` +
          `(skor ${gate.decision.score}/${gate.decision.minScore}): ${gate.decision.rejections[0]}`,
      );
      await this.audit.log({
        category: 'RISK',
        event: 'INTELLIGENCE_REJECTED',
        pair,
        message: gate.decision.rejections.join(' | '),
        data: { score: gate.decision.score, minScore: gate.decision.minScore, decision: gate.decision.decision },
      });
      await this.signalRepo.update(saved.id, {
        blockedBy: [signal.blockedBy.join(' | '), ...gate.decision.rejections]
          .filter(Boolean)
          .join(' | '),
      });
      return;
    }

    const executed = await this.openPosition(
      pair,
      currentPrice,
      signal,
      strategy.name,
      gate ?? undefined,
      candles[candles.length - 1].time,
    );
    if (executed) await this.signalRepo.update(saved.id, { executed: 1 });
  }

  // ─── Market Intelligence ──────────────────────────────────────────────────

  /**
   * Jalankan analisis Market Intelligence dan gerbang strategi.
   *
   * Mengembalikan null bila lapisan ini dimatikan atau gagal. Kegagalan
   * analisis TIDAK memblokir trading: strategi dan risk engine yang sudah ada
   * tetap menjadi jalur utama, sehingga masalah pada lapisan baru tidak
   * mematikan bot yang sebelumnya berjalan. Kegagalan dicatat agar tidak
   * lewat tanpa disadari.
   */
  private async runIntelligenceGate(
    pair: string,
    strategy: TradingStrategy,
    candles: import('../indodax/indodax.types').Candle[],
  ): Promise<{ report: MarketIntelligenceReport; decision: GateDecision; analysisId?: number } | null> {
    const miParams = this.intelligenceConfig.params();
    if (!miParams.enabled) return null;

    try {
      const params = this.config.params();
      const report = await this.intelligence.analyze(pair, {
        direction: 'LONG',
        atrStopMultiplier: params.atrStopMultiplier,
      });

      const decision = this.intelligenceGate.evaluate(strategy, report);

      this.logger.log(
        `🧠 ${pair.toUpperCase()} skor ${decision.score}/100 (${decision.decision}), ` +
          `regime ${report.confluence.regime}, R/R 1:${report.confluence.setup?.riskReward.toFixed(1) ?? '-'}` +
          (decision.observeOnly ? ' [observasi saja]' : ''),
      );

      let analysisId: number | undefined;
      if (miParams.auditEnabled) {
        const saved = await this.signalAudit.record(report, {
          strategy: strategy.name,
          mode: this.config.mode,
          observeOnly: decision.observeOnly,
        });
        analysisId = saved?.id;
      }

      await this.maybeAlertSetup(report, decision, miParams);

      return { report, decision, analysisId };
    } catch (err) {
      this.logger.warn(`Market Intelligence ${pair} gagal: ${err.message}`);
      await this.audit.log({
        category: 'SYSTEM',
        event: 'INTELLIGENCE_ERROR',
        pair,
        message: err.message,
        isError: true,
      });
      return null;
    }
  }

  private logSignal(pair: string, price: number, signal: StrategySignal): void {
    const s = signal.snapshot;
    const parts = [
      `${pair.toUpperCase()}`,
      `Harga: ${fmtPrice(price)}`,
      `${signal.action} (${signal.strength}%)`,
      `EMA ${fmtPrice(s.ema5)}/${fmtPrice(s.ema13)}/${fmtPrice(s.ema21)}`,
      `RSI ${s.rsi.toFixed(1)}`,
      `ADX ${s.adx.toFixed(1)}`,
      `Chop ${s.choppiness.toFixed(0)}`,
      `ATR ${s.atrPercent.toFixed(2)}%`,
      `${s.trend}/${s.regime}`,
      `HTF ${s.htfTrend}`,
    ];
    this.logger.log(parts.join(' | '));

    if (signal.blockedBy.length) {
      this.logger.debug(`  ↳ ditahan: ${signal.blockedBy.join('; ')}`);
    }
  }

  private async saveSignal(pair: string, strategyName: string, signal: StrategySignal): Promise<Signal> {
    const s = signal.snapshot;
    return this.signalRepo.save({
      pair,
      strategy: strategyName,
      action: signal.action,
      price: s.price,
      ema5: s.ema5,
      ema13: s.ema13,
      ema21: s.ema21,
      ema50: s.ema50,
      rsi: s.rsi,
      macdHistogram: s.macdHistogram,
      atr: s.atr,
      atrPercent: s.atrPercent,
      adx: s.adx,
      choppiness: s.choppiness,
      volume: s.volume,
      volumeAvg: s.volumeAvg,
      trend: s.trend,
      regime: s.regime,
      htfTrend: s.htfTrend,
      orderBookImbalance: s.orderBookImbalance,
      strength: signal.strength,
      reason: signal.reasons.join(' | '),
      blockedBy: signal.blockedBy.join(' | ') || null,
    });
  }

  /**
   * Kirim alert Telegram untuk setup berkualitas tinggi.
   *
   * Hanya setup yang LOLOS seluruh blocker dan mencapai ambang skor yang
   * dikirim. Alert untuk setiap sinyal akan membuat notifikasi diabaikan
   * dalam hitungan hari — dan notifikasi yang diabaikan tidak berguna saat
   * benar-benar ada yang penting.
   */
  private async maybeAlertSetup(
    report: MarketIntelligenceReport,
    decision: GateDecision,
    miParams: { alertEnabled: boolean; alertMinScore: number },
  ): Promise<void> {
    if (!miParams.alertEnabled) return;
    if (decision.rejections.length) return;
    if (decision.score < miParams.alertMinScore) return;

    const setup = report.confluence.setup;
    if (!setup) return;

    const structure =
      report.mtf.timeframes[report.confluence.timeframe]?.structure?.latest.BOS ??
      report.mtf.timeframes[report.confluence.timeframe]?.structure?.latest.CHOCH;

    await this.notification.sendSetupAlert({
      pair: report.pair,
      direction: report.confluence.direction,
      score: decision.score,
      decision: report.confluence.decision,
      regime: report.confluence.regime,
      structure: structure ? `${structure.type} ${structure.direction}` : 'tidak ada event',
      entryLow: setup.entryLow,
      entryHigh: setup.entryHigh,
      stopLoss: setup.stopLoss,
      takeProfit1: setup.takeProfit1,
      takeProfit2: setup.takeProfit2,
      takeProfit3: setup.takeProfit3,
      riskReward: setup.riskReward,
      reasons: report.explanation.reasons,
      risks: report.explanation.risks,
      executable: report.confluence.executable,
    });
  }

  // ─── Buka posisi ──────────────────────────────────────────────────────────

  /**
   * Sebab kegagalan entry terakhir per pair.
   *
   * `openPosition` mengembalikan boolean, dan dua keadaan yang sangat berbeda
   * sama-sama menghasilkan `false`: order maker yang tidak tersentuh harga
   * (normal, tanpa biaya) dan penolakan exchange yang sungguhan. Jalur manual
   * karena itu melaporkan keduanya sebagai "Order tidak tereksekusi — periksa
   * log", yang terbaca seperti kerusakan padahal biasanya bukan.
   *
   * Operator yang menekan CONFIRM berhak tahu mana yang terjadi.
   */
  private readonly lastEntryFailure = new Map<string, { missed: boolean; reason: string }>();

  private async openPosition(
    pair: string,
    price: number,
    signal: StrategySignal,
    strategyName: string,
    gate?: { report: MarketIntelligenceReport; decision: GateDecision; analysisId?: number },
    barTime?: number,
  ): Promise<boolean> {
    /**
     * Proteksi order ganda (bagian 23 spesifikasi).
     *
     * Satu sinyal diidentifikasi oleh pair + strategi + waktu candle. Selama
     * candle itu belum berganti, sinyal yang sama tidak boleh menghasilkan
     * order kedua - berapa kali pun siklus dijalankan ulang, baik oleh cron,
     * perintah Telegram, tombol dashboard, maupun restart di tengah proses.
     */
    const signalRef = buildSignalRef(pair, strategyName, barTime);

    if (this.inFlightEntries.has(signalRef)) {
      // Sebab dicatat agar pesan ke operator menyebut keadaan sebenarnya,
      // bukan "periksa log". Menekan tombol dua kali adalah hal yang wajar.
      this.lastEntryFailure.set(pair.toLowerCase(), {
        missed: false,
        reason: 'order untuk sinyal yang sama sedang diproses - tunggu beberapa detik',
      });
      this.logger.warn(`Entry ${pair.toUpperCase()} untuk sinyal ${signalRef} sedang diproses - dilewati`);
      return false;
    }

    const duplicate = await this.tradeRepo.findOne({ where: { signalRef } });
    if (duplicate) {
      this.logger.warn(
        `Sinyal ${signalRef} sudah menghasilkan trade #${duplicate.id} (${duplicate.status}) - order ganda dicegah`,
      );
      this.lastEntryFailure.set(pair.toLowerCase(), {
        missed: false,
        reason:
          `sinyal ini sudah menghasilkan trade #${duplicate.id} (${duplicate.status}). ` +
          'Satu sinyal hanya boleh dieksekusi sekali - tunggu candle berikutnya',
      });
      await this.audit.log({
        category: 'ORDER',
        event: 'DUPLICATE_ENTRY_BLOCKED',
        pair,
        tradeId: duplicate.id,
        message: `Sinyal ${signalRef} sudah dieksekusi sebelumnya`,
      });
      return false;
    }

    this.inFlightEntries.add(signalRef);
    try {
      return await this.openPositionGuarded(pair, price, signal, strategyName, signalRef, gate);
    } finally {
      this.inFlightEntries.delete(signalRef);
    }
  }

  private async openPositionGuarded(
    pair: string,
    price: number,
    signal: StrategySignal,
    strategyName: string,
    signalRef: string,
    gate?: { report: MarketIntelligenceReport; decision: GateDecision; analysisId?: number },
  ): Promise<boolean> {
    const decision = await this.risk.evaluateEntry(
      pair,
      price,
      signal.suggestedStopLoss ?? 0,
      signal.suggestedTakeProfit ?? 0,
    );

    if (!decision.allowed) {
      /**
       * Sebab penolakan WAJIB dicatat, bukan hanya di-audit.
       *
       * `openManualPosition` membaca `lastEntryFailure` untuk menyusun pesan
       * ke operator. Sebelum ini, jalur risk engine hanya menulis ke log dan
       * tabel audit lalu mengembalikan false - sehingga operator menerima
       * "Order tidak tereksekusi - periksa log" padahal sebabnya sudah
       * diketahui persis.
       *
       * Diukur pada kasus nyata: ZEREBROIDR ditolak dengan "Jarak stop 7.18%
       * melebihi batas 6%", tetapi kartu Telegram hanya menampilkan "periksa
       * log". Operator menyimpulkan ada kerusakan, padahal aturannya bekerja
       * sebagaimana mestinya.
       */
      this.lastEntryFailure.set(pair.toLowerCase(), {
        missed: false,
        reason: decision.reason ?? 'ditolak risk engine tanpa sebab tercatat',
      });
      this.logger.log(`Risiko menolak BUY ${pair}: ${decision.reason}`);
      await this.audit.log({
        category: 'RISK',
        event: 'ENTRY_BLOCKED',
        pair,
        message: decision.reason,
      });
      return false;
    }

    const params = this.config.params();

    /**
     * Harga boleh lari antara sinyal dihitung dan order dikirim. Bila sudah
     * melewati batas atas zona, setup yang sama sudah bukan setup yang sama:
     * jarak ke stop melebar, rasio imbalan menyusut, dan bot akan membeli
     * tepat di tempat yang tadinya dinilai terlalu mahal.
     */
    if (signal.suggestedEntryHigh && signal.suggestedEntryHigh > 0) {
      const ticker = await this.indodax.getTicker(pair).catch(() => null);
      const askNow = ticker?.sell ?? price;

      if (askNow > signal.suggestedEntryHigh) {
        const overshoot = ((askNow - signal.suggestedEntryHigh) / signal.suggestedEntryHigh) * 100;
        this.logger.log(
          `Entry ${pair.toUpperCase()} dilewat: harga ${fmtPrice(askNow)} sudah ` +
            `${overshoot.toFixed(2)}% di atas batas zona ${fmtPrice(signal.suggestedEntryHigh)}`,
        );
        await this.audit.log({
          category: 'RISK',
          event: 'ENTRY_OUT_OF_ZONE',
          pair,
          message: `Harga ${askNow} di atas zona ${signal.suggestedEntryLow}-${signal.suggestedEntryHigh}`,
          data: { askNow, zoneLow: signal.suggestedEntryLow, zoneHigh: signal.suggestedEntryHigh },
        });
        return false;
      }
    }

    const outcome = await this.execution.execute({
      pair,
      side: 'buy',
      amount: decision.positionSize,
      referencePrice: price,
      style: params.makerEntry ? 'MAKER' : 'TAKER',
    });

    if (!outcome.success || outcome.filledCoin <= 0) {
      // Order maker yang tidak tersentuh harga bukan kegagalan — peluang lewat,
      // tidak ada biaya, dan tidak perlu mengganggu operator dengan alarm.
      if (outcome.missed) {
        this.lastEntryFailure.set(pair.toLowerCase(), {
          missed: true,
          reason: outcome.error ?? 'limit maker tidak tersentuh harga',
        });
        this.logger.log(`Entry maker ${pair.toUpperCase()} tidak terisi - peluang dilewat`);
        await this.audit.log({
          category: 'ORDER',
          event: 'MAKER_ENTRY_MISSED',
          pair,
          message: outcome.error,
        });
        return false;
      }

      this.lastEntryFailure.set(pair.toLowerCase(), {
        missed: false,
        reason: outcome.error ?? 'tidak terisi',
      });
      this.logger.error(`BUY ${pair} tidak tereksekusi: ${outcome.error}`);
      await this.notification.sendAlert(
        `Order BUY ${pair.toUpperCase()} gagal: ${outcome.error ?? 'tidak terisi'}`,
      );
      return false;
    }

    // Kuantitas yang benar-benar diterima, setelah fee dipotong exchange.
    const feeRate = this.pairs.feeRate(pair, outcome.style === 'MAKER');
    const netQuantity = outcome.filledCoin * (1 - feeRate);
    const entryPrice = outcome.avgPrice;

    // Stop & target digeser mengikuti harga entry sesungguhnya, bukan harga sinyal,
    // sehingga jarak risiko dan imbalan tetap sama seperti yang disetujui risk engine.
    const riskPerUnit = decision.initialRiskPerUnit;
    const rewardPerUnit = decision.takeProfitPrice - price;
    const stopLossPrice = entryPrice - riskPerUnit;
    const takeProfitPrice = entryPrice + rewardPerUnit;

    const trade = await this.tradeRepo.save({
      pair,
      type: 'BUY',
      status: 'OPEN',
      mode: this.config.mode,
      strategy: strategyName,
      entryPrice,
      signalPrice: price,
      quantity: netQuantity,
      remainingQuantity: netQuantity,
      totalValue: outcome.filledIdr + outcome.feeIdr,
      entryFee: outcome.feeIdr,
      entryOrderId: outcome.orderId,
      stopLossPrice,
      takeProfitPrice,
      initialRiskPerUnit: riskPerUnit,
      riskAmountIdr: riskPerUnit * netQuantity,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      entryZoneLow: signal.suggestedEntryLow ?? null,
      entryZoneHigh: signal.suggestedEntryHigh ?? null,
      // Rencana TP dibekukan saat entry: mengubah parameter di tengah posisi
      // tidak boleh menggeser target yang sudah disetujui risk engine.
      takeProfitPlan: JSON.stringify(this.risk.takeProfitPlan(entryPrice, riskPerUnit)),
      openedAt: new Date(),
      signalRef,
      intelligenceScore: gate?.decision.score ?? null,
      marketRegime: gate?.report.confluence.regime ?? null,
      signalAnalysisId: gate?.analysisId ?? null,
      signalData: JSON.stringify({
        strength: signal.strength,
        reasons: signal.reasons,
        snapshot: signal.snapshot,
        slippagePercent: outcome.slippagePercent,
        partial: outcome.partial,
        intelligence: gate
          ? {
              score: gate.decision.score,
              minScore: gate.decision.minScore,
              decision: gate.decision.decision,
              regime: gate.report.confluence.regime,
              riskReward: gate.report.confluence.setup?.riskReward ?? null,
              breakdown: gate.report.confluence.breakdown,
              confirmations: gate.decision.confirmations,
              warnings: gate.decision.warnings,
              observeOnly: gate.decision.observeOnly,
              // Penolakan tetap dicatat walau trade jadi diambil: dalam mode
              // observasi inilah satu-satunya bukti untuk menilai apakah
              // gerbang layak dinyalakan.
              rejectionsIgnored: gate.decision.observeOnly ? gate.decision.rejections : [],
            }
          : null,
      }),
    });

    if (gate?.analysisId) {
      await this.signalAudit.markExecuted(gate.analysisId, trade.id);
    }

    this.portfolio.adjustSimulatedCash(-(outcome.filledIdr + outcome.feeIdr));

    this.logger.log(
      `✅ BUY ${pair.toUpperCase()} @ ${fmtPrice(entryPrice)} | ${idr(outcome.filledIdr)} | ` +
        `SL ${fmtPrice(stopLossPrice)} | TP ${fmtPrice(takeProfitPrice)} | ` +
        `Risiko ${idr(riskPerUnit * netQuantity)} | Slippage ${outcome.slippagePercent.toFixed(3)}%`,
    );

    await this.audit.log({
      category: 'ORDER',
      event: 'POSITION_OPENED',
      pair,
      tradeId: trade.id,
      data: {
        entryPrice,
        signalPrice: price,
        quantity: netQuantity,
        fee: outcome.feeIdr,
        stopLossPrice,
        takeProfitPrice,
        partial: outcome.partial,
      },
    });

    // Chart dibangun sebelum notifikasi dikirim, dengan garis entry/stop/target
    // supaya operator bisa menilai posisinya terhadap struktur harga tanpa
    // membuka aplikasi lain. Kegagalannya tidak menggagalkan notifikasi.
    const buyChart = await this.charts.build(pair, {
      trade: { entry: entryPrice, stopLoss: stopLossPrice, takeProfit: takeProfitPrice },
      subtitle: `${strategyName} · kekuatan ${signal.strength}`,
    });

    await this.notification.sendTradeAlert({
      type: 'BUY',
      tradeId: trade.id,
      pair,
      price: entryPrice,
      amount: outcome.filledIdr,
      quantity: netQuantity,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
      riskIdr: riskPerUnit * netQuantity,
      fee: outcome.feeIdr,
      slippagePercent: outcome.slippagePercent,
      reasons: signal.reasons,
      strategy: strategyName,
      mode: this.config.mode,
    }, buyChart);

    return true;
  }

  // ─── Monitor posisi terbuka ───────────────────────────────────────────────

  /**
   * Periksa seluruh posisi terbuka: stop loss, take profit, partial TP,
   * break-even, trailing, dan posisi yang terlalu lama menggantung.
   */
  async monitorOpenTrades(): Promise<void> {
    return this.monitorMutex.runExclusive(async () => {
      const openTrades = await this.tradeRepo.find({ where: { status: In(['OPEN', 'CLOSING']) } });
      if (!openTrades.length) return;

      for (const trade of openTrades) {
        try {
          await this.monitorTrade(trade.id);
        } catch (err) {
          this.logger.error(`Gagal memonitor trade #${trade.id} (${trade.pair}): ${err.message}`);
          await this.audit.log({
            category: 'SYSTEM',
            event: 'MONITOR_ERROR',
            pair: trade.pair,
            tradeId: trade.id,
            message: err.message,
            isError: true,
          });
        }
      }
    });
  }

  private async monitorTrade(tradeId: number): Promise<void> {
    await this.tradeMutex.runExclusive(String(tradeId), async () => {
      // Baca ulang di dalam kunci: status bisa berubah sejak daftar dibuat.
      const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
      if (!trade || !['OPEN', 'CLOSING'].includes(trade.status)) return;

      const ticker = await this.indodax.getTicker(trade.pair);
      const currentPrice = ticker.last;

      // Rekam ekstrem harga untuk analisis MFE/MAE.
      const updates: Partial<Trade> = {};
      if (currentPrice > (trade.highestPrice || 0)) updates.highestPrice = currentPrice;
      if (currentPrice < (trade.lowestPrice || Infinity) || !trade.lowestPrice) {
        updates.lowestPrice = currentPrice;
      }
      if (Object.keys(updates).length) {
        await this.tradeRepo.update(trade.id, updates);
        Object.assign(trade, updates);
      }

      // ── Stop loss lebih dulu: perlindungan modal mendahului segalanya ──
      if (this.risk.shouldTriggerStopLoss(trade, currentPrice)) {
        const effectiveStop = Math.max(trade.stopLossPrice, trade.trailingStopPrice || 0);
        await this.executeClose(
          trade,
          currentPrice,
          trade.breakEvenMoved ? 'TRAILING_STOP' : 'STOP_LOSS',
          `Harga ${fmtPrice(currentPrice)} menembus stop ${fmtPrice(effectiveStop)}`,
          true,
        );
        return;
      }

      if (this.risk.shouldTriggerTakeProfit(trade, currentPrice)) {
        await this.executeClose(
          trade,
          currentPrice,
          'TAKE_PROFIT',
          `Target ${fmtPrice(trade.takeProfitPrice)} tercapai`,
          false,
        );
        return;
      }

      if (this.risk.isStale(trade)) {
        await this.executeClose(
          trade,
          currentPrice,
          'MAX_HOLDING_TIME',
          `Posisi melewati ${this.config.params().maxHoldingHours} jam`,
          false,
        );
        return;
      }

      // ── Take profit bertingkat ────────────────────────────────────────
      if (trade.status === 'OPEN') {
        const level = this.risk.nextTakeProfitLevel(trade, currentPrice);
        if (level) {
          await this.takeProfitLevel(trade, currentPrice, level);
          return;
        }
      }

      // ── Break-even & trailing ─────────────────────────────────────────
      await this.updateStop(trade, currentPrice);

      const rMultiple =
        trade.initialRiskPerUnit > 0
          ? (currentPrice - trade.entryPrice) / trade.initialRiskPerUnit
          : 0;
      const pnlPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

      this.logger.log(
        `📊 #${trade.id} ${trade.pair.toUpperCase()} | Entry ${fmtPrice(trade.entryPrice)} → ` +
          `${fmtPrice(currentPrice)} | ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% ` +
          `(${rMultiple >= 0 ? '+' : ''}${rMultiple.toFixed(2)}R) | ` +
          `Stop ${fmtPrice(Math.max(trade.stopLossPrice, trade.trailingStopPrice || 0))}`,
      );
    });
  }

  /** Geser stop ke break-even lalu ikuti harga dengan jarak ATR. */
  private async updateStop(trade: Trade, currentPrice: number): Promise<void> {
    const params = this.config.params();

    let atr = 0;
    try {
      const candles = await this.indodax.getCandles(trade.pair, params.candleTimeframe, 60);
      if (candles.length >= 20) atr = this.technical.calculateATR(candles, 14);
    } catch (err) {
      this.logger.warn(`ATR ${trade.pair} tidak terhitung: ${err.message}`);
    }

    const update = this.risk.calculateStopUpdate(trade, currentPrice, atr);
    if (!update) return;

    await this.tradeRepo.update(trade.id, {
      trailingStopPrice: update.newStop,
      breakEvenMoved: update.movedToBreakEven ? 1 : trade.breakEvenMoved,
    });
    trade.trailingStopPrice = update.newStop;
    if (update.movedToBreakEven) trade.breakEvenMoved = 1;

    this.logger.log(
      `🔒 #${trade.id} ${trade.pair.toUpperCase()} stop → ${fmtPrice(update.newStop)} (${update.reason})`,
    );

    await this.audit.log({
      category: 'RISK',
      event: update.movedToBreakEven ? 'BREAK_EVEN_LOCKED' : 'TRAILING_STOP_MOVED',
      pair: trade.pair,
      tradeId: trade.id,
      message: update.reason,
      data: { newStop: update.newStop, currentPrice },
    });

    if (update.movedToBreakEven) {
      await this.notification.sendInfo(
        `🔒 #${trade.id} ${trade.pair.toUpperCase()} sudah aman — stop dikunci di titik impas ${fmtPrice(update.newStop)}`,
      );
    }
  }

  /** Jual sebagian posisi untuk mengunci profit, sisanya dibiarkan berjalan. */
  /**
   * Jual satu porsi posisi pada tingkat take profit yang tercapai.
   *
   * Porsi dihitung dari kuantitas ASLI, bukan sisa: TP1 30% + TP2 30% harus
   * menjual 30% dari posisi awal dua kali, bukan 30% dari sisa 70% (yang hanya
   * 21%). Kesalahan itu menyisakan porsi yang terus mengecil dan akhirnya
   * jatuh di bawah minimum order — mustahil dijual sampai posisi ditutup paksa.
   */
  private async takeProfitLevel(
    trade: Trade,
    currentPrice: number,
    level: { index: number; atR: number; closePercent: number; isFinal: boolean },
  ): Promise<void> {
    const label = `TP${level.index + 1}`;

    // Tingkat terakhir menutup seluruh sisa, supaya tidak ada remah posisi
    // yang tertinggal di bawah minimum order.
    const desired = level.isFinal
      ? trade.remainingQuantity
      : trade.quantity * (level.closePercent / 100);

    const sellQty = this.pairs.normalizeCoinAmount(
      trade.pair,
      Math.min(desired, trade.remainingQuantity),
    );

    const check = this.pairs.validateOrder(
      trade.pair,
      'sell',
      currentPrice,
      sellQty * currentPrice,
      sellQty,
    );
    if (!check.ok) {
      // Porsi terlalu kecil untuk dijual terpisah. Tingkat ditandai lewat agar
      // monitor tidak mencobanya berulang kali tiap menit; sisanya akan ikut
      // terjual pada tingkat berikutnya atau saat posisi ditutup.
      this.logger.debug(`${label} #${trade.id} dilewati: ${check.reason}`);
      await this.tradeRepo.update(trade.id, { tpLevelsFilled: level.index + 1 });
      return;
    }

    const params = this.config.params();
    const outcome = await this.execution.execute({
      pair: trade.pair,
      side: 'sell',
      amount: sellQty,
      referencePrice: currentPrice,
      style: params.makerTakeProfit ? 'MAKER' : 'TAKER',
    });

    if (!outcome.success || outcome.filledCoin <= 0) {
      this.logger.warn(`${label} #${trade.id} gagal: ${outcome.error}`);
      return;
    }

    const pnl = this.risk.calculatePnL(trade, outcome.avgPrice, outcome.filledCoin);
    const remaining = Math.max(0, trade.remainingQuantity - outcome.filledCoin);

    const update: Partial<Trade> = {
      remainingQuantity: remaining,
      tpLevelsFilled: level.index + 1,
      realizedPnl: (trade.realizedPnl || 0) + pnl.profitLoss,
      exitFee: (trade.exitFee || 0) + outcome.feeIdr,
    };

    // Setelah tingkat pertama, sisa posisi dijalankan tanpa risiko.
    if (level.index === 0) {
      update.trailingStopPrice = Math.max(trade.trailingStopPrice || 0, trade.entryPrice);
      update.breakEvenMoved = 1;
    }

    await this.tradeRepo.update(trade.id, update);
    this.portfolio.adjustSimulatedCash(outcome.filledIdr - outcome.feeIdr);

    this.logger.log(
      `💰 ${label} #${trade.id} ${trade.pair.toUpperCase()} @ ${level.atR}R: ` +
        `${outcome.filledCoin.toFixed(8)} @ ${fmtPrice(outcome.avgPrice)} | ` +
        `Profit ${idr(pnl.profitLoss)} | Sisa ${remaining.toFixed(8)}`,
    );

    await this.audit.log({
      category: 'ORDER',
      event: 'TAKE_PROFIT_LEVEL',
      pair: trade.pair,
      tradeId: trade.id,
      data: {
        level: level.index + 1,
        atR: level.atR,
        soldCoin: outcome.filledCoin,
        price: outcome.avgPrice,
        profit: pnl.profitLoss,
        remaining,
      },
    });

    await this.notification.sendPartialTakeProfit({
      tradeId: trade.id,
      pair: trade.pair,
      level: level.index + 1,
      atR: level.atR,
      quantity: outcome.filledCoin,
      price: outcome.avgPrice,
      profit: pnl.profitLoss,
      remainingQuantity: remaining,
    });

    // Sisa habis: posisi ditutup dan dicatat sebagai selesai.
    if (remaining <= 0) {
      const refreshed = await this.tradeRepo.findOne({ where: { id: trade.id } });
      if (refreshed) await this.finalizeClosedByTakeProfit(refreshed);
    }
  }

  /**
   * Tutup pembukuan posisi yang habis terjual lewat tingkat take profit.
   * Tidak mengirim order baru — seluruh kuantitasnya memang sudah terjual.
   */
  private async finalizeClosedByTakeProfit(trade: Trade): Promise<void> {
    const totalRisk = trade.initialRiskPerUnit * trade.quantity;
    const totalPnl = trade.realizedPnl || 0;

    await this.tradeRepo.update(trade.id, {
      status: 'CLOSED',
      exitPrice: trade.entryPrice + (totalRisk > 0 ? totalPnl / trade.quantity : 0),
      profitLoss: totalPnl,
      profitLossPercent: trade.totalValue > 0 ? (totalPnl / trade.totalValue) * 100 : 0,
      rMultiple: totalRisk > 0 ? totalPnl / totalRisk : 0,
      remainingQuantity: 0,
      closeReason: 'TAKE_PROFIT_ALL',
      closedAt: new Date(),
    });

    this.logger.log(
      `✅ TUTUP #${trade.id} ${trade.pair.toUpperCase()} | seluruh tingkat TP tercapai | ` +
        `P&L ${idr(totalPnl)} (${totalRisk > 0 ? (totalPnl / totalRisk).toFixed(2) : '0'}R)`,
    );
  }

  // ─── Tutup posisi ─────────────────────────────────────────────────────────

  /** Tutup posisi berdasarkan id, dengan penguncian agar tidak terjadi jual ganda. */
  async closeTrade(
    tradeId: number,
    reason: string,
    detail = '',
  ): Promise<{ success: boolean; message: string }> {
    return this.tradeMutex.runExclusive(String(tradeId), async () => {
      const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
      if (!trade) return { success: false, message: `Trade #${tradeId} tidak ditemukan` };
      if (!['OPEN', 'CLOSING'].includes(trade.status)) {
        return { success: false, message: `Trade #${tradeId} sudah ${trade.status}` };
      }

      const ticker = await this.indodax.getTicker(trade.pair);
      const ok = await this.executeClose(trade, ticker.last, reason, detail, reason === 'STOP_LOSS');
      return ok
        ? { success: true, message: `Trade #${tradeId} ditutup pada ${fmtPrice(ticker.last)}` }
        : { success: false, message: `Gagal menutup trade #${tradeId}` };
    });
  }

  /**
   * Kirim order jual dan finalisasi trade.
   *
   * Bila order gagal, posisi TIDAK dibiarkan diam-diam terbuka seperti versi
   * lama: kegagalan dicatat, dihitung, dan dieskalasi ke operator. Stop loss
   * yang gagal tanpa pemberitahuan adalah skenario terburuk pada bot trading.
   */
  private async executeClose(
    trade: Trade,
    currentPrice: number,
    reason: string,
    detail: string,
    urgent: boolean,
  ): Promise<boolean> {
    const quantity = trade.remainingQuantity || trade.quantity;

    await this.tradeRepo.update(trade.id, { status: 'CLOSING' });

    // Stop loss selalu taker (urgent). Take profit boleh pasif: tidak ada
    // urgensi, dan fee-nya separuh.
    const useMaker = !urgent && this.config.params().makerTakeProfit && reason === 'TAKE_PROFIT';

    const outcome = await this.execution.execute({
      pair: trade.pair,
      side: 'sell',
      amount: quantity,
      referencePrice: currentPrice,
      urgent,
      style: useMaker ? 'MAKER' : 'TAKER',
    });

    if (!outcome.success || outcome.filledCoin <= 0) {
      const attempts = (trade.closeAttempts || 0) + 1;
      const exhausted = attempts >= MAX_CLOSE_ATTEMPTS;

      await this.tradeRepo.update(trade.id, {
        status: exhausted ? 'FAILED' : 'OPEN',
        closeAttempts: attempts,
        lastError: outcome.error ?? 'Order jual tidak terisi',
      });

      this.logger.error(
        `❗ Gagal menutup #${trade.id} ${trade.pair.toUpperCase()} (percobaan ${attempts}/${MAX_CLOSE_ATTEMPTS}): ${outcome.error}`,
      );

      await this.audit.log({
        category: 'ORDER',
        event: 'CLOSE_FAILED',
        pair: trade.pair,
        tradeId: trade.id,
        message: outcome.error,
        data: { attempts, reason, quantity },
        isError: true,
      });

      await this.notification.sendAlert(
        exhausted
          ? `🚨 GAGAL MENUTUP POSISI\n\n#${trade.id} ${trade.pair.toUpperCase()}\n` +
              `Alasan tutup: ${reason}\nError: ${outcome.error}\n\n` +
              `Sudah ${attempts} kali gagal — bot berhenti mencoba. ` +
              `Posisi ditandai FAILED dan perlu ditangani manual di Indodax.`
          : `⚠️ Order jual #${trade.id} ${trade.pair.toUpperCase()} gagal ` +
              `(percobaan ${attempts}/${MAX_CLOSE_ATTEMPTS}): ${outcome.error}`,
      );

      return false;
    }

    // Order jual sebagian: sisanya tetap terbuka dan akan dicoba lagi.
    if (outcome.partial && outcome.filledCoin < quantity * 0.99) {
      const remaining = quantity - outcome.filledCoin;
      const partialPnl = this.risk.calculatePnL(trade, outcome.avgPrice, outcome.filledCoin);

      await this.tradeRepo.update(trade.id, {
        status: 'OPEN',
        remainingQuantity: remaining,
        realizedPnl: (trade.realizedPnl || 0) + partialPnl.profitLoss,
        exitFee: (trade.exitFee || 0) + outcome.feeIdr,
        lastError: `Jual sebagian: ${outcome.filledCoin}/${quantity}`,
      });

      this.portfolio.adjustSimulatedCash(outcome.filledIdr - outcome.feeIdr);

      this.logger.warn(
        `⚠️ #${trade.id} ${trade.pair.toUpperCase()} hanya terjual sebagian: ` +
          `${outcome.filledCoin.toFixed(8)}/${quantity.toFixed(8)}, sisa akan dicoba lagi`,
      );

      await this.notification.sendAlert(
        `⚠️ Posisi #${trade.id} ${trade.pair.toUpperCase()} baru terjual sebagian ` +
          `(${((outcome.filledCoin / quantity) * 100).toFixed(0)}%). Sisa akan dicoba pada siklus berikutnya.`,
      );
      return false;
    }

    // ── Finalisasi ───────────────────────────────────────────────────────
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
      closeReason: reason,
      closedAt: new Date(),
      lastError: null,
    });

    this.portfolio.adjustSimulatedCash(outcome.filledIdr - outcome.feeIdr);

    const win = totalPnl > 0;
    this.logger.log(
      `${win ? '✅' : '❌'} TUTUP #${trade.id} ${trade.pair.toUpperCase()} | ${reason} | ` +
        `${fmtPrice(trade.entryPrice)} → ${fmtPrice(outcome.avgPrice)} | ` +
        `P&L ${idr(totalPnl)} (${(trade.totalValue > 0 ? (totalPnl / trade.totalValue) * 100 : 0).toFixed(2)}%, ` +
        `${totalRisk > 0 ? (totalPnl / totalRisk).toFixed(2) : '0'}R) | ` +
        `Fee ${idr((trade.entryFee || 0) + (trade.exitFee || 0) + outcome.feeIdr)}`,
    );

    await this.audit.log({
      category: 'ORDER',
      event: 'POSITION_CLOSED',
      pair: trade.pair,
      tradeId: trade.id,
      message: `${reason}: ${detail}`,
      data: {
        entryPrice: trade.entryPrice,
        exitPrice: outcome.avgPrice,
        profitLoss: totalPnl,
        rMultiple: totalRisk > 0 ? totalPnl / totalRisk : 0,
        fees: (trade.entryFee || 0) + (trade.exitFee || 0) + outcome.feeIdr,
      },
    });

    const sellChart = await this.charts.build(trade.pair, {
      trade: { entry: trade.entryPrice, stopLoss: trade.stopLossPrice, takeProfit: trade.takeProfitPrice },
      subtitle: `Ditutup: ${reason}`,
    });

    await this.notification.sendTradeAlert({
      type: 'SELL',
      tradeId: trade.id,
      pair: trade.pair,
      price: outcome.avgPrice,
      amount: outcome.filledIdr,
      quantity: outcome.filledCoin,
      entryPrice: trade.entryPrice,
      profitLoss: totalPnl,
      profitLossPercent: trade.totalValue > 0 ? (totalPnl / trade.totalValue) * 100 : 0,
      rMultiple: totalRisk > 0 ? totalPnl / totalRisk : 0,
      fee: (trade.entryFee || 0) + (trade.exitFee || 0) + outcome.feeIdr,
      reasons: [reason, detail].filter(Boolean),
      strategy: trade.strategy,
      mode: trade.mode,
    }, sellChart);

    return true;
  }

  /**
   * Buka posisi atas perintah operator, bukan atas sinyal otomatis.
   *
   * Tetap melewati risk engine dan eksekusi yang SAMA dengan jalur otomatis.
   * Stop loss dan target juga diambil dari strategi aktif, bukan dihitung
   * terpisah — jalur manual yang memakai perhitungannya sendiri akan
   * menghasilkan posisi dengan aturan berbeda dari yang diuji backtest.
   */
  async openManualPosition(
    pair: string,
    reason = 'MANUAL',
    /**
     * Harga acuan dari pemanggil, bila ada.
     *
     * Tanpa ini jalur manual memakai `candles[last].close` — penutupan bar
     * TERTUTUP terakhir, yang pada timeframe 60 menit bisa berumur hampir
     * satu jam. Operator menekan CONFIRM setelah melihat harga HIDUP, jadi
     * memesan berdasarkan harga sejam lalu membuat ukuran posisi, stop, dan
     * target meleset dari yang ditampilkan.
     */
    executionPrice?: number,
  ): Promise<{
    success: boolean;
    message: string;
    /**
     * True bila limit maker hanya tidak tersentuh harga.
     *
     * Dibedakan dari kegagalan karena konsekuensinya berbeda: tidak ada uang
     * terpakai, ordernya sudah dibatalkan, dan tidak ada yang perlu diperiksa.
     * Menampilkannya dengan tanda gagal membuat operator mencari kerusakan
     * yang tidak ada.
     */
    missed?: boolean;
  }> {
    const params = this.config.params();
    const strategy = this.strategies.active();

    const tradable = this.pairs.isTradable(pair);
    if (!tradable.ok) return { success: false, message: tradable.reason! };

    const [candles, htfCandles] = await Promise.all([
      this.indodax.getCandles(pair, params.candleTimeframe, params.candleLimit),
      params.requireHtfTrend
        ? this.indodax.getCandles(pair, params.htfTimeframe, 120).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (candles.length < strategy.minCandles) {
      return { success: false, message: `Data candle ${pair} tidak cukup` };
    }

    const existing = await this.tradeRepo.findOne({
      where: { pair, status: In(['OPEN', 'PENDING', 'CLOSING']) },
    });
    if (existing) return { success: false, message: `Sudah ada posisi terbuka #${existing.id}` };

    const signal = strategy.evaluate({
      pair,
      candles,
      htfCandles,
      orderBook: undefined,
      volumeIdr24h: undefined,
      params,
      hasOpenPosition: false,
    });

    const price =
      executionPrice && executionPrice > 0
        ? executionPrice
        : candles[candles.length - 1].close;

    /**
     * Zona entry sengaja DILEPAS pada jalur manual: operator menekan tombol
     * setelah melihat harga saat ini, jadi menolaknya karena "harga sudah di
     * atas zona yang dihitung dari candle terakhir" akan membingungkan dan
     * membatalkan keputusan yang memang disengaja.
     */
    const manualSignal = {
      ...signal,
      action: 'BUY' as const,
      suggestedEntryLow: undefined,
      suggestedEntryHigh: undefined,
      reasons: [`Dibuka manual (${reason})`, ...signal.reasons.slice(0, 3)],
    };

    this.lastEntryFailure.delete(pair.toLowerCase());
    const opened = await this.openPosition(pair, price, manualSignal, strategy.name);

    if (opened) {
      return { success: true, message: `Posisi ${pair.toUpperCase()} dibuka @ ${fmtPrice(price)}` };
    }

    const failure = this.lastEntryFailure.get(pair.toLowerCase());

    // Order maker yang tidak terisi BUKAN kegagalan: tidak ada uang terpakai,
    // ordernya sudah dibatalkan, dan peluangnya hanya lewat. Melaporkannya
    // dengan tanda ❌ dan "periksa log" membuat operator mencari kerusakan
    // yang tidak ada.
    if (failure?.missed) {
      const timeout = this.config.params().makerFillTimeoutSeconds;
      return {
        success: false,
        missed: true,
        message: [
          `${pair.toUpperCase()} — limit maker tidak terisi dalam ${timeout} detik.`,
          '',
          'Tidak ada uang terpakai; ordernya sudah dibatalkan otomatis.',
          'Harga tidak turun ke level limit, jadi peluangnya lewat.',
          '',
          '_Setel MAKER_ENTRY=false bila ingin langsung dieksekusi di harga_',
          '_pasar dengan fee taker 0,2% (dua kali fee maker)._',
        ].join('\n'),
      };
    }

    return {
      success: false,
      message: failure?.reason
        ? `${pair.toUpperCase()} ditolak: ${failure.reason}`
        : 'Order tidak tereksekusi — periksa log',
    };
  }

  /** Tutup manual dari dashboard atau perintah Telegram. */
  async manualCloseTrade(tradeId: number): Promise<{ success: boolean; message: string }> {
    return this.closeTrade(tradeId, 'MANUAL_CLOSE', 'Ditutup manual oleh operator');
  }

  /** Tutup seluruh posisi — tombol darurat. */
  async closeAllPositions(reason = 'PANIC_CLOSE'): Promise<{ closed: number; failed: number }> {
    const open = await this.tradeRepo.find({ where: { status: In(['OPEN', 'CLOSING']) } });
    let closed = 0;
    let failed = 0;

    for (const t of open) {
      const res = await this.closeTrade(t.id, reason, 'Penutupan massal');
      if (res.success) closed++;
      else failed++;
    }

    await this.audit.log({
      category: 'SYSTEM',
      event: 'CLOSE_ALL',
      message: `${closed} ditutup, ${failed} gagal`,
      data: { reason },
    });
    return { closed, failed };
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  async getOpenTrades(): Promise<Trade[]> {
    return this.tradeRepo.find({
      where: { status: In(['OPEN', 'PENDING', 'CLOSING']) },
      order: { createdAt: 'DESC' },
    });
  }

  async getFailedTrades(): Promise<Trade[]> {
    return this.tradeRepo.find({ where: { status: 'FAILED' }, order: { updatedAt: 'DESC' } });
  }

  async getTradeHistory(limit = 50): Promise<Trade[]> {
    return this.tradeRepo.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  /**
   * Ringkasan filter mana yang paling sering menahan entry.
   *
   * Bot yang tidak pernah membuka posisi punya dua kemungkinan penyebab yang
   * dari log tampak identik: memang tidak ada peluang, atau filternya terlalu
   * ketat sehingga melewatkan peluang yang sebenarnya layak. Log per-siklus
   * tidak bisa membedakannya — hanya agregat selama beberapa hari yang bisa.
   *
   * Cara membacanya: bila satu filter menahan >80% sinyal selama berhari-hari
   * sementara filter lain hampir tidak pernah aktif, filter itulah yang
   * mengikat. Longgarkan HANYA setelah backtest membuktikan pelonggarannya
   * menaikkan ekspektasi — jangan karena bosan menunggu.
   */
  async getBlockerStats(hours = 168): Promise<{
    periodHours: number;
    totalSignals: number;
    buySignals: number;
    executedSignals: number;
    /** Sinyal yang lolos semua filter tapi tetap tidak dieksekusi (ditolak risk engine). */
    passedFiltersNotExecuted: number;
    blockers: Array<{ reason: string; count: number; percentOfSignals: number }>;
    byPair: Record<string, { signals: number; blocked: number; strongest: number }>;
    /** Sinyal terkuat yang tertahan — kandidat paling menyakitkan untuk dilewatkan. */
    nearMisses: Array<{ pair: string; strength: number; blockedBy: string; at: Date }>;
  }> {
    const since = new Date(Date.now() - hours * 3600_000);
    const signals = await this.signalRepo
      .createQueryBuilder('s')
      .where('s.createdAt >= :since', { since })
      .orderBy('s.createdAt', 'DESC')
      .getMany();

    if (!signals.length) {
      return {
        periodHours: hours,
        totalSignals: 0,
        buySignals: 0,
        executedSignals: 0,
        passedFiltersNotExecuted: 0,
        blockers: [],
        byPair: {},
        nearMisses: [],
      };
    }

    // Satu sinyal bisa ditahan beberapa filter sekaligus; semuanya dihitung.
    const counts = new Map<string, number>();
    const byPair: Record<string, { signals: number; blocked: number; strongest: number }> = {};

    for (const s of signals) {
      const pair = s.pair;
      byPair[pair] ??= { signals: 0, blocked: 0, strongest: 0 };
      byPair[pair].signals++;
      byPair[pair].strongest = Math.max(byPair[pair].strongest, s.strength);

      if (!s.blockedBy) continue;
      byPair[pair].blocked++;

      for (const raw of s.blockedBy.split(' | ')) {
        // Buang angka spesifik agar "ADX 15.5 < 20" dan "ADX 18.2 < 20"
        // terhitung sebagai satu jenis penghalang.
        const key = raw
          .replace(/-?\d+([.,]\d+)?%?/g, 'N')
          .replace(/\s+/g, ' ')
          .trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const blockers = [...counts.entries()]
      .map(([reason, count]) => ({
        reason,
        count,
        percentOfSignals: Number(((count / signals.length) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);

    const nearMisses = signals
      .filter((s) => s.blockedBy && s.strength >= 50)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10)
      .map((s) => ({
        pair: s.pair,
        strength: s.strength,
        blockedBy: s.blockedBy,
        at: s.createdAt,
      }));

    const buySignals = signals.filter((s) => s.action === 'BUY').length;

    return {
      periodHours: hours,
      totalSignals: signals.length,
      buySignals,
      executedSignals: signals.filter((s) => s.executed === 1).length,
      passedFiltersNotExecuted: signals.filter((s) => !s.blockedBy && s.executed !== 1).length,
      blockers,
      byPair,
      nearMisses,
    };
  }

  async getRecentSignals(limit = 50): Promise<Signal[]> {
    return this.signalRepo.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  /**
   * Ringkasan performa. Profit factor dihitung dari total profit dibagi total
   * kerugian (definisi baku) — versi lama membaginya dari rata-rata persentase,
   * yang bukan profit factor dan menyesatkan saat ukuran posisi bervariasi.
   */
  async getPerformanceSummary(strategy?: string): Promise<any> {
    const where: any = { status: 'CLOSED', mode: this.config.mode };
    if (strategy) where.strategy = strategy;

    const trades = await this.tradeRepo.find({ where });
    if (!trades.length) {
      return {
        strategy: strategy ?? 'ALL',
        totalTrades: 0,
        message: 'Belum ada trade yang selesai',
      };
    }

    const wins = trades.filter((t) => (t.profitLoss ?? 0) > 0);
    const losses = trades.filter((t) => (t.profitLoss ?? 0) <= 0);

    const grossProfit = wins.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.profitLoss || 0), 0));
    const totalPnL = grossProfit - grossLoss;
    const totalFees = trades.reduce((s, t) => s + (t.entryFee || 0) + (t.exitFee || 0), 0);

    const rMultiples = trades.map((t) => t.rMultiple || 0);
    const expectancyR = rMultiples.reduce((a, b) => a + b, 0) / trades.length;

    const holdingHours = trades
      .filter((t) => t.openedAt && t.closedAt)
      .map((t) => (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 3600_000);

    const byReason: Record<string, number> = {};
    for (const t of trades) byReason[t.closeReason || 'UNKNOWN'] = (byReason[t.closeReason || 'UNKNOWN'] || 0) + 1;

    return {
      strategy: strategy ?? 'ALL',
      mode: this.config.mode,
      totalTrades: trades.length,
      winTrades: wins.length,
      lossTrades: losses.length,
      winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
      totalPnL: Math.round(totalPnL),
      grossProfit: Math.round(grossProfit),
      grossLoss: Math.round(grossLoss),
      totalFees: Math.round(totalFees),
      /** Fee sebagai porsi dari profit kotor — mengukur beban biaya strategi. */
      feeDragPercent: grossProfit > 0 ? Number(((totalFees / grossProfit) * 100).toFixed(1)) : null,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
      expectancyR: Number(expectancyR.toFixed(3)),
      avgWin: wins.length ? Math.round(grossProfit / wins.length) : 0,
      avgLoss: losses.length ? Math.round(grossLoss / losses.length) : 0,
      bestTrade: Math.round(Math.max(...trades.map((t) => t.profitLoss || 0))),
      worstTrade: Math.round(Math.min(...trades.map((t) => t.profitLoss || 0))),
      avgHoldingHours: holdingHours.length
        ? Number((holdingHours.reduce((a, b) => a + b, 0) / holdingHours.length).toFixed(1))
        : 0,
      closeReasons: byReason,
    };
  }

  /**
   * Performa dipecah menurut regime pasar, bucket skor, dan timeframe
   * (bagian 16 spesifikasi).
   *
   * Seluruhnya dihitung dari trade NYATA yang sudah ditutup - bukan dari
   * backtest. Selama jumlah trade masih sedikit, angka di sini tidak boleh
   * dipakai untuk mengubah parameter; itulah sebabnya tiap irisan menyertakan
   * jumlah sampelnya sendiri.
   */
  async getPerformanceBreakdown(strategy?: string): Promise<{
    mode: string;
    strategy: string;
    totalClosedTrades: number;
    byRegime: PerformanceBreakdownSlice[];
    byScoreBucket: PerformanceBreakdownSlice[];
    byStrategy: PerformanceBreakdownSlice[];
    caveat: string;
  }> {
    const where: any = { status: 'CLOSED', mode: this.config.mode };
    if (strategy) where.strategy = strategy;

    const trades = await this.tradeRepo.find({ where });

    const slice = (label: string, subset: Trade[]): PerformanceBreakdownSlice => {
      const wins = subset.filter((t) => (t.profitLoss ?? 0) > 0);
      const grossProfit = wins.reduce((s, t) => s + (t.profitLoss || 0), 0);
      const grossLoss = Math.abs(
        subset.filter((t) => (t.profitLoss ?? 0) <= 0).reduce((s, t) => s + (t.profitLoss || 0), 0),
      );
      const rs = subset.map((t) => t.rMultiple || 0);
      const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;

      // Simpangan baku populasi; dipakai menghitung galat baku ekspektasi.
      const variance = rs.length > 1
        ? rs.reduce((s, r) => s + (r - avgR) ** 2, 0) / rs.length
        : 0;

      return {
        label,
        trades: subset.length,
        winRate: subset.length ? Number(((wins.length / subset.length) * 100).toFixed(1)) : 0,
        expectancyR: Number(avgR.toFixed(3)),
        expectancyStdErrorR:
          rs.length > 1 ? Number((Math.sqrt(variance) / Math.sqrt(rs.length)).toFixed(3)) : 0,
        netPnl: Math.round(grossProfit - grossLoss),
        profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
        maxDrawdownIdr: Math.round(worstRun(subset)),
      };
    };

    const regimes = [...new Set(trades.map((t) => t.marketRegime).filter(Boolean))] as string[];
    const buckets: Array<[string, number, number]> = [
      ['0-49', 0, 49],
      ['50-64', 50, 64],
      ['65-69', 65, 69],
      ['70-79', 70, 79],
      ['80-89', 80, 89],
      ['90-100', 90, 100],
    ];
    const scored = trades.filter((t) => t.intelligenceScore !== null && t.intelligenceScore !== undefined);
    const strategies = [...new Set(trades.map((t) => t.strategy))];

    return {
      mode: this.config.mode,
      strategy: strategy ?? 'ALL',
      totalClosedTrades: trades.length,
      byRegime: regimes
        .map((r) => slice(r, trades.filter((t) => t.marketRegime === r)))
        .sort((a, b) => b.trades - a.trades),
      byScoreBucket: buckets
        .map(([label, min, max]) =>
          slice(label, scored.filter((t) => t.intelligenceScore! >= min && t.intelligenceScore! <= max)),
        )
        .filter((s) => s.trades > 0),
      byStrategy: strategies
        .map((name) => slice(name, trades.filter((t) => t.strategy === name)))
        .sort((a, b) => b.trades - a.trades),
      caveat:
        'Irisan dengan kurang dari 30 trade tidak cukup untuk menyimpulkan apa pun. ' +
        'Bandingkan expectancyR terhadap expectancyStdErrorR-nya sebelum mengambil kesimpulan: ' +
        'selisih yang lebih kecil daripada galat bakunya adalah kebisingan, bukan pola.',
    };
  }

  /** Bandingkan performa antar strategi dari data trade nyata. */
  async getStrategyComparison(): Promise<any[]> {
    const names = this.strategies.all().map((s) => s.name);
    const results = await Promise.all(names.map((n) => this.getPerformanceSummary(n)));
    return results.filter((r) => r.totalTrades > 0);
  }
}

/**
 * Identitas unik sebuah sinyal: pair + strategi + waktu candle.
 *
 * Dipakai sebagai kunci idempotensi. Selama candle belum berganti, sinyal yang
 * sama tidak akan pernah menghasilkan order kedua - retry, timeout, restart,
 * maupun perintah manual sekalipun.
 */
export function buildSignalRef(pair: string, strategy: string, barTime?: number): string {
  // Tanpa waktu candle (mis. pemanggilan manual) dipakai jendela satu menit,
  // cukup untuk menahan retry beruntun tanpa memblokir entry yang sah besok.
  const stamp = barTime ?? Math.floor(Date.now() / 60000) * 60;
  return `${pair.toLowerCase()}:${strategy}:${stamp}`;
}
