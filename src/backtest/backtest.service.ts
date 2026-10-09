import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Candle } from '../indodax/indodax.types';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { TechnicalService } from '../indicators/technical.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { StrategyContext } from '../strategy/strategy.interface';
import { BotConfigService, BotParams } from '../config/bot-config.service';
import { BacktestResult } from '../database/entities/backtest-result.entity';
import { mean, stdev, clamp } from '../common/num';
import { normalizeTakeProfitLevels } from '../common/take-profit';
import {
  BacktestConfig,
  BacktestMetrics,
  BacktestReport,
  BacktestTrade,
  EquityPoint,
} from './backtest.types';
import { sliceByRegime, sliceByScore } from './performance-slice';
import { MarketIntelligenceService } from '../market-intelligence/market-intelligence.service';
import { MarketIntelligenceConfigService } from '../market-intelligence/mi-config.service';
import { StrategyGateService } from '../market-intelligence/strategy-gate.service';
import { CandleSet } from '../market-intelligence/mtf/mtf.types';
import { aggregateCandles } from '../market-intelligence/mtf/candle-aggregator';
import { Timeframe, TIMEFRAMES, TIMEFRAME_MINUTES } from '../market-intelligence/market-intelligence.types';
import { TradingStrategy } from '../strategy/strategy.interface';

interface OpenPosition {
  pair: string;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  positionValue: number;
  entryFee: number;
  stopLoss: number;
  takeProfit: number;
  initialRiskPerUnit: number;
  breakEvenMoved: boolean;
  tpFilled: number;
  /** Kuantitas saat entry; dasar menghitung porsi tiap tingkat TP. */
  originalQuantity: number;
  realizedPnl: number;
  highestPrice: number;
  lowestPrice: number;
  reasons: string[];
  intelligenceScore: number | null;
  marketRegime: string | null;
  intelligenceDecision: string | null;
}

/**
 * Mesin backtest.
 *
 * Menjalankan ulang strategi dan aturan risiko yang sama persis dengan mode
 * live, bar demi bar, sambil membebankan fee dan slippage yang realistis.
 * Tanpa ini tidak ada dasar apa pun untuk mempercayai strategi — dan hasil
 * paper trading yang mengabaikan biaya selalu terlihat lebih baik dari kenyataan.
 *
 * Batasan yang disengaja dan dinyatakan terbuka:
 *  - Eksekusi diasumsikan terjadi pada harga open bar berikutnya, bukan pada
 *    harga close bar sinyal. Mengeksekusi di bar yang sama akan menghasilkan
 *    look-ahead bias.
 *  - Stop loss diperiksa terhadap harga low bar; bila gap melewatinya, eksekusi
 *    memakai harga open (memodelkan slippage gap).
 *  - Order book historis tidak tersedia, sehingga filter berbasis order book
 *    tidak aktif saat backtest. Hasil live bisa sedikit berbeda karenanya.
 */
@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  /**
   * Cache candle per (pair, timeframe, bars).
   *
   * Parameter sweep menjalankan puluhan backtest pada rentang data yang sama.
   * Tanpa cache, tiap kombinasi mengambil ulang seluruh candle dari Indodax —
   * ratusan panggilan API yang identik, lambat dan memboroskan rate limit.
   */
  private candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  /**
   * Ambil candle lewat cache, lalu potong jendela yang diminta.
   *
   * `offsetFromEnd` membuang sejumlah candle terbaru sehingga jendela waktu di
   * tengah riwayat bisa diuji — syarat mutlak agar walk-forward benar-benar
   * menguji periode yang berbeda-beda.
   */
  private async loadCandles(
    pair: string,
    timeframe: number,
    bars: number,
    offsetFromEnd = 0,
  ): Promise<Candle[]> {
    const total = bars + offsetFromEnd;
    const key = `${pair}|${timeframe}|${total}`;

    let full: Candle[];
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < BacktestService.CACHE_TTL_MS) {
      full = hit.candles;
    } else {
      full = await this.indodax.getCandles(pair, timeframe, total);
      this.candleCache.set(key, { at: Date.now(), candles: full });
    }

    if (offsetFromEnd <= 0) return full;
    // Buang candle terbaru sebanyak offset, lalu ambil `bars` terakhir dari sisanya.
    return full.slice(0, Math.max(0, full.length - offsetFromEnd)).slice(-bars);
  }

  /** Kosongkan cache — dipakai bila ingin memaksa data terbaru. */
  clearCache(): void {
    this.candleCache.clear();
    this.miCache.clear();
  }

  constructor(
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly technical: TechnicalService,
    private readonly strategies: StrategyRegistry,
    private readonly config: BotConfigService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly intelligenceConfig: MarketIntelligenceConfigService,
    private readonly intelligenceGate: StrategyGateService,
    @InjectRepository(BacktestResult)
    private readonly resultRepo: Repository<BacktestResult>,
  ) {}

  /**
   * Cache hasil Market Intelligence per (pair, bar, parameter).
   *
   * Satu sweep menjalankan puluhan backtest pada data yang sama; tanpa cache,
   * analisis multi-timeframe dihitung ulang untuk setiap kombinasi parameter
   * meski hasilnya identik.
   */
  private miCache = new Map<string, { allowed: boolean; score: number; regime: string; decision: string; rejections?: string[] }>();

  /**
   * Statistik Market Intelligence untuk satu kali jalan backtest.
   * Direset di awal `simulate()` agar tidak bocor antar kombinasi sweep.
   */
  private miStats = {
    enabled: false,
    accepted: 0,
    rejected: 0,
    scores: [] as number[],
    rejections: new Map<string, number>(),
  };

  // ─── Entry point ──────────────────────────────────────────────────────────

  async run(cfg: BacktestConfig, persist = true): Promise<BacktestReport> {
    const started = Date.now();
    const strategy = this.strategies.get(cfg.strategy);
    if (!strategy) {
      throw new Error(
        `Strategi '${cfg.strategy}' tidak dikenal. Pilihan: ${this.strategies.all().map((s) => s.name).join(', ')}`,
      );
    }

    const params: BotParams = { ...this.config.params(), ...(cfg.paramOverrides ?? {}) };
    const warnings: string[] = [];

    /**
     * Bila pemanggil tidak menyatakan pilihan, backtest MENIRU konfigurasi live.
     *
     * Ini disengaja: backtest yang memakai aturan berbeda dari bot yang
     * sesungguhnya berjalan hanya menghasilkan angka yang tidak berlaku untuk
     * apa pun. Jalankan dua kali dengan `useIntelligence` true dan false bila
     * ingin mengukur kontribusi lapisan ini.
     */
    const mi = this.intelligenceConfig.params();
    if (cfg.useIntelligence === undefined) {
      cfg = { ...cfg, useIntelligence: mi.enabled && mi.enforce };
    }
    if (cfg.useIntelligence) {
      warnings.push(
        'Market Intelligence aktif dalam backtest ini. Timeframe besar dibentuk dengan ' +
          'mengagregasi candle timeframe utama, sehingga cakupannya bisa lebih pendek ' +
          'daripada mode live yang mengambil tiap timeframe langsung dari exchange.',
      );
    }

    // ── Ambil data ──────────────────────────────────────────────────────
    const candlesByPair = new Map<string, Candle[]>();
    const htfByPair = new Map<string, Candle[]>();

    for (const pair of cfg.pairs) {
      const offset = cfg.barsOffsetFromEnd ?? 0;
      const candles = await this.loadCandles(pair, cfg.timeframe, cfg.bars, offset);
      if (candles.length < strategy.minCandles + 20) {
        warnings.push(
          `${pair.toUpperCase()} dilewati: hanya ${candles.length} candle tersedia ` +
            `(butuh minimal ${strategy.minCandles + 20})`,
        );
        continue;
      }
      candlesByPair.set(pair, candles);

      if (params.requireHtfTrend) {
        const htfBars = Math.ceil((cfg.bars * cfg.timeframe) / params.htfTimeframe) + 60;
        // Offset HTF diskalakan agar menunjuk periode kalender yang sama.
        const htfOffset = Math.floor((offset * cfg.timeframe) / params.htfTimeframe);
        const htf = await this.loadCandles(
          pair,
          params.htfTimeframe,
          Math.min(htfBars, 1000),
          htfOffset,
        ).catch(() => [] as Candle[]);
        htfByPair.set(pair, htf);
        if (htf.length < 55) {
          warnings.push(
            `Data HTF ${pair.toUpperCase()} tidak cukup (${htf.length} candle) — filter tren HTF nonaktif untuk pair ini`,
          );
        }
      }
    }

    if (!candlesByPair.size) {
      throw new Error('Tidak ada pair dengan data candle yang memadai');
    }

    // ── Simulasi ────────────────────────────────────────────────────────
    const { trades, equityCurve, barsTested, periodStart, periodEnd } = this.simulate(
      cfg,
      params,
      strategy,
      candlesByPair,
      htfByPair,
    );

    const metrics = this.computeMetrics(cfg, trades, equityCurve, barsTested, cfg.timeframe);

    // ── Peringatan kualitas hasil ───────────────────────────────────────
    if (metrics.totalTrades < 30) {
      warnings.push(
        `Hanya ${metrics.totalTrades} trade — terlalu sedikit untuk kesimpulan statistik. ` +
          `Idealnya minimal 100 trade sebelum mempercayai angka win rate atau profit factor.`,
      );
    }
    if (metrics.maxDrawdownPercent > 25) {
      warnings.push(
        `Drawdown maksimum ${metrics.maxDrawdownPercent.toFixed(1)}% sangat besar — ` +
          `pertimbangkan menurunkan risiko per trade.`,
      );
    }
    if (metrics.feeDragPercent !== null && metrics.feeDragPercent > 40) {
      warnings.push(
        `Fee memakan ${metrics.feeDragPercent.toFixed(0)}% dari profit kotor — ` +
          `strategi terlalu sering trading untuk ukuran keuntungannya.`,
      );
    }
    warnings.push(
      'Filter order book tidak aktif saat backtest (tidak ada data historis kedalaman pasar).',
    );

    const report: BacktestReport = {
      config: cfg,
      params,
      periodStart,
      periodEnd,
      barsTested,
      metrics,
      trades,
      equityCurve,
      warnings,
    };

    this.logger.log(
      `Backtest ${cfg.strategy} selesai dalam ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
        `${metrics.totalTrades} trade, return ${metrics.totalReturnPercent.toFixed(2)}%, ` +
        `DD maks ${metrics.maxDrawdownPercent.toFixed(2)}%, PF ${metrics.profitFactor ?? 'n/a'}`,
    );

    if (persist) await this.persist(report);
    return report;
  }

  // ─── Loop simulasi ────────────────────────────────────────────────────────

  private simulate(
    cfg: BacktestConfig,
    params: BotParams,
    strategy: ReturnType<StrategyRegistry['get']>,
    candlesByPair: Map<string, Candle[]>,
    htfByPair: Map<string, Candle[]>,
  ): {
    trades: BacktestTrade[];
    equityCurve: EquityPoint[];
    barsTested: number;
    periodStart: string;
    periodEnd: string;
  } {
    // Statistik Market Intelligence direset per jalan agar tidak bocor antar
    // kombinasi saat parameter sweep menjalankan puluhan backtest berurutan.
    this.miStats = {
      enabled: false,
      accepted: 0,
      rejected: 0,
      scores: [],
      rejections: new Map(),
    };

    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    const openPositions = new Map<string, OpenPosition>();
    /** Waktu selesai cooldown per pair (epoch detik). */
    const cooldownUntil = new Map<string, number>();
    let consecutiveLosses = 0;

    let cash = cfg.initialCapital;
    let peakEquity = cfg.initialCapital;

    // Sumbu waktu gabungan dari seluruh pair agar posisi lintas pair sinkron.
    const timeline = [...new Set([...candlesByPair.values()].flatMap((cs) => cs.map((c) => c.time)))].sort(
      (a, b) => a - b,
    );

    const startIndex = strategy!.minCandles;
    const barsTested = Math.max(0, timeline.length - startIndex);

    // Indeks pencarian per pair agar tidak melakukan scan ulang tiap bar.
    const indexByPair = new Map<string, Map<number, number>>();
    for (const [pair, candles] of candlesByPair) {
      indexByPair.set(pair, new Map(candles.map((c, i) => [c.time, i])));
    }

    for (let t = startIndex; t < timeline.length; t++) {
      const now = timeline[t];

      // ── 1. Kelola posisi terbuka ──────────────────────────────────────
      for (const [pair, pos] of [...openPositions]) {
        const candles = candlesByPair.get(pair)!;
        const idx = indexByPair.get(pair)!.get(now);
        if (idx === undefined) continue;

        const bar = candles[idx];
        pos.highestPrice = Math.max(pos.highestPrice, bar.high);
        pos.lowestPrice = Math.min(pos.lowestPrice, bar.low);

        const effectiveStop = pos.stopLoss;

        // Stop loss diperiksa lebih dulu — pada satu bar kita tidak tahu urutan
        // sesungguhnya antara low dan high, jadi asumsi paling konservatif dipakai.
        if (bar.low <= effectiveStop) {
          // Bila bar dibuka sudah di bawah stop (gap), eksekusi di harga open.
          const exitPrice = bar.open < effectiveStop ? bar.open : effectiveStop;
          const closed = this.closePosition(pos, exitPrice, now, idx, cfg, 'STOP_LOSS');
          cash += closed.proceeds;
          trades.push(closed.trade);
          openPositions.delete(pair);
          consecutiveLosses = closed.trade.profitLoss < 0 ? consecutiveLosses + 1 : 0;
          if (closed.trade.profitLoss < 0) {
            cooldownUntil.set(pair, now + params.cooldownMinutesAfterLoss * 60);
          }
          continue;
        }

        if (bar.high >= pos.takeProfit) {
          const exitPrice = bar.open > pos.takeProfit ? bar.open : pos.takeProfit;
          const closed = this.closePosition(pos, exitPrice, now, idx, cfg, 'TAKE_PROFIT');
          cash += closed.proceeds;
          trades.push(closed.trade);
          openPositions.delete(pair);
          consecutiveLosses = 0;
          continue;
        }

        // Batas waktu menahan posisi.
        const holdingBars = idx - pos.entryBar;
        const maxBars = Math.ceil((params.maxHoldingHours * 60) / cfg.timeframe);
        if (params.maxHoldingHours > 0 && holdingBars >= maxBars) {
          const closed = this.closePosition(pos, bar.close, now, idx, cfg, 'MAX_HOLDING_TIME');
          cash += closed.proceeds;
          trades.push(closed.trade);
          openPositions.delete(pair);
          consecutiveLosses = closed.trade.profitLoss < 0 ? consecutiveLosses + 1 : 0;
          continue;
        }

        // Take profit bertingkat. Diperiksa berurutan: melewatkan satu
        // tingkat lalu menjual porsi tingkat berikutnya akan menyisakan porsi
        // yang tidak pernah terjual sampai posisi ditutup paksa.
        if (pos.initialRiskPerUnit > 0) {
          const levels = normalizeTakeProfitLevels(params.takeProfitLevels);
          const rNow = (bar.close - pos.entryPrice) / pos.initialRiskPerUnit;

          while (pos.tpFilled < levels.length && rNow >= levels[pos.tpFilled].atR) {
            const level = levels[pos.tpFilled];
            const sellQty = Math.min(pos.quantity, pos.originalQuantity * (level.closePercent / 100));
            if (sellQty <= 0) break;

            const exitPrice = bar.close * (1 - cfg.slippagePercent / 100);
            const feeRate = this.feeRate(pos.pair, cfg);
            const gross = sellQty * exitPrice;
            const fee = gross * feeRate;

            pos.realizedPnl += gross - fee - sellQty * pos.entryPrice;
            pos.quantity -= sellQty;
            pos.tpFilled++;
            cash += gross - fee;

            // Setelah tingkat pertama, sisa posisi dijalankan tanpa risiko.
            if (pos.tpFilled === 1) {
              pos.stopLoss = Math.max(pos.stopLoss, pos.entryPrice);
              pos.breakEvenMoved = true;
            }
          }

          // Seluruh tingkat terpenuhi dan posisi habis terjual.
          if (pos.quantity <= 0) {
            trades.push(
              this.closePosition(pos, bar.close, now, idx, cfg, 'TAKE_PROFIT').trade,
            );
            openPositions.delete(pair);
            consecutiveLosses = 0;
            continue;
          }
        }

        // Break-even dan trailing berbasis ATR.
        if (pos.initialRiskPerUnit > 0) {
          const rNow = (bar.close - pos.entryPrice) / pos.initialRiskPerUnit;
          const feeRate = this.feeRate(pos.pair, cfg);

          if (!pos.breakEvenMoved && rNow >= params.breakEvenAtR) {
            const bePrice = pos.entryPrice * (1 + feeRate * 2);
            if (bePrice > pos.stopLoss) {
              pos.stopLoss = bePrice;
              pos.breakEvenMoved = true;
            }
          }

          if (rNow >= params.breakEvenAtR) {
            const atr = this.technical.calculateATR(candles.slice(Math.max(0, idx - 30), idx + 1), 14);
            if (atr > 0) {
              const trail = bar.close - atr * params.trailingAtrMultiplier;
              if (trail > pos.stopLoss) pos.stopLoss = trail;
            }
          }
        }
      }

      // ── 2. Cari entry baru ────────────────────────────────────────────
      const killed = consecutiveLosses >= params.maxConsecutiveLosses;

      for (const [pair, candles] of candlesByPair) {
        if (openPositions.has(pair)) continue;
        if (openPositions.size >= params.maxConcurrentTrades) break;
        if (killed) break;

        const cooldown = cooldownUntil.get(pair);
        if (cooldown && now < cooldown) continue;

        // Batas korelasi.
        const group = this.config.correlationGroup(pair);
        if (group !== 'OTHER') {
          const sameGroup = [...openPositions.keys()].filter(
            (p) => this.config.correlationGroup(p) === group,
          ).length;
          if (sameGroup >= params.maxPositionsPerCorrelationGroup) continue;
        }

        const idx = indexByPair.get(pair)!.get(now);
        if (idx === undefined || idx < strategy!.minCandles) continue;
        // Butuh bar berikutnya untuk mengeksekusi tanpa look-ahead bias.
        if (idx + 1 >= candles.length) continue;

        const window = candles.slice(0, idx + 1);
        const htf = this.sliceHtf(htfByPair.get(pair) ?? [], now);

        const ctx: StrategyContext = {
          pair,
          candles: window,
          htfCandles: htf,
          orderBook: undefined, // tidak tersedia secara historis
          volumeIdr24h: undefined,
          params,
          hasOpenPosition: false,
        };

        const signal = strategy!.evaluate(ctx);
        if (signal.action !== 'BUY') continue;

        /**
         * Market Intelligence pada data historis.
         *
         * Dijalankan HANYA dari `window` - candle yang sudah tertutup sampai
         * bar ini. Timeframe yang lebih besar dibentuk dengan agregasi, dan
         * agregasi membuang bucket terakhir yang belum lengkap. Tidak ada satu
         * pun nilai dari bar sesudah `idx` yang bisa masuk ke perhitungan.
         */
        let miScore: number | null = null;
        let miRegime: string | null = null;
        let miDecision: string | null = null;

        if (cfg.useIntelligence) {
          const verdict = this.evaluateIntelligence(pair, window, htf, cfg, params, strategy!);
          if (verdict) {
            miScore = verdict.score;
            miRegime = verdict.regime;
            miDecision = verdict.decision;
            if (!verdict.allowed) continue;
          }
        }

        // ── Eksekusi pada bar BERIKUTNYA ────────────────────────────────
        const execBar = candles[idx + 1];
        const useMaker = cfg.makerEntry === true;

        let entryPrice: number;
        if (useMaker) {
          // Limit pasif dipasang di bawah harga pembukaan bar eksekusi.
          // Order HANYA terisi bila harga benar-benar turun menyentuhnya —
          // tanpa syarat ini, backtest memberi diskon fee sekaligus eksekusi
          // sempurna, kombinasi yang tidak pernah ada di pasar nyata.
          const offset = (cfg.makerOffsetPercent ?? 0.02) / 100;
          const limit = execBar.open * (1 - offset);
          if (execBar.low > limit) continue; // harga tidak datang - peluang dilewat
          entryPrice = limit;
        } else {
          // Order taker membayar slippage DAN separuh spread: harga beli berada
          // di sisi ask, bukan di tengah. Mengabaikan spread membuat setiap
          // trade tampak lebih murah daripada kenyataannya.
          const spreadCost = (cfg.spreadPercent ?? 0) / 2 / 100;
          entryPrice = execBar.open * (1 + cfg.slippagePercent / 100 + spreadCost);
        }

        const stopLoss = signal.suggestedStopLoss ?? entryPrice * (1 - params.minStopPercent / 100);
        if (stopLoss >= entryPrice) continue;

        const riskPerUnit = entryPrice - stopLoss;
        const stopPercent = (riskPerUnit / entryPrice) * 100;
        if (stopPercent > params.maxStopPercent) continue;

        const equity = cash + this.positionsValue(openPositions, candlesByPair, indexByPair, now);
        const riskAmount = equity * (params.riskPerTradePercent / 100);

        let quantity = riskAmount / riskPerUnit;
        let positionValue = quantity * entryPrice;

        const maxPosition = equity * (params.maxPositionPercent / 100);
        if (positionValue > maxPosition) {
          positionValue = maxPosition;
          quantity = positionValue / entryPrice;
        }

        const feeRate = this.feeRate(pair, cfg, useMaker);
        const totalCost = positionValue * (1 + feeRate);
        if (totalCost > cash) {
          positionValue = cash / (1 + feeRate);
          quantity = positionValue / entryPrice;
        }

        const minOrder = this.pairs.get(pair)?.minOrderIdr ?? 10000;
        if (positionValue < minOrder) continue;

        const entryFee = positionValue * feeRate;
        const netQuantity = quantity * (1 - feeRate);
        cash -= positionValue + entryFee;

        const takeProfit =
          signal.suggestedTakeProfit && signal.suggestedTakeProfit > entryPrice
            ? entryPrice + (signal.suggestedTakeProfit - window[window.length - 1].close)
            : entryPrice + riskPerUnit * (params.atrTargetMultiplier / params.atrStopMultiplier);

        openPositions.set(pair, {
          pair,
          entryBar: idx + 1,
          entryTime: execBar.time,
          entryPrice,
          quantity: netQuantity,
          positionValue,
          entryFee,
          stopLoss,
          takeProfit: Math.max(takeProfit, entryPrice * (1 + feeRate * 2 + 0.001)),
          initialRiskPerUnit: riskPerUnit,
          breakEvenMoved: false,
          tpFilled: 0,
          originalQuantity: netQuantity,
          realizedPnl: 0,
          highestPrice: entryPrice,
          lowestPrice: entryPrice,
          reasons: signal.reasons,
          intelligenceScore: miScore,
          marketRegime: miRegime,
          intelligenceDecision: miDecision,
        });
      }

      // ── 3. Catat ekuitas ──────────────────────────────────────────────
      const equity = cash + this.positionsValue(openPositions, candlesByPair, indexByPair, now);
      peakEquity = Math.max(peakEquity, equity);
      equityCurve.push({
        time: now,
        equity,
        drawdownPercent: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
        openPositions: openPositions.size,
      });
    }

    // Tutup paksa posisi yang masih terbuka di akhir periode uji.
    const lastTime = timeline[timeline.length - 1];
    for (const [pair, pos] of openPositions) {
      const candles = candlesByPair.get(pair)!;
      const idx = indexByPair.get(pair)!.get(lastTime) ?? candles.length - 1;
      const closed = this.closePosition(pos, candles[idx].close, lastTime, idx, cfg, 'END_OF_TEST');
      cash += closed.proceeds;
      trades.push(closed.trade);
    }

    return {
      trades: trades.sort((a, b) => a.entryTime - b.entryTime),
      equityCurve,
      barsTested,
      periodStart: new Date(timeline[startIndex] * 1000).toISOString(),
      periodEnd: new Date(lastTime * 1000).toISOString(),
    };
  }

  // ─── Utilitas simulasi ────────────────────────────────────────────────────

  /** Candle HTF yang sudah tertutup pada waktu `now` — mencegah look-ahead. */
  private sliceHtf(htf: Candle[], now: number): Candle[] {
    if (!htf.length) return [];
    const cutoff = htf.findIndex((c) => c.time > now);
    return cutoff === -1 ? htf : htf.slice(0, cutoff);
  }

  private feeRate(pair: string, cfg: BacktestConfig, maker = false): number {
    if (cfg.feePercentOverride !== undefined) return cfg.feePercentOverride / 100;
    try {
      return maker ? this.pairs.makerFeeRate(pair) : this.pairs.takerFeeRate(pair);
    } catch {
      return maker ? 0.001 : 0.002;
    }
  }

  private positionsValue(
    positions: Map<string, OpenPosition>,
    candlesByPair: Map<string, Candle[]>,
    indexByPair: Map<string, Map<number, number>>,
    now: number,
  ): number {
    let total = 0;
    for (const [pair, pos] of positions) {
      const idx = indexByPair.get(pair)?.get(now);
      const candles = candlesByPair.get(pair)!;
      const price = idx !== undefined ? candles[idx].close : pos.entryPrice;
      total += pos.quantity * price;
    }
    return total;
  }

  private closePosition(
    pos: OpenPosition,
    exitPriceRaw: number,
    exitTime: number,
    exitBar: number,
    cfg: BacktestConfig,
    reason: string,
  ): { trade: BacktestTrade; proceeds: number } {
    const feeRate = this.feeRate(pos.pair, cfg);
    // Exit selalu taker dalam model ini: slippage ditambah separuh spread,
    // kali ini menekan harga jual ke sisi bid.
    const spreadCost = (cfg.spreadPercent ?? 0) / 2 / 100;
    const exitPrice = exitPriceRaw * (1 - cfg.slippagePercent / 100 - spreadCost);

    const gross = pos.quantity * exitPrice;
    const exitFee = gross * feeRate;
    const proceeds = gross - exitFee;

    const costBasis = pos.quantity * pos.entryPrice;
    const profitLoss = proceeds - costBasis + pos.realizedPnl;
    const totalFees = pos.entryFee + exitFee;
    const riskIdr = pos.initialRiskPerUnit * pos.quantity;

    return {
      proceeds,
      trade: {
        pair: pos.pair,
        strategy: cfg.strategy,
        entryTime: pos.entryTime,
        exitTime,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        positionValue: pos.positionValue,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        profitLoss,
        profitLossPercent: pos.positionValue > 0 ? (profitLoss / pos.positionValue) * 100 : 0,
        rMultiple: riskIdr > 0 ? profitLoss / riskIdr : 0,
        fees: totalFees,
        closeReason: reason,
        holdingBars: exitBar - pos.entryBar,
        mfeR:
          pos.initialRiskPerUnit > 0
            ? (pos.highestPrice - pos.entryPrice) / pos.initialRiskPerUnit
            : 0,
        maeR:
          pos.initialRiskPerUnit > 0
            ? (pos.lowestPrice - pos.entryPrice) / pos.initialRiskPerUnit
            : 0,
        reasons: pos.reasons,
        intelligenceScore: pos.intelligenceScore,
        marketRegime: pos.marketRegime,
        intelligenceDecision: pos.intelligenceDecision,
      },
    };
  }

  // ─── Market Intelligence pada data historis ───────────────────────────────

  /**
   * Bangun konteks multi-timeframe dari candle yang tersedia, lalu jalankan
   * gerbang strategi.
   *
   * Bagaimana look-ahead bias dicegah di sini:
   *
   *  - `window` berisi HANYA bar 0..idx, semuanya sudah tertutup;
   *  - HTF sudah dipotong lebih dulu lewat `sliceHtf`;
   *  - timeframe lain dibentuk dengan `aggregateCandles`, yang MEMBUANG bucket
   *    terakhir bila belum lengkap - sehingga candle harian baru muncul setelah
   *    harinya benar-benar berakhir;
   *  - hasilnya dipakai untuk memutuskan entry pada bar BERIKUTNYA, bukan bar
   *    ini.
   */
  private evaluateIntelligence(
    pair: string,
    window: Candle[],
    htf: Candle[],
    cfg: BacktestConfig,
    params: BotParams,
    strategy: TradingStrategy,
  ): { allowed: boolean; score: number; regime: string; decision: string } | null {
    this.miStats.enabled = true;

    const lastBar = window[window.length - 1];
    const cacheKey = `${pair}|${lastBar.time}|${params.atrStopMultiplier}|${strategy.name}`;
    const cached = this.miCache.get(cacheKey);
    if (cached) {
      this.tallyIntelligence(cached);
      return cached;
    }

    try {
      const candleSet = this.buildBacktestCandleSet(window, htf, cfg, params);
      const report = this.intelligence.analyzeCandles(pair, candleSet, {
        direction: 'LONG',
        atrStopMultiplier: params.atrStopMultiplier,
        // Diteruskan eksplisit: params di sini sudah memuat paramOverrides,
        // sedangkan MI service membaca konfigurasi global.
        fomoGuard: params.fomoGuardEnabled,
      });
      const gate = this.intelligenceGate.evaluate(strategy, report);

      const verdict = {
        allowed: gate.allowed,
        score: gate.score,
        regime: report.confluence.regime,
        decision: gate.decision,
        rejections: gate.rejections,
      };

      this.miCache.set(cacheKey, verdict);
      this.tallyIntelligence(verdict);
      return verdict;
    } catch (err) {
      // Kegagalan analisis tidak boleh diam-diam mengubah hasil backtest
      // menjadi "tidak ada sinyal". Sinyal diteruskan, kegagalannya dicatat.
      this.logger.warn(`Market Intelligence backtest ${pair} gagal: ${err.message}`);
      return null;
    }
  }

  private tallyIntelligence(verdict: {
    allowed: boolean;
    score: number;
    rejections?: string[];
  }): void {
    if (verdict.allowed) {
      this.miStats.accepted++;
      this.miStats.scores.push(verdict.score);
    } else {
      this.miStats.rejected++;
      for (const raw of verdict.rejections ?? []) {
        const key = raw
          .replace(/-?\d+([.,]\d+)?%?/g, 'N')
          .replace(/\s+/g, ' ')
          .trim();
        this.miStats.rejections.set(key, (this.miStats.rejections.get(key) ?? 0) + 1);
      }
    }
  }

  /**
   * Petakan candle backtest ke timeframe Market Intelligence.
   *
   * Timeframe utama dan HTF dipakai apa adanya bila panjangnya cocok; timeframe
   * yang lebih besar dibentuk dengan agregasi. Timeframe yang LEBIH KECIL dari
   * timeframe utama tidak pernah dibuat-buat - memecah satu candle 1H menjadi
   * dua belas candle 5m berarti mengarang data yang tidak pernah ada.
   */
  private buildBacktestCandleSet(
    window: Candle[],
    htf: Candle[],
    cfg: BacktestConfig,
    params: BotParams,
  ): CandleSet {
    const set: CandleSet = {};

    const primaryLabel = labelForMinutes(cfg.timeframe);
    if (primaryLabel) set[primaryLabel] = window;

    const htfLabel = labelForMinutes(params.htfTimeframe);
    if (htfLabel && htf.length && !set[htfLabel]) set[htfLabel] = htf;

    // Agregasi ke timeframe yang lebih besar dari timeframe utama.
    for (const tf of TIMEFRAMES) {
      if (set[tf]) continue;
      const targetMinutes = TIMEFRAME_MINUTES[tf];
      if (targetMinutes <= cfg.timeframe) continue;

      const aggregated = aggregateCandles(window, targetMinutes, cfg.timeframe);
      if (aggregated.length >= 30) set[tf] = aggregated;
    }

    return set;
  }

  // ─── Metrik ───────────────────────────────────────────────────────────────

  private computeMetrics(
    cfg: BacktestConfig,
    trades: BacktestTrade[],
    equityCurve: EquityPoint[],
    barsTested: number,
    timeframeMinutes: number,
  ): BacktestMetrics {
    const initial = cfg.initialCapital;
    const final = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : initial;

    const wins = trades.filter((t) => t.profitLoss > 0);
    const losses = trades.filter((t) => t.profitLoss <= 0);

    const grossProfit = wins.reduce((s, t) => s + t.profitLoss, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profitLoss, 0));
    const totalFees = trades.reduce((s, t) => s + t.fees, 0);

    // Drawdown maksimum dari equity curve.
    let peak = initial;
    let maxDdPercent = 0;
    let maxDdIdr = 0;
    for (const p of equityCurve) {
      peak = Math.max(peak, p.equity);
      const dd = peak - p.equity;
      maxDdIdr = Math.max(maxDdIdr, dd);
      if (peak > 0) maxDdPercent = Math.max(maxDdPercent, (dd / peak) * 100);
    }

    // Rentetan terpanjang.
    let curWin = 0;
    let curLoss = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      if (t.profitLoss > 0) {
        curWin++;
        curLoss = 0;
      } else {
        curLoss++;
        curWin = 0;
      }
      maxWinStreak = Math.max(maxWinStreak, curWin);
      maxLossStreak = Math.max(maxLossStreak, curLoss);
    }

    // Sharpe & Sortino dari return per bar, disetahunkan.
    const barReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) barReturns.push((equityCurve[i].equity - prev) / prev);
    }
    const barsPerYear = (365 * 24 * 60) / timeframeMinutes;
    const avgReturn = mean(barReturns);
    const volatility = stdev(barReturns);
    const downsideReturns = barReturns.filter((r) => r < 0);
    const downsideVol = downsideReturns.length ? stdev(downsideReturns) : 0;

    const sharpe = volatility > 0 ? (avgReturn / volatility) * Math.sqrt(barsPerYear) : 0;
    const sortino = downsideVol > 0 ? (avgReturn / downsideVol) * Math.sqrt(barsPerYear) : 0;

    const totalReturnPercent = initial > 0 ? ((final - initial) / initial) * 100 : 0;
    const years = barsTested / barsPerYear;
    const annualized =
      years > 0 && initial > 0 ? (Math.pow(final / initial, 1 / years) - 1) * 100 : 0;

    // Porsi waktu dengan posisi terbuka.
    const barsWithPosition = equityCurve.filter((p) => p.openPositions > 0).length;

    const closeReasons: Record<string, number> = {};
    for (const t of trades) closeReasons[t.closeReason] = (closeReasons[t.closeReason] || 0) + 1;

    const perPair: BacktestMetrics['perPair'] = {};
    for (const pair of cfg.pairs) {
      const pt = trades.filter((t) => t.pair === pair);
      if (!pt.length) continue;
      perPair[pair] = {
        trades: pt.length,
        netProfit: Math.round(pt.reduce((s, t) => s + t.profitLoss, 0)),
        winRate: Number(((pt.filter((t) => t.profitLoss > 0).length / pt.length) * 100).toFixed(1)),
      };
    }

    const rMultiples = trades.map((t) => t.rMultiple);

    return {
      totalTrades: trades.length,
      winTrades: wins.length,
      lossTrades: losses.length,
      winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(2)) : 0,
      initialCapital: initial,
      finalEquity: Math.round(final),
      totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
      annualizedReturnPercent: Number(clamp(annualized, -100, 100000).toFixed(2)),
      grossProfit: Math.round(grossProfit),
      grossLoss: Math.round(grossLoss),
      netProfit: Math.round(grossProfit - grossLoss),
      totalFees: Math.round(totalFees),
      feeDragPercent: grossProfit > 0 ? Number(((totalFees / grossProfit) * 100).toFixed(1)) : null,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null,
      expectancyR: trades.length ? Number(mean(rMultiples).toFixed(4)) : 0,
      expectancyStdevR: trades.length > 1 ? Number(stdev(rMultiples).toFixed(4)) : 0,
      expectancyStdErrorR:
        trades.length > 1
          ? Number((stdev(rMultiples) / Math.sqrt(trades.length)).toFixed(4))
          : 0,
      avgWinR: wins.length ? Number(mean(wins.map((t) => t.rMultiple)).toFixed(3)) : 0,
      avgLossR: losses.length ? Number(mean(losses.map((t) => t.rMultiple)).toFixed(3)) : 0,
      maxDrawdownPercent: Number(maxDdPercent.toFixed(2)),
      maxDrawdownIdr: Math.round(maxDdIdr),
      maxConsecutiveLosses: maxLossStreak,
      maxConsecutiveWins: maxWinStreak,
      sharpeRatio: Number(sharpe.toFixed(3)),
      sortinoRatio: Number(sortino.toFixed(3)),
      calmarRatio: maxDdPercent > 0 ? Number((annualized / maxDdPercent).toFixed(3)) : null,
      avgHoldingBars: trades.length
        ? Number(mean(trades.map((t) => t.holdingBars)).toFixed(1))
        : 0,
      exposurePercent: equityCurve.length
        ? Number(((barsWithPosition / equityCurve.length) * 100).toFixed(1))
        : 0,
      closeReasons,
      perPair,
      byScoreBucket: sliceByScore(trades),
      byRegime: sliceByRegime(trades),
      intelligence: {
        enabled: this.miStats.enabled,
        accepted: this.miStats.accepted,
        rejected: this.miStats.rejected,
        avgScore: this.miStats.scores.length
          ? Number(mean(this.miStats.scores).toFixed(1))
          : null,
        topRejections: [...this.miStats.rejections.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
      },
    };
  }


  private async persist(report: BacktestReport): Promise<void> {
    try {
      await this.resultRepo.save({
        strategy: report.config.strategy,
        pairs: report.config.pairs.join(','),
        timeframe: report.config.timeframe,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        initialCapital: report.metrics.initialCapital,
        finalEquity: report.metrics.finalEquity,
        totalReturnPercent: report.metrics.totalReturnPercent,
        totalTrades: report.metrics.totalTrades,
        winRate: report.metrics.winRate,
        profitFactor: report.metrics.profitFactor ?? 0,
        maxDrawdownPercent: report.metrics.maxDrawdownPercent,
        sharpeRatio: report.metrics.sharpeRatio,
        expectancyR: report.metrics.expectancyR,
        totalFees: report.metrics.totalFees,
        params: JSON.stringify(report.config.paramOverrides ?? {}),
        // Equity curve dipangkas agar baris database tidak membengkak.
        report: JSON.stringify({
          metrics: report.metrics,
          warnings: report.warnings,
          equityCurve: downsample(report.equityCurve, 500),
          trades: report.trades.slice(-200),
        }),
      });
    } catch (err) {
      this.logger.warn(`Gagal menyimpan hasil backtest: ${err.message}`);
    }
  }

  async getHistory(limit = 20): Promise<BacktestResult[]> {
    return this.resultRepo.find({ order: { createdAt: 'DESC' }, take: limit });
  }
}

/** Kurangi jumlah titik equity curve dengan tetap menjaga bentuknya. */
function downsample<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/** Ubah menit menjadi label timeframe Market Intelligence; null bila tak ada padanan. */
function labelForMinutes(minutes: number): Timeframe | null {
  const entry = (Object.entries(TIMEFRAME_MINUTES) as Array<[Timeframe, number]>).find(
    ([, value]) => value === minutes,
  );
  return entry ? entry[0] : null;
}
