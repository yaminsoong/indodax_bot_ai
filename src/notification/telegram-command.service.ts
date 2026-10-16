import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ChartBuilderService } from './chart-builder.service';
import { ScannerReportService } from './scanner-report.service';
import { TradeConfirmService } from './trade-confirm.service';
import { IndodaxService } from '../indodax/indodax.service';
import { TradingService } from '../trading/trading.service';
import { PortfolioService } from '../trading/portfolio.service';
import { RiskService } from '../trading/risk.service';
import { ReconciliationService } from '../trading/reconciliation.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { BotConfigService } from '../config/bot-config.service';
import { AnalysisService } from '../analysis/analysis.service';
import { MarketIntelligenceService } from '../market-intelligence/market-intelligence.service';
import { MarketIntelligenceConfigService } from '../market-intelligence/mi-config.service';
import { HealthService } from '../monitoring/health.service';
import { NewsService } from '../news/news.service';
import { GroupSentimentService } from '../news/group-sentiment.service';
import { ScoreAttributionService } from '../trading/score-attribution.service';
import { LevelEditorService } from '../trading/level-editor.service';
import { GlobalMarketService } from '../global-market/global-market.service';
import { AiAnalystService } from '../analyst/ai-analyst.service';
import { OpportunityWatcherService } from './opportunity-watcher.service';
import { AffordabilityService } from '../trading/affordability.service';
import { TelegramMenuService } from './telegram-menu.service';
import { RecoveryService } from '../trading/recovery.service';
import { fmtPrice, idr } from '../common/num';

/** Parameter numerik yang boleh diubah lewat Telegram, beserta rentang amannya. */
const TUNABLE: Record<string, { key: string; min: number; max: number; label: string }> = {
  risk: { key: 'RISK_PER_TRADE_PERCENT', min: 0.1, max: 5, label: 'Risiko per trade (%)' },
  maxtrades: { key: 'MAX_CONCURRENT_TRADES', min: 1, max: 10, label: 'Maks posisi bersamaan' },
  dailyloss: { key: 'MAX_DAILY_LOSS_PERCENT', min: 1, max: 20, label: 'Batas rugi harian (%)' },
  drawdown: { key: 'MAX_DRAWDOWN_PERCENT', min: 5, max: 50, label: 'Batas drawdown (%)' },
  strength: { key: 'MIN_SIGNAL_STRENGTH', min: 0, max: 100, label: 'Kekuatan sinyal minimum' },
  adx: { key: 'MIN_ADX', min: 0, max: 50, label: 'ADX minimum' },
  cooldown: { key: 'COOLDOWN_MINUTES_AFTER_LOSS', min: 0, max: 1440, label: 'Cooldown setelah rugi (menit)' },
};

/**
 * Perintah Telegram untuk mengendalikan bot dari ponsel.
 * Didaftarkan setelah seluruh modul siap agar tidak terjadi dependensi melingkar.
 */
@Injectable()
export class TelegramCommandService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramCommandService.name);

  constructor(
    private readonly notification: NotificationService,
    private readonly charts: ChartBuilderService,
    private readonly scannerReport: ScannerReportService,
    private readonly tradeConfirm: TradeConfirmService,
    private readonly indodax: IndodaxService,
    private readonly trading: TradingService,
    private readonly portfolio: PortfolioService,
    private readonly risk: RiskService,
    private readonly reconciliation: ReconciliationService,
    private readonly strategies: StrategyRegistry,
    private readonly config: BotConfigService,
    private readonly analysis: AnalysisService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly health: HealthService,
    private readonly recovery: RecoveryService,
    private readonly news: NewsService,
    private readonly globalMarket: GlobalMarketService,
    private readonly analyst: AiAnalystService,
    private readonly opportunities: OpportunityWatcherService,
    private readonly affordability: AffordabilityService,
    private readonly menuUi: TelegramMenuService,
    private readonly groupSentiment: GroupSentimentService,
    private readonly intelligenceConfig: MarketIntelligenceConfigService,
    private readonly scoreAttribution: ScoreAttributionService,
    private readonly levelEditor: LevelEditorService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.notification.isEnabled()) return;

    /**
     * Pasang pengamat grup.
     *
     * Didaftarkan dari sini, bukan dari modul berita, karena hanya modul ini
     * yang memegang NotificationService DAN lapisan berita sekaligus —
     * memberi NotificationService ketergantungan ke modul berita akan
     * membuat lingkaran.
     */
    if (this.groupSentiment.isEnabled()) {
      this.notification.registerGroupObserver((chatId, title, text) =>
        this.groupSentiment.observe(chatId, title, text),
      );
      this.logger.log(
        `Mengamati ${this.groupSentiment.watchedGroups().length} grup Telegram ` +
          '(hanya membaca; grup tidak bisa menjalankan perintah)',
      );
    }

    const reg = (name: string, help: string, fn: (args: string[]) => Promise<string>) =>
      this.notification.registerCommand(name, help, (args) => fn(args));

    reg('status', 'Ringkasan bot, ekuitas, dan posisi terbuka', () => this.status());
    reg('positions', 'Detail seluruh posisi terbuka', () => this.positions());
    reg('pnl', 'Performa keseluruhan', () => this.pnl());
    reg('today', 'Statistik hari ini', () => this.today());
    reg('close', 'Tutup posisi: /close <id> atau /close all', (a) => this.close(a));
    reg('pause', 'Hentikan pembukaan posisi baru', () => this.pause());
    reg('resume', 'Aktifkan kembali pembukaan posisi', () => this.resume());
    reg('scan', 'Analisis pair sekarang: /scan btcidr', (a) => this.scan(a));
    reg('strategy', 'Lihat/ganti strategi: /strategy [nama]', (a) => this.strategy(a));
    reg('config', 'Lihat konfigurasi aktif', () => this.showConfig());
    reg('set', 'Ubah parameter: /set risk 1.5', (a) => this.set(a));
    reg('reconcile', 'Cocokkan catatan bot dengan Indodax', () => this.reconcile());
    reg('risk', 'Status kill switch dan sisa jatah risiko', () => this.riskStatus());
    reg('blockers', 'Kenapa bot tidak membuka posisi: /blockers [jam]', (a) => this.blockers(a));
    reg('chart', 'Grafik + garis support/resistance: /chart btcidr [tf]', (a) => this.chart(a));
    reg('market', 'Pindai seluruh pair IDR likuid dan beri peringkat', () => this.marketScan());
    reg('buy', 'Usulkan order dengan konfirmasi: /buy btcidr', (a) => this.proposeBuy(a));
    reg('analyze', 'Analisis Market Intelligence: /analyze btcidr', (a) => this.analyze(a));
    reg('overview', 'Ringkasan pasar seluruh pair yang ditradingkan', () => this.overview());
    reg('health', 'Kesehatan komponen operasional', () => this.healthStatus());
    reg('recover', 'Pulihkan posisi berstatus FAILED', () => this.recoverFailed());
    reg('news', 'Berita + sentimen: /news atau /news btc', (a) => this.newsReport(a));
    reg('skor', 'Apakah skor MI benar-benar meramalkan hasil?', () => this.scoreReport());
    reg('sl', 'Ubah stop loss: /sl <id> <harga>', (a) => this.editLevel('sl', a));
    reg('tp', 'Ubah take profit: /tp <id> <harga>', (a) => this.editLevel('tp', a));
    reg('global', 'Pasar global dan Global Risk Score', () => this.globalReport());
    reg('menu', 'Menu bertombol — tidak perlu menghafal perintah', () => this.openMenu());
    reg('start', 'Buka menu utama', () => this.openMenu());
    reg('ask', 'Tanya bebas ke analis: /ask kenapa BTC turun?', (a) => this.askAnalyst(a));
    reg('peluang', 'Cari peluang sekarang dan kirim tawaran bertombol', () => this.findOpportunities());
    reg('dashboard', 'Apa yang bisa dibeli dengan saldo sekarang + kartu bertombol', () => this.dashboard());

    this.logger.log('Perintah Telegram terdaftar');
  }

  // ─── Handler ──────────────────────────────────────────────────────────────

  private async status(): Promise<string> {
    const [state, daily, kill] = await Promise.all([
      this.portfolio.getState(),
      this.risk.getDailyStats(),
      this.risk.checkKillSwitch(),
    ]);
    const params = this.config.params();

    return [
      `🤖 *STATUS BOT*`,
      '',
      `Mode: *${this.config.mode}*`,
      `Strategi: \`${this.strategies.active().name}\``,
      `Trading: ${kill.halted ? '🛑 DIHENTIKAN' : '🟢 AKTIF'}`,
      ...(kill.halted ? kill.reasons.map((r) => `  • ${r}`) : []),
      '',
      `*Portofolio*`,
      `Ekuitas: ${idr(state.equityIdr)}`,
      `Kas: ${idr(state.cashIdr)}`,
      `Posisi: ${idr(state.positionsValueIdr)} (${state.openPositions})`,
      `Belum terealisasi: ${idr(state.unrealizedPnl)}`,
      `Drawdown: ${state.drawdownPercent.toFixed(2)}%`,
      '',
      `*Hari ini*`,
      `${daily.totalTrades} trade | ${daily.winTrades}M/${daily.lossTrades}K | P&L ${idr(daily.totalPnL)}`,
      '',
      `Pair: ${params.tradingPairs.map((p) => p.toUpperCase()).join(', ')}`,
      state.degraded ? '\n⚠️ Sebagian data portofolio tidak terbaca' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async positions(): Promise<string> {
    const state = await this.portfolio.getState();
    if (!state.positions.length) return 'Tidak ada posisi terbuka.';

    const lines = state.positions.map((p) => {
      const emoji = p.unrealizedPnl >= 0 ? '🟢' : '🔴';
      return [
        `${emoji} *#${p.tradeId} ${p.pair.toUpperCase()}*`,
        `  Entry ${fmtPrice(p.entryPrice)} → ${fmtPrice(p.currentPrice)}`,
        `  ${p.unrealizedPercent >= 0 ? '+' : ''}${p.unrealizedPercent.toFixed(2)}% (${p.rMultiple >= 0 ? '+' : ''}${p.rMultiple.toFixed(2)}R) = ${idr(p.unrealizedPnl)}`,
        `  Nilai ${idr(p.valueIdr)}`,
      ].join('\n');
    });

    return [`📊 *POSISI TERBUKA (${state.positions.length})*`, '', ...lines].join('\n\n');
  }

  private async pnl(): Promise<string> {
    const perf = await this.trading.getPerformanceSummary();
    if (!perf.totalTrades) return 'Belum ada trade yang selesai.';

    return [
      `📈 *PERFORMA (${perf.mode})*`,
      '',
      `Total trade: ${perf.totalTrades}`,
      `Win rate: ${perf.winRate}% (${perf.winTrades}M / ${perf.lossTrades}K)`,
      `P&L bersih: ${idr(perf.totalPnL)}`,
      `Profit factor: ${perf.profitFactor ?? 'n/a'}`,
      `Ekspektasi: ${perf.expectancyR >= 0 ? '+' : ''}${perf.expectancyR}R per trade`,
      '',
      `Rata-rata menang: ${idr(perf.avgWin)}`,
      `Rata-rata kalah: ${idr(perf.avgLoss)}`,
      `Terbaik: ${idr(perf.bestTrade)} | Terburuk: ${idr(perf.worstTrade)}`,
      '',
      `Total fee: ${idr(perf.totalFees)}`,
      perf.feeDragPercent !== null ? `Fee memakan ${perf.feeDragPercent}% dari profit kotor` : '',
      `Rata-rata durasi: ${perf.avgHoldingHours} jam`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async today(): Promise<string> {
    const s = await this.risk.getDailyStats();
    const remaining = await this.risk.getRemainingDailyRisk();
    return [
      `📅 *HARI INI (WIB)*`,
      '',
      `Trade selesai: ${s.totalTrades}`,
      `Menang ${s.winTrades} / Kalah ${s.lossTrades} (${s.winRate.toFixed(1)}%)`,
      `P&L: ${idr(s.totalPnL)}`,
      `Fee: ${idr(s.totalFees)}`,
      `Rata-rata: ${s.avgRMultiple >= 0 ? '+' : ''}${s.avgRMultiple.toFixed(2)}R`,
      `Posisi aktif: ${s.openTrades}`,
      '',
      `Sisa jatah risiko harian: ${remaining.toFixed(2)}%`,
    ].join('\n');
  }

  private async close(args: string[]): Promise<string> {
    if (!args.length) return 'Gunakan: /close <id> atau /close all';

    if (args[0].toLowerCase() === 'all') {
      const res = await this.trading.closeAllPositions('MANUAL_CLOSE_ALL');
      return `Penutupan massal selesai: ${res.closed} berhasil, ${res.failed} gagal.`;
    }

    const id = parseInt(args[0], 10);
    if (!Number.isFinite(id)) return 'ID trade tidak valid.';

    const res = await this.trading.manualCloseTrade(id);
    return res.success ? `✅ ${res.message}` : `❌ ${res.message}`;
  }

  private async pause(): Promise<string> {
    await this.config.set('TRADING_ENABLED', 'false', 'Dijeda lewat Telegram');
    return '⏸️ Pembukaan posisi baru dihentikan. Posisi terbuka tetap dimonitor dan stop loss tetap aktif.';
  }

  private async resume(): Promise<string> {
    await this.config.set('TRADING_ENABLED', 'true', 'Diaktifkan lewat Telegram');
    const kill = await this.risk.checkKillSwitch();
    return kill.halted
      ? `▶️ Flag trading diaktifkan, tetapi bot masih tertahan:\n${kill.reasons.map((r) => `• ${r}`).join('\n')}`
      : '▶️ Trading diaktifkan kembali.';
  }

  private async scan(args: string[]): Promise<string> {
    if (!args.length) return 'Gunakan: /scan btcidr';
    const pair = args[0].toLowerCase();

    const result = await this.analysis.analyzeNow(pair);
    if (!result) return `Tidak bisa menganalisis ${pair.toUpperCase()} (data tidak cukup atau pair tidak dikenal).`;

    return [
      `🔍 *${pair.toUpperCase()}*`,
      '',
      `Harga: Rp ${fmtPrice(result.price)} (${result.change24h >= 0 ? '+' : ''}${result.change24h.toFixed(2)}% 24j)`,
      `Sinyal: *${result.signal}* (${result.strength}%)`,
      `Tren: ${result.trend} | Regime: ${result.regime}`,
      `RSI ${result.rsi.toFixed(1)} | ADX ${result.adx.toFixed(1)} | ATR ${result.atrPercent.toFixed(2)}%`,
      '',
      ...(result.reasons?.length ? ['*Alasan:*', ...result.reasons.map((r: string) => `  • ${r}`)] : []),
      ...(result.blockedBy?.length
        ? ['', '*Ditahan oleh:*', ...result.blockedBy.map((r: string) => `  • ${r}`)]
        : []),
    ].join('\n');
  }

  private async strategy(args: string[]): Promise<string> {
    if (!args.length) {
      const list = this.strategies.list();
      return [
        '*STRATEGI*',
        '',
        ...list.map((s) => `${s.active ? '▶️' : '  '} \`${s.name}\`\n   ${s.description}`),
        '',
        'Ganti dengan: /strategy <NAMA>',
      ].join('\n');
    }

    const res = await this.strategies.setActive(args[0].toUpperCase());
    return res.success ? `✅ ${res.message}` : `❌ ${res.message}`;
  }

  private async showConfig(): Promise<string> {
    const p = this.config.params();
    const overrides = this.config.listOverrides();

    return [
      '⚙️ *KONFIGURASI AKTIF*',
      '',
      `Risiko/trade: ${p.riskPerTradePercent}%`,
      `Maks posisi: ${p.maxConcurrentTrades} (per kelompok: ${p.maxPositionsPerCorrelationGroup})`,
      `Rugi harian maks: ${p.maxDailyLossPercent}%`,
      `Drawdown maks: ${p.maxDrawdownPercent}%`,
      `Kalah beruntun maks: ${p.maxConsecutiveLosses}`,
      '',
      `Stop: ${p.atrStopMultiplier}×ATR (batas ${p.minStopPercent}-${p.maxStopPercent}%)`,
      `Target: ${p.atrTargetMultiplier}×ATR`,
      `Break-even di: ${p.breakEvenAtR}R`,
      `Take profit: ${p.takeProfitLevels.map((l, i) => `TP${i + 1} ${l.closePercent}%@${l.atR}R`).join(' · ')}`,
      `Trailing: ${p.trailingAtrMultiplier}×ATR`,
      `Maks durasi: ${p.maxHoldingHours} jam`,
      '',
      `Sinyal minimum: ${p.minSignalStrength}`,
      `ADX minimum: ${p.minAdx} | Choppiness maks: ${p.maxChoppiness}`,
      `Filter HTF: ${p.requireHtfTrend ? 'ya' : 'tidak'} (${p.htfTimeframe}m)`,
      `Cooldown setelah rugi: ${p.cooldownMinutesAfterLoss} menit`,
      '',
      Object.keys(overrides).length
        ? `*Override tersimpan:*\n${Object.entries(overrides).map(([k, v]) => `  ${k} = ${v}`).join('\n')}`
        : '_Tidak ada override; semua dari .env/default._',
      '',
      `Ubah dengan: /set <${Object.keys(TUNABLE).join('|')}> <nilai>`,
    ].join('\n');
  }

  private async set(args: string[]): Promise<string> {
    if (args.length < 2) {
      return `Gunakan: /set <parameter> <nilai>\n\nParameter: ${Object.keys(TUNABLE).join(', ')}`;
    }

    const name = args[0].toLowerCase();
    const spec = TUNABLE[name];
    if (!spec) return `Parameter '${name}' tidak dikenal. Pilihan: ${Object.keys(TUNABLE).join(', ')}`;

    const value = Number(args[1]);
    if (!Number.isFinite(value)) return `Nilai '${args[1]}' bukan angka.`;
    if (value < spec.min || value > spec.max) {
      return `${spec.label} harus antara ${spec.min} dan ${spec.max}.`;
    }

    await this.config.set(spec.key, String(value), spec.label);
    return `✅ ${spec.label} diubah menjadi ${value}.`;
  }

  private async reconcile(): Promise<string> {
    const report = await this.reconciliation.reconcile();
    if (!report.discrepancies.length) {
      return `✅ Rekonsiliasi bersih — ${report.checked} posisi cocok dengan Indodax.`;
    }
    return [
      `🔍 *HASIL REKONSILIASI*`,
      `${report.checked} posisi diperiksa, ${report.autoFixed} diperbaiki otomatis`,
      '',
      ...report.discrepancies.map((d) => `${severityIcon(d.severity)} *${d.type}* (${d.pair.toUpperCase()})\n  ${d.detail}`),
    ].join('\n');
  }

  /** Diagnosa bot yang pasif: filter mana yang paling sering menahan entry. */
  private async blockers(args: string[]): Promise<string> {
    const hours = Number(args[0]) > 0 ? Number(args[0]) : 168;
    const r = await this.trading.getBlockerStats(hours);

    if (!r.totalSignals) {
      return `Belum ada sinyal tercatat dalam ${hours} jam terakhir. Pastikan bot berjalan dan data candle masuk.`;
    }

    const lines = [
      `🔍 *KENAPA BOT TIDAK MASUK POSISI*`,
      `Periode: ${hours} jam terakhir`,
      '',
      `Sinyal dievaluasi: ${r.totalSignals}`,
      `Lolos jadi BUY: ${r.buySignals} | Dieksekusi: ${r.executedSignals}`,
      '',
      '*Filter yang paling sering menahan:*',
      ...r.blockers
        .slice(0, 8)
        .map((b) => `  ${String(b.percentOfSignals).padStart(5)}% — ${b.reason}`),
    ];

    if (r.nearMisses.length) {
      lines.push('', '*Sinyal kuat yang tertahan:*');
      for (const n of r.nearMisses.slice(0, 3)) {
        lines.push(`  ${n.pair.toUpperCase()} kekuatan ${n.strength} — ${n.blockedBy}`);
      }
    }

    // Panduan membaca, bukan sekadar angka.
    const top = r.blockers[0];
    if (top && top.percentOfSignals > 80) {
      lines.push(
        '',
        `⚠️ Satu filter menahan ${top.percentOfSignals}% sinyal. Itu filter pengikat utama Anda.`,
        'Longgarkan HANYA bila backtest membuktikan ekspektasinya naik — bukan karena bosan menunggu.',
      );
    } else if (r.buySignals === 0) {
      lines.push('', 'Tidak ada satu pun sinyal lolos. Pasar sedang tanpa arah, atau filter terlalu ketat.');
    }

    return lines.join('\n');
  }

  /**
   * Kirim grafik pair sebagai gambar.
   *
   * Mengembalikan string kosong saat berhasil: gambarnya sudah dikirim sendiri
   * lengkap dengan keterangan, dan pesan teks tambahan hanya akan menduplikasi
   * isinya.
   */
  private async chart(args: string[]): Promise<string> {
    const pair = (args[0] || this.config.params().tradingPairs[0] || 'btcidr').toLowerCase();

    const tfArg = Number(args[1]);
    const tf = IndodaxService.isValidTimeframe(tfArg)
      ? tfArg
      : this.config.params().candleTimeframe;

    if (args[1] && !IndodaxService.isValidTimeframe(tfArg)) {
      return `Timeframe ${args[1]} tidak didukung. Pilihan: ${IndodaxService.VALID_TIMEFRAMES.join(', ')} menit.`;
    }

    let ticker;
    try {
      ticker = await this.indodax.getTicker(pair);
    } catch {
      return `Pair ${pair.toUpperCase()} tidak dikenal di Indodax.`;
    }

    // Analisis dipakai sebagai keterangan supaya gambar dan angkanya berasal
    // dari sumber yang sama persis dengan yang dipakai bot untuk memutuskan.
    const analysis = await this.analysis.analyzeNow(pair).catch(() => null);

    const caption: string[] = [
      `*${pair.toUpperCase()}* — Rp ${fmtPrice(ticker.last)} (${ticker.percent_change_24h >= 0 ? '+' : ''}${ticker.percent_change_24h.toFixed(2)}% 24j)`,
    ];
    if (analysis) {
      caption.push(
        `Sinyal: *${analysis.signal}* (${analysis.strength}%) · ${analysis.trend} · ${analysis.regime}`,
        `RSI ${analysis.rsi.toFixed(1)} · ADX ${analysis.adx.toFixed(1)} · ATR ${analysis.atrPercent.toFixed(2)}%`,
      );
      if (analysis.blockedBy?.length) {
        caption.push('', '*Ditahan oleh:*', ...analysis.blockedBy.slice(0, 4).map((b: string) => `  • ${b}`));
      }
    }

    const image = await this.charts.build(pair, {
      timeframeMinutes: tf,
      subtitle: analysis ? `${analysis.trend} · ${analysis.regime}` : undefined,
    });

    const text = caption.join('\n');
    if (!image) return `${text}\n\n_(grafik gagal dibuat)_`;

    await this.notification.sendChart(image, text);
    return '';
  }

  /**
   * Pindai pasar atas permintaan.
   *
   * Mengembalikan string kosong: laporannya dikirim sendiri oleh
   * ScannerReportService, lengkap dengan chart kandidat teratas.
   */
  private async marketScan(): Promise<string> {
    await this.notification.sendRaw(
      'Memindai pasar… analisis multi-timeframe butuh waktu beberapa menit.',
    );
    await this.scannerReport.scanAndReport();
    return '';
  }

  /**
   * Tawarkan sebuah pair beserta tombolnya.
   *
   * Tidak memesan apa pun: tombol BUY di dalamnya pun masih meminta
   * konfirmasi kedua sebelum order sungguhan dikirim.
   */
  private async proposeBuy(args: string[]): Promise<string> {
    const pair = (args[0] || '').toLowerCase();
    if (!pair) return 'Gunakan: /buy btcidr';

    const a = await this.analysis.analyzeNow(pair).catch(() => null);
    if (!a) return `Pair ${pair.toUpperCase()} tidak dikenal atau datanya tidak cukup.`;

    await this.tradeConfirm.offer(
      pair,
      [
        `*${pair.toUpperCase()}* — Rp ${fmtPrice(a.price)}`,
        `Sinyal ${a.signal} (${a.strength}%) · ${a.trend} · ${a.regime}`,
        `RSI ${a.rsi.toFixed(1)} · ADX ${a.adx.toFixed(1)} · ATR ${a.atrPercent.toFixed(2)}%`,
        ...(a.blockedBy?.length ? ['', `⚠️ Ditahan: ${a.blockedBy[0]}`] : []),
      ].join('\n'),
    );
    return '';
  }

  private async riskStatus(): Promise<string> {
    const [kill, remaining, streak, dd] = await Promise.all([
      this.risk.checkKillSwitch(),
      this.risk.getRemainingDailyRisk(),
      this.risk.getConsecutiveLosses(),
      this.portfolio.getMaxDrawdown(),
    ]);
    const p = this.config.params();

    return [
      '🛡️ *STATUS RISIKO*',
      '',
      kill.halted ? '🛑 *ENTRY DIHENTIKAN*' : '🟢 Entry diizinkan',
      ...(kill.halted ? kill.reasons.map((r) => `  • ${r}`) : []),
      '',
      `Sisa jatah rugi harian: ${remaining.toFixed(2)}% dari ${p.maxDailyLossPercent}%`,
      `Kalah beruntun: ${streak} dari batas ${p.maxConsecutiveLosses}`,
      `Drawdown sekarang: ${dd.currentDrawdownPercent.toFixed(2)}%`,
      `Drawdown maks (90 hari): ${dd.maxDrawdownPercent.toFixed(2)}% dari batas ${p.maxDrawdownPercent}%`,
    ].join('\n');
  }

  // ─── Market Intelligence ──────────────────────────────────────────────────

  /** Analisis multi-timeframe satu pair, dalam bentuk teks siap baca. */
  private async analyze(args: string[]): Promise<string> {
    const pair = (args[0] ?? this.config.params().tradingPairs[0] ?? 'btcidr').toLowerCase();
    try {
      const report = await this.intelligence.analyze(pair, {
        direction: 'LONG',
        atrStopMultiplier: this.config.params().atrStopMultiplier,
      });
      // Teks penjelasan sudah disusun SignalExplainerService; tidak ada gunanya
      // menyusun ulang format kedua yang bisa menyimpang darinya.
      return report.explanation.text;
    } catch (err) {
      return `Analisis ${pair.toUpperCase()} gagal: ${err.message}`;
    }
  }

  /** Ringkasan seluruh pair yang sedang ditradingkan. */
  private async overview(): Promise<string> {
    const pairs = this.config.params().tradingPairs;
    const reports = await this.intelligence.analyzeMany(pairs);

    if (!reports.length) return 'Tidak ada pair yang bisa dianalisis.';

    const lines = ['📊 *MARKET OVERVIEW*', ''];
    for (const r of reports) {
      const a = r.mtf.timeframes[r.confluence.timeframe];
      const signal = r.confluence.blockers.length ? 'NO TRADE' : r.confluence.decision.replace(/_/g, ' ');
      lines.push(
        `*${r.pair.toUpperCase()}* — ${r.confluence.score}/100 — ${signal}`,
        `  ${a?.bias ?? '?'} · ${r.confluence.regime}` +
          (a?.indicators.momentum.rsi14 != null ? ` · RSI ${a.indicators.momentum.rsi14.toFixed(0)}` : ''),
      );
      if (r.confluence.blockers.length) {
        lines.push(`  ⛔ ${r.confluence.blockers[0]}`);
      }
      lines.push('');
    }

    lines.push('_Skor adalah nilai kualitas rule engine, bukan peluang profit._');
    return lines.join('\n');
  }

  /** Kesehatan komponen operasional. */
  private async healthStatus(): Promise<string> {
    const h = await this.health.check();
    const icon = (s: string) => (s === 'OK' ? '🟢' : s === 'DEGRADED' ? '🟡' : s === 'UNKNOWN' ? '⚪' : '🔴');

    return [
      `${icon(h.overall)} *KESEHATAN SISTEM: ${h.overall}*`,
      '',
      ...h.components.map((c) => `${icon(c.status)} ${c.component}: ${c.label}\n    _${c.detail}_`),
      '',
      `Detak jantung: ${h.heartbeatAgeSeconds} detik lalu`,
      `Uptime: ${Math.round(h.uptimeSeconds / 60)} menit`,
    ].join('\n');
  }

  /** Jalankan pemulihan posisi berstatus FAILED. */
  private async recoverFailed(): Promise<string> {
    const report = await this.recovery.recover();

    if (!report.results.length) {
      return '✅ Tidak ada posisi yang perlu dipulihkan.';
    }

    return [
      '♻️ *HASIL PEMULIHAN*',
      '',
      `Diperiksa: ${report.results.length} posisi`,
      '',
      ...report.results.map((r) => `• #${r.tradeId} ${r.pair.toUpperCase()} — *${r.outcome}*\n    _${r.detail}_`),
      '',
      report.needsAttention
        ? '⚠️ Masih ada posisi yang butuh tindakan manual. Entry baru tetap ditahan.'
        : '✅ Semua posisi sudah selaras kembali.',
    ].join('\n');
  }

  // ─── Berita & pasar global ────────────────────────────────────────────────

  /**
   * Berita beserta sentimennya.
   *
   * Setiap berita selalu dibawa bersama PENERBIT dan UMURnya. Tanpa keduanya
   * operator tidak bisa menilai apakah sebuah judul layak dipercaya, dan
   * ringkasan sentimen berubah menjadi angka tanpa asal yang bisa diperiksa.
   */
  /**
   * Apakah skor MI benar-benar meramalkan hasil?
   *
   * Dilaporkan sebagai PERTANYAAN TERBUKA, bukan sebagai temuan. Pada
   * walk-forward 16 Okt 2026 hubungannya tampak TERBALIK — bucket 80+
   * menghasilkan nol kemenangan dari delapan trade — tetapi peluang kejadian
   * itu pada win rate dasar ~37% adalah ~2,5%: mengusik, bukan bukti.
   *
   * Karena itu arah hubungan sengaja TIDAK ditampilkan sampai cukup trade per
   * bucket. Menampilkan arah dari sampel kecil adalah cara tercepat mengubah
   * ambang skor ke arah yang keliru.
   */
  /**
   * Ubah stop loss atau take profit posisi terbuka.
   *
   * Dibuat sebagai perintah berargumen, BUKAN tombol bertingkat. Harga adalah
   * angka bebas; menebaknya lewat tombol berarti menyediakan pilihan yang
   * sudah ditentukan, dan operator yang ingin angka di antaranya tidak
   * punya jalan.
   */
  private async editLevel(jenis: 'sl' | 'tp', args: string[]): Promise<string> {
    const nama = jenis === 'sl' ? 'stop loss' : 'take profit';

    if (args.length < 2) {
      return [
        `Pakai: /${jenis} <id> <harga>`,
        '',
        `Contoh: /${jenis} 3 1450`,
        '',
        '_Lihat nomor posisi di menu Portfolio._',
      ].join('\n');
    }

    const id = Number(args[0]);
    // Titik dan koma sama-sama diterima: operator Indonesia menulis keduanya.
    const harga = Number(String(args[1]).replace(/[^0-9.,]/g, '').replace(',', '.'));

    if (!Number.isInteger(id) || id <= 0) return `Nomor posisi tidak sah: ${args[0]}`;
    if (!(harga > 0)) return `Harga ${nama} tidak sah: ${args[1]}`;

    const r =
      jenis === 'sl'
        ? await this.levelEditor.setStopLoss(id, harga)
        : await this.levelEditor.setTakeProfit(id, harga);

    return r.ok ? r.message : `❌ ${r.message}`;
  }

  private async scoreReport(): Promise<string> {
    const a = await this.scoreAttribution.attribute();

    const lines = [
      '🎯 *SKOR vs HASIL*',
      '',
      `Mode: ${a.mode} · trade tertutup: ${a.totalClosed} · berskor: ${a.scored}`,
      '',
    ];

    if (!a.byScore.length) {
      lines.push(
        '_Belum ada trade tertutup yang menyimpan skor MI._',
        '',
        '_Angka ini terkumpul sendiri setiap kali posisi ditutup._',
      );
      return lines.join('\n');
    }

    lines.push('```', '  bucket    trade   win   expectancy    galat', '');
    for (const b of a.byScore) {
      const siap = b.trades >= a.minTradesPerBucket ? '*' : ' ';
      lines.push(
        `${siap} ${b.label.padEnd(8)} ${String(b.trades).padStart(5)} ${b.winRate.toFixed(0).padStart(4)}%  ` +
          `${(b.expectancyR >= 0 ? '+' : '') + b.expectancyR.toFixed(3)}R  ` +
          `+-${b.expectancyStdErrorR.toFixed(3)}`,
      );
    }
    lines.push('```', `_* = sudah mencapai ${a.minTradesPerBucket} trade_`, '');

    if (a.conclusive && a.direction) {
      const arti: Record<string, string> = {
        SEARAH: 'skor tinggi memang menghasilkan lebih baik — ambang layak dinaikkan',
        TERBALIK: 'skor tinggi menghasilkan LEBIH BURUK — lapisan MI bekerja melawan Anda',
        'TIDAK JELAS': 'skor tidak membedakan hasil — lapisan MI tidak menambah apa pun',
      };
      lines.push(`*Arah hubungan: ${a.direction}*`, `_${arti[a.direction]}_`, '');
    } else {
      lines.push('*Arah hubungan: BELUM BISA DISIMPULKAN*', '');
    }

    lines.push(`_${a.caveat}_`);

    if (a.byRegime.length) {
      lines.push('', '*Per kondisi pasar:*', '```');
      for (const r of a.byRegime) {
        lines.push(
          `  ${r.label.padEnd(14)} ${String(r.trades).padStart(4)} trade  ` +
            `${(r.expectancyR >= 0 ? '+' : '') + r.expectancyR.toFixed(3)}R`,
        );
      }
      lines.push('```');
    }

    return lines.join('\n');
  }

  private async newsReport(args: string[]): Promise<string> {
    const coinArg = (args[0] ?? '').toLowerCase().replace(/idr$/, '');
    const forCoin = /^[a-z0-9]{2,12}$/.test(coinArg);

    const a = forCoin
      ? await this.news.assessCoin(coinArg)
      : await this.news.assessMarket(this.coinUniverse());

    const judul = forCoin ? `📰 *BERITA ${coinArg.toUpperCase()}*` : '📰 *BERITA PASAR*';

    if (a.inconclusive) {
      return [
        judul,
        '',
        '⚪ *Tidak ada berita berarah* dalam 2 hari terakhir.',
        '',
        'Perlu dicatat: ini berarti *belum diketahui*, bukan',
        'berarti kondisinya aman.',
      ].join('\n');
    }

    // Satu kalimat yang menerjemahkan angka menjadi arti. Tanpa ini "skor 46"
    // tidak memberi tahu apa pun kepada orang yang membacanya di ponsel.
    const arti =
      a.score >= 65
        ? 'Beritanya cenderung *mendukung harga*.'
        : a.score >= 55
          ? 'Beritanya sedikit condong positif.'
          : a.score > 45
            ? 'Beritanya *berimbang* — tidak condong ke mana pun.'
            : a.score > 35
              ? 'Beritanya sedikit condong negatif.'
              : 'Beritanya cenderung *menekan harga*.';

    const dampak =
      a.impact === 'HIGH'
        ? '🔴 besar — ada berita kebijakan, regulasi, atau keamanan'
        : a.impact === 'MEDIUM'
          ? '🟡 sedang'
          : '⚪ kecil';

    const lines = [
      judul,
      '',
      `${dot(a.sentiment)} *${skorBar(a.score)}* ${a.score}/100`,
      arti,
      '',
      '```',
      `  positif  ${String(a.positiveCount).padStart(3)}`,
      `  negatif  ${String(a.negativeCount).padStart(3)}`,
      `  netral   ${String(a.neutralCount).padStart(3)}`,
      '```',
      `Bobot pengaruh: ${dampak}`,
    ];

    const berarah = a.items.filter((i) => i.sentiment !== 'NEUTRAL').slice(0, 5);
    if (berarah.length) {
      lines.push('', '*Berita yang berarah:*');
      for (const item of berarah) {
        lines.push(
          `${item.sentiment === 'POSITIVE' ? '🟢' : '🔴'} ${escapeMarkdown(item.title.slice(0, 85))}`,
          `    _${escapeMarkdown(item.publisher)} · ${umur(item.ageHours)}_`,
        );
      }
    }

    lines.push(
      '',
      '⚠️ Sentimen dihitung dari judul, bukan dari isi berita.',
      'Dipakai untuk *menahan* entry, bukan alasan membeli.',
    );
    return lines.join('\n');
  }

  /** Dasbor pasar global beserta skor risikonya. */
  private async globalReport(): Promise<string> {
    const g = await this.globalMarket.assess();

    if (g.inconclusive) {
      return [
        '🌎 *PASAR GLOBAL*',
        '',
        '⚪ *Belum bisa disimpulkan.*',
        '',
        g.staleCount
          ? `${g.staleCount} pasar sedang tutup, jadi datanya tidak`
          : `${g.unavailable.length} sumber gagal diambil, jadi datanya tidak`,
        'cukup untuk menilai kondisi sekarang.',
        '',
        'Crypto jalan 24 jam, bursa saham tidak — jadi di',
        'akhir pekan kondisi ini normal.',
      ].join('\n');
    }

    const label =
      g.regime === 'RISK_ON'
        ? '🟢 *MENDUKUNG RISIKO*'
        : g.regime === 'RISK_OFF'
          ? '🔴 *MENEKAN RISIKO*'
          : '🟡 *CAMPUR*';

    const penjelasan =
      g.regime === 'RISK_ON'
        ? ['Bursa saham naik dan ketakutan investor turun.', 'Kondisi begini biasanya ikut mengangkat crypto.']
        : g.regime === 'RISK_OFF'
          ? ['Investor menghindari aset berisiko. Crypto biasanya', 'ikut tertekan dalam kondisi seperti ini.']
          : ['Sinyalnya bertentangan — sebagian mendukung,', 'sebagian menekan. Tidak ada arah yang jelas.'];

    // Blok monospace dipakai untuk tabel karena di font biasa Telegram spasi
    // TIDAK merapikan kolom — angkanya jadi berantakan.
    const rows = g.quotes.map((q) => {
      const nama = q.label.replace(/\s*\(.*\)/, '').slice(0, 15);
      const persen = `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`.replace('.', ',');
      if (q.stale) return `  ${nama.padEnd(15)} ${persen.padStart(7)}  ⚫ tutup`;
      return `  ${nama.padEnd(15)} ${persen.padStart(7)}  ${artiArah(q.symbol, q.changePercent)}`;
    });

    const lines = [
      '🌎 *PASAR GLOBAL*',
      '',
      `${label} — ${g.score} dari 100`,
      '',
      ...penjelasan,
      '',
      '```',
      ...rows,
      '```',
    ];

    if (g.drivers.length) lines.push(`*Yang menekan:* ${g.drivers.join(' · ')}`);
    if (g.staleCount) lines.push(`_${g.staleCount} pasar tutup, tidak ikut dihitung._`);
    if (g.unavailable.length) lines.push(`_Gagal diambil: ${g.unavailable.length} sumber._`);

    lines.push(
      '',
      '⚠️ Hubungan crypto dengan saham dan dolar tidak',
      'selalu sama. Skor ini dipakai untuk *menahan* entry',
      'saat kondisi jelas buruk — bukan alasan membeli.',
    );
    return lines.join('\n');
  }

  /**
   * Tanya bebas ke AI Analyst.
   *
   * Tidak ada format yang harus diingat operator — pertanyaannya ditulis biasa.
   */
  private async askAnalyst(args: string[]): Promise<string> {
    const pertanyaan = args.join(' ').trim();

    if (!pertanyaan) {
      return [
        '🧠 *TANYA ANALIS*',
        '',
        'Tulis pertanyaannya langsung, tanpa format khusus:',
        '',
        '  `/ask kenapa BTC turun?`',
        '  `/ask SOL bagus buat masuk sekarang?`',
        '  `/ask kondisi pasar hari ini gimana`',
        '  `/ask apa yang nahan bot gak buka posisi`',
        '',
        this.analyst.isEnabled()
          ? '_AI aktif._'
          : '_AI belum aktif — jawaban berupa ringkasan data. Isi *AI_PROVIDER* di .env untuk jawaban bahasa biasa._',
      ].join('\n');
    }

    const answer = await this.analyst.ask(pertanyaan);

    const header = answer.fallback ? '🧠 *RINGKASAN DATA*' : '🧠 *ANALIS*';
    const footer = answer.dataUsed.length ? `\n\n_Dari: ${answer.dataUsed.join(', ')}_` : '';

    return `${header}\n\n${answer.text}${footer}`;
  }

  /**
   * Buka menu bertombol.
   *
   * Balasannya kosong karena menunya dikirim sebagai pesan tersendiri yang
   * membawa papan tombol — mengirim teks tambahan hanya akan menggandakan
   * isinya tepat di atas menu.
   */
  private async openMenu(): Promise<string> {
    await this.menuUi.send();
    return '';
  }

  /**
   * Cari peluang sekarang, tanpa menunggu putaran 15 menit.
   *
   * Tawaran dikirim sebagai pesan terpisah bertombol, jadi balasan perintah ini
   * hanya ringkasan apa yang terjadi — termasuk pair yang DILEWATI dan
   * sebabnya. Tanpa itu, "tidak ada peluang" tidak bisa dibedakan dari
   * "scanner-nya rusak".
   */
  private async findOpportunities(): Promise<string> {
    const r = await this.opportunities.findAndOffer();

    const lines = ['🎯 *PEMERIKSAAN PELUANG*', ''];

    if (r.offered.length) {
      lines.push(
        `Dikirim ${r.offered.length} tawaran: ${r.offered.map((p) => p.toUpperCase()).join(', ')}`,
        '',
        '_Lihat pesan di bawah, lengkap dengan tombol._',
      );
    } else {
      /**
       * Corong ditampilkan utuh, bukan satu angka.
       *
       * "Lolos ambang skor: 0 pair" dengan ambang 70 TERBACA SALAH ketika ada
       * pair berskor 70 di menu lain — dan itu memang terjadi pada STRKIDR.
       * Angka lamanya dihitung setelah penyaring keputusan, sehingga labelnya
       * menjanjikan hal yang tidak diukurnya.
       */
      const f = r.funnel;
      lines.push(
        `Tidak ada yang layak ditawarkan.`,
        '',
        '*Corong penyaring:*',
        `  ${f.totalHits} kondisi terpantau`,
        `  ${f.passedScore} lolos skor >= ${f.minScore}`,
        `  ${f.passedDecision} lolos keputusan (bukan NO_TRADE)`,
        `  *${f.passedBoth} lolos keduanya* -> yang ditawarkan`,
      );

      if (f.passedScore > 0 && f.passedDecision === 0) {
        lines.push(
          '',
          `_${f.passedScore} pair skornya cukup, tetapi SEMUANYA punya aturan_`,
          `_yang menolak — bukan karena skornya kurang. Pakai /market_`,
          `_untuk melihat skor, dan /analyze <pair> untuk sebab penolakannya._`,
        );
      }
      if (r.skipped.length) {
        lines.push('', '*Dilewati:*', ...r.skipped.slice(0, 8).map((s) => `  • ${s}`));
      }
      if (!r.considered && !r.skipped.length) {
        const min = this.config.params().opportunityMinScore;
        lines.push(
          '',
          `_Tidak ada pair yang mencapai skor ${min}. Itu normal — ambang ini_`,
          `_memang dibuat selektif. Pakai /market untuk melihat peringkat penuh._`,
        );
      }
    }

    lines.push(...this.setupSummary());

    return lines.join('\n');
  }

  /**
   * Keterangan tetap: strategi apa, risiko berapa, analisis apa.
   *
   * Ditampilkan pada SETIAP pemeriksaan peluang, termasuk yang kosong. Ketika
   * hasilnya kosong, pertanyaan pertama operator selalu "kosong menurut
   * ukuran siapa?" - dan tanpa jawabannya, hasil kosong terbaca seperti bot
   * yang menganggur, bukan bot yang menolak.
   *
   * Angkanya dibaca dari konfigurasi yang SAMA dengan yang dipakai mengambil
   * keputusan, bukan ditulis ulang di sini. Keterangan yang bisa menyimpang
   * dari perilaku sebenarnya lebih buruk daripada tidak ada keterangan.
   */
  private setupSummary(): string[] {
    const p = this.config.params();
    const mi = this.intelligenceConfig.params();

    return [
      '',
      '━━━━━━━━━━━━━━━━━━',
      '*Dinilai dengan apa*',
      '',
      // Dibaca dari registry, BUKAN dari env: kunci 'STRATEGY' tidak pernah
      // ada (yang benar ACTIVE_STRATEGY), sehingga baris ini dulu selalu
      // menampilkan "bawaan" dan tidak pernah menyebut strategi sebenarnya.
      `*Strategi:* ${this.strategies.active().name}`,
      `  EMA 5/13/21 + RSI + ADX, bar ${p.candleTimeframe} menit`,
      `  Konfirmasi tren HTF ${p.htfTimeframe} menit: ${p.requireHtfTrend ? 'wajib' : 'tidak'}`,
      '',
      '*Analisis:*',
      `  Multi-timeframe ${(mi.timeframes ?? []).join(', ')}`,
      '  8 dimensi: tren, struktur, momentum, volume,',
      '  support/resistance, volatilitas, order book, R:R',
      `  Gerbang FOMO: ${mi.fomoGuardEnabled ? 'aktif' : 'nonaktif'}`,
      '  Berita + makro: hanya boleh MENURUNKAN skor',
      '',
      '*Risk management:*',
      `  Risiko per trade: ${p.riskPerTradePercent}% ekuitas`,
      `  Maks porsi 1 posisi: ${p.maxPositionPercent}% ekuitas`,
      `  Stop: ${p.atrStopMultiplier}x ATR, dibatasi ${p.minStopPercent}%-${p.maxStopPercent}%`,
      `  Rugi harian maks: ${p.maxDailyLossPercent}% · drawdown maks: ${p.maxDrawdownPercent}%`,
      `  Rugi berurutan maks: ${p.maxConsecutiveLosses}x`,
      '',
      '*Ambang lolos:*',
      `  Skor minimum: ${p.opportunityMinScore}/100`,
      `  R:R minimum: 1 : ${mi.noTrade?.minRiskReward ?? '-'}`,
      `  ATR maksimum: ${mi.noTrade?.maxAtrPercent ?? '-'}%`,
      `  Biaya maks: ${mi.noTrade?.maxCostToAtrRatio ?? '-'}x gerakan per bar`,
      '',
      '_Skor adalah kualitas setup menurut aturan di atas —_',
      '_BUKAN peluang untung._',
    ];
  }

  /**
   * Dashboard: apa yang bisa dan LAYAK dibeli sekarang.
   *
   * Dua hal yang harus lolos, dan keduanya ditampilkan terpisah karena
   * tindakannya berbeda:
   *
   *   MODAL  — ukuran posisi di atas minimum exchange?  tidak -> tambah modal
   *   SINYAL — keputusan setup dan skor cukup?          tidak -> tunggu
   *
   * Versi pertama dashboard hanya memeriksa MODAL, lalu menandai pair sebagai
   * "MAMPU" dan mengirim tombol BUY untuknya — termasuk untuk pair yang
   * `/peluang` tidak akan pernah tawarkan karena keputusannya NO_TRADE.
   * Dua perintah yang menampilkan kesimpulan berbeda tentang pair yang sama
   * membuat keduanya tidak bisa dipercaya.
   *
   * Sekarang ambang penawarannya SAMA dengan `/peluang`: kartu bertombol hanya
   * dikirim untuk pair yang lolos modal DAN sinyal.
   */
  private async dashboard(): Promise<string> {
    const state = await this.portfolio.getState();
    const params = this.config.params();

    const scan = await this.opportunities.scanForDashboard();
    const checks = this.affordability.checkMany(
      scan.candidates.map((c) => ({ pair: c.pair, atrPercent: c.atrPercent })),
      state.equityIdr,
    );

    // Gabungkan kedua dimensi per pair.
    const rows = checks.map((c) => {
      const hit = scan.candidates.find((x) => x.pair === c.pair);
      const score = hit?.score ?? 0;
      const decision = hit?.decision ?? 'NO_TRADE';
      const isSetup = decision === 'TRADE_SETUP' || decision === 'HIGH_QUALITY_SETUP';
      const scoreOk = score >= params.opportunityMinScore;

      return {
        ...c,
        score,
        decision,
        signalOk: isSetup && scoreOk,
        signalReason: !isSetup
          ? `keputusan ${decision}`
          : !scoreOk
            ? `skor ${score} < ${params.opportunityMinScore}`
            : '',
      };
    });

    const siap = rows.filter((r) => r.status === 'MAMPU' && r.signalOk);
    const modalOkSinyalBelum = rows.filter((r) => r.status === 'MAMPU' && !r.signalOk);
    const modalBelum = rows.filter((r) => r.status !== 'MAMPU');

    const lines = [
      '📊 *DASHBOARD*',
      '',
      '```',
      `  Ekuitas   ${idr(state.equityIdr)}`,
      `  Kas       ${idr(state.cashIdr)}`,
      `  Posisi    ${state.openPositions}`,
      `  Risiko    ${idr(state.equityIdr * (params.riskPerTradePercent / 100))}/trade`,
      '```',
      `_Minimum order Indodax ${idr(10000)} · dipindai ${scan.scanned} pair_`,
      '',
      '*Dua syarat harus lolos:*',
      '  💰 MODAL — posisi di atas minimum exchange',
      '  📈 SINYAL — setup valid dan skor cukup',
      '',
    ];

    if (siap.length) {
      lines.push(`🟢 *SIAP BELI (${siap.length})*`, '');
      for (const r of siap) {
        lines.push(
          `*${r.pair.toUpperCase()}* — skor ${r.score}/100 · ${r.decision}`,
          '```',
          `  beli    ${idr(r.cappedIdr)}  (${r.equitySharePercent.toFixed(0)}% ekuitas)`,
          `  stop    ${r.stopPercent.toFixed(2)}%`,
          `  risiko  ${idr(r.riskIdr)}`,
          '```',
        );
      }
      lines.push('_Kartu bertombol dikirim menyusul._', '');
    } else {
      lines.push('⚪ *Belum ada yang siap dibeli.*', '');
    }

    if (modalOkSinyalBelum.length) {
      lines.push(`💰 *Modal cukup, sinyal belum (${modalOkSinyalBelum.length})*`);
      for (const r of modalOkSinyalBelum.slice(0, 6)) {
        lines.push(`• ${r.pair.toUpperCase()} — ${r.signalReason}`);
      }
      lines.push('_Tindakan: tunggu. Modalnya sudah cukup._', '');
    }

    if (modalBelum.length) {
      lines.push(`📉 *Modal belum cukup (${modalBelum.length})*`);
      for (const r of modalBelum.slice(0, 6)) {
        lines.push(
          `• ${r.pair.toUpperCase()} — butuh ${idr(r.minEquityNeededIdr)}`,
          `    _stop ${r.stopPercent.toFixed(2)}% → posisi hanya ${idr(r.cappedIdr)}_`,
        );
      }
      const termurah = Math.min(...modalBelum.map((r) => r.minEquityNeededIdr));
      if (Number.isFinite(termurah) && termurah > state.equityIdr) {
        lines.push('', `_Termurah butuh tambahan ${idr(termurah - state.equityIdr)}._`);
      }
      lines.push('');
    }

    if (!rows.length) {
      lines.push(
        '_Scanner tidak menemukan kandidat. Pakai /blockers untuk_',
        '_melihat filter mana yang menahan._',
      );
    }

    // Kartu HANYA untuk yang lolos kedua syarat — ambang yang sama dengan
    // /peluang, sehingga kedua perintah tidak pernah berbeda kesimpulan.
    for (const r of siap.slice(0, params.opportunityMaxPerScan)) {
      await this.sendDashboardCard(r.pair, r.score);
    }

    return lines.join('\n');
  }

  /**
   * Satu kartu: grafik, rencana lengkap, lalu tombol.
   *
   * Grafik dikirim lebih dulu dan kegagalannya TIDAK membatalkan kartunya —
   * keputusan beli tidak boleh hilang hanya karena penggambarnya bermasalah.
   */
  private async sendDashboardCard(pair: string, score: number): Promise<void> {
    try {
      const image = await this.charts.build(pair).catch(() => null);
      if (image) {
        const ticker = await this.indodax.getTicker(pair).catch(() => null);
        await this.notification.sendChart(
          image,
          `*${pair.toUpperCase()}*${ticker ? ` — Rp ${fmtPrice(ticker.last)}` : ''} · skor ${score}/100`,
        );
      }
      await this.opportunities.offerNow(pair, score);
    } catch (err) {
      this.logger.warn(`Kartu dashboard ${pair} gagal: ${(err as Error).message}`);
    }
  }

  /** Simbol koin dari pair yang ditradingkan: "btcidr" menjadi "btc". */
  private coinUniverse(): string[] {
    const coins = this.config
      .params()
      .tradingPairs.map((p) => p.toLowerCase().replace(/idr$/, ''));
    return coins.length ? [...new Set(coins)] : ['btc', 'eth'];
  }
}

/**
 * Judul berita datang dari sumber luar dan rutin memuat `*`, `_`, dan `[`.
 * Tanpa pelolosan, satu tanda bintang di judul merusak format seluruh pesan
 * dan Telegram menolak mengirimnya.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

function dot(sentiment: string): string {
  return sentiment === 'POSITIVE' ? '🟢' : sentiment === 'NEGATIVE' ? '🔴' : '⚪';
}

/** Umur berita dalam kata, bukan angka desimal yang perlu ditafsirkan. */
function umur(hours: number): string {
  if (hours < 1) return 'baru saja';
  if (hours < 24) return `${Math.round(hours)} jam lalu`;
  const hari = Math.round(hours / 24);
  return hari <= 1 ? 'kemarin' : `${hari} hari lalu`;
}

/**
 * Batang skor sederhana.
 *
 * Angka 0-100 sulit dirasakan sekilas; batang memberi gambaran posisinya
 * terhadap netral tanpa perlu membaca angkanya.
 */
function skorBar(score: number): string {
  const filled = Math.round((score / 100) * 10);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, 10 - filled));
}

/**
 * Terjemahkan arah pergerakan instrumen menjadi artinya bagi crypto.
 *
 * Dolar naik itu buruk untuk crypto, tetapi angka "+0,14%" terlihat seperti
 * kabar baik bagi siapa pun yang tidak hafal polaritas tiap instrumen.
 */
function artiArah(symbol: string, change: number): string {
  const inverse = symbol === 'DXY' || symbol === 'US10Y' || symbol === 'VIX' || symbol === 'OIL';
  const mendukung = inverse ? change < 0 : change > 0;
  if (Math.abs(change) < 0.05) return '⚪ datar';
  return mendukung ? '🟢 bagus' : '🔴 menekan';
}

/** Ikon tingkat keparahan untuk laporan rekonsiliasi. */
function severityIcon(severity: string): string {
  if (severity === 'CRITICAL') return '🚨';
  if (severity === 'HIGH') return '🔴';
  if (severity === 'MEDIUM') return '🟡';
  return '⚪';
}
