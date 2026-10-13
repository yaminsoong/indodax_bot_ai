import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TradingService } from '../trading/trading.service';
import { PortfolioService } from '../trading/portfolio.service';
import { ReconciliationService } from '../trading/reconciliation.service';
import { RecoveryService } from '../trading/recovery.service';
import { HealthService } from '../monitoring/health.service';
import { AnalysisService } from '../analysis/analysis.service';
import { RiskService } from '../trading/risk.service';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { StrategyRegistry } from '../strategy/strategy.registry';
import { BotConfigService } from '../config/bot-config.service';
import { ConfigAuditService } from '../config/config-audit.service';
import { ScannerReportService } from '../notification/scanner-report.service';
import { NewsService } from '../news/news.service';
import { GlobalMarketService } from '../global-market/global-market.service';
import { AiService } from '../ai/ai.service';
import { AiAnalystService } from '../analyst/ai-analyst.service';
import { AffordabilityService } from '../trading/affordability.service';
import { OpportunityWatcherService } from '../notification/opportunity-watcher.service';
import { AuditService } from '../database/audit.service';
import { AuditCategory } from '../database/entities/audit-log.entity';
import { ApiKeyGuard } from './api-key.guard';

@ApiTags('Dashboard')
@ApiSecurity('x-api-key')
@UseGuards(ApiKeyGuard)
@Controller('api')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly trading: TradingService,
    private readonly portfolio: PortfolioService,
    private readonly reconciliation: ReconciliationService,
    private readonly recovery: RecoveryService,
    private readonly healthService: HealthService,
    private readonly analysis: AnalysisService,
    private readonly risk: RiskService,
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly strategies: StrategyRegistry,
    private readonly config: BotConfigService,
    private readonly configAudit: ConfigAuditService,
    private readonly scannerReport: ScannerReportService,
    private readonly news: NewsService,
    private readonly globalMarket: GlobalMarketService,
    private readonly ai: AiService,
    private readonly analyst: AiAnalystService,
    private readonly affordability: AffordabilityService,
    private readonly opportunities: OpportunityWatcherService,
    private readonly audit: AuditService,
  ) {}

  // ─── Status ───────────────────────────────────────────────────────────────

  @Get('status')
  @ApiOperation({ summary: 'Status bot, portofolio, dan risiko' })
  async getStatus() {
    const [state, daily, kill] = await Promise.all([
      this.portfolio.getState(),
      this.risk.getDailyStats(),
      this.risk.checkKillSwitch(),
    ]);

    return {
      status: kill.halted ? 'HALTED' : 'RUNNING',
      mode: this.config.mode,
      strategy: this.strategies.active().name,
      timestamp: new Date().toISOString(),
      haltReasons: kill.reasons,
      portfolio: {
        equity: Math.round(state.equityIdr),
        cash: Math.round(state.cashIdr),
        positionsValue: Math.round(state.positionsValueIdr),
        unrealizedPnl: Math.round(state.unrealizedPnl),
        drawdownPercent: Number(state.drawdownPercent.toFixed(2)),
        openPositions: state.openPositions,
        degraded: state.degraded,
      },
      today: daily,
      pairs: this.config.params().tradingPairs,
    };
  }

  @Get('portfolio')
  @ApiOperation({ summary: 'Rincian portofolio dan posisi terbuka' })
  async getPortfolio() {
    return this.portfolio.getState();
  }

  @Get('equity-curve')
  @ApiOperation({ summary: 'Kurva ekuitas dan drawdown' })
  async getEquityCurve(@Query('days') days = '30') {
    const [curve, dd] = await Promise.all([
      this.portfolio.getEquityCurve(parseInt(days, 10)),
      this.portfolio.getMaxDrawdown(parseInt(days, 10)),
    ]);
    return { points: curve, ...dd };
  }

  // ─── Trades ───────────────────────────────────────────────────────────────

  @Get('trades')
  @ApiOperation({ summary: 'Riwayat trade' })
  async getTrades(@Query('limit') limit = '50') {
    return this.trading.getTradeHistory(parseInt(limit, 10));
  }

  @Get('trades/open')
  @ApiOperation({ summary: 'Posisi terbuka' })
  async getOpenTrades() {
    return this.trading.getOpenTrades();
  }

  @Get('trades/failed')
  @ApiOperation({ summary: 'Trade yang gagal ditutup dan butuh penanganan manual' })
  async getFailedTrades() {
    return this.trading.getFailedTrades();
  }

  @Get('trades/performance')
  @ApiOperation({ summary: 'Ringkasan performa' })
  async getPerformance(@Query('strategy') strategy?: string) {
    return this.trading.getPerformanceSummary(strategy);
  }

  @Get('trades/compare-strategies')
  @ApiOperation({ summary: 'Perbandingan performa antar strategi' })
  async compareStrategies() {
    return this.trading.getStrategyComparison();
  }

  @Get('trades/breakdown')
  @ApiOperation({
    summary: 'Performa per regime pasar, bucket skor, dan strategi (dari trade nyata)',
  })
  async performanceBreakdown(@Query('strategy') strategy?: string) {
    return this.trading.getPerformanceBreakdown(strategy);
  }

  @Post('trades/:id/close')
  @ApiOperation({ summary: 'Tutup posisi secara manual' })
  async closeTrade(@Param('id') id: string) {
    return this.trading.manualCloseTrade(parseInt(id, 10));
  }

  @Post('trades/close-all')
  @ApiOperation({ summary: 'Tutup seluruh posisi (tombol darurat)' })
  async closeAll() {
    return this.trading.closeAllPositions('PANIC_CLOSE');
  }

  @Get('signals')
  @ApiOperation({ summary: 'Sinyal terbaru, termasuk alasan sinyal ditahan' })
  async getSignals(@Query('limit') limit = '50') {
    return this.trading.getRecentSignals(parseInt(limit, 10));
  }

  @Get('signals/blockers')
  @ApiOperation({
    summary: 'Filter mana yang paling sering menahan entry — untuk mendiagnosa bot yang pasif',
  })
  async getBlockers(@Query('hours') hours = '168') {
    return this.trading.getBlockerStats(parseInt(hours, 10));
  }

  // ─── Berita & pasar global ────────────────────────────────────────────────

  @Get('global-market')
  @ApiOperation({ summary: 'Kondisi pasar global dan Global Risk Score' })
  async getGlobalMarket(@Query('refresh') refresh = '') {
    return this.globalMarket.assess(refresh === 'true' || refresh === '1');
  }

  @Get('news')
  @ApiOperation({ summary: 'Berita pasar beserta sentimen dan dampaknya' })
  async getNews() {
    const pairs = this.config.params().tradingPairs;
    // Universe berupa simbol koin, bukan nama pair: "btcidr" -> "btc".
    const coins = [...new Set(pairs.map((p) => p.toLowerCase().replace(/idr$/, '')))];
    return this.news.assessMarket(coins.length ? coins : ['btc', 'eth']);
  }

  @Get('news/:coin')
  @ApiOperation({ summary: 'Berita khusus satu koin' })
  async getCoinNews(@Param('coin') coin: string) {
    const symbol = coin.toLowerCase().replace(/idr$/, '');
    if (!/^[a-z0-9]{2,12}$/.test(symbol)) {
      throw new BadRequestException(`Simbol koin tidak wajar: ${coin}`);
    }
    return this.news.assessCoin(symbol);
  }

  @Post('ask')
  @ApiOperation({ summary: 'Tanya bebas ke AI Analyst, dijawab dari data bot' })
  async ask(@Body() body: { question?: string }) {
    const q = (body?.question ?? '').trim();
    if (!q) throw new BadRequestException('Isi "question" dengan pertanyaannya');
    return this.analyst.ask(q);
  }

  @Get('affordability')
  @ApiOperation({
    summary: 'Pair mana yang benar-benar bisa dibeli dengan saldo sekarang',
  })
  async getAffordability() {
    const [state, scan] = await Promise.all([
      this.portfolio.getState(),
      this.opportunities.scanForDashboard(),
    ]);

    const checks = this.affordability.checkMany(
      scan.candidates.map((c) => ({ pair: c.pair, atrPercent: c.atrPercent })),
      state.equityIdr,
    );

    return {
      equityIdr: state.equityIdr,
      cashIdr: state.cashIdr,
      openPositions: state.openPositions,
      minOrderIdr: 10000,
      scanned: scan.scanned,
      // Skor ikut disertakan agar kelayakan modal dan kualitas sinyal bisa
      // dibaca bersamaan — keduanya harus lolos sebelum ada order.
      checks: checks.map((c) => ({
        ...c,
        score: scan.candidates.find((x) => x.pair === c.pair)?.score ?? null,
        decision: scan.candidates.find((x) => x.pair === c.pair)?.decision ?? null,
      })),
    };
  }

  @Get('ai/status')
  @ApiOperation({ summary: 'Penyedia AI aktif, pemakaian token, dan status istirahat' })
  getAiStatus() {
    return this.ai.status();
  }

  // ─── Kontrol ──────────────────────────────────────────────────────────────

  @Post('control/pause')
  @ApiOperation({ summary: 'Hentikan pembukaan posisi baru' })
  async pause() {
    await this.config.set('TRADING_ENABLED', 'false', 'Dijeda lewat dashboard');
    return { success: true, message: 'Pembukaan posisi baru dihentikan; posisi terbuka tetap dimonitor' };
  }

  @Post('control/resume')
  @ApiOperation({ summary: 'Aktifkan kembali pembukaan posisi' })
  async resume() {
    await this.config.set('TRADING_ENABLED', 'true', 'Diaktifkan lewat dashboard');
    const kill = await this.risk.checkKillSwitch();
    return { success: true, stillHalted: kill.halted, reasons: kill.reasons };
  }

  @Post('control/run-cycle')
  @ApiOperation({ summary: 'Jalankan satu siklus trading sekarang' })
  async runCycle() {
    await this.trading.runTradingCycle();
    return { success: true };
  }

  @Post('control/scan-report')
  @ApiOperation({
    summary: 'Pindai seluruh pair IDR likuid dan kirim peringkatnya ke Telegram',
  })
  async scanReport() {
    const result = await this.scannerReport.scanAndReport();
    return {
      success: true,
      pairsScanned: result.pairsScanned,
      prefilter: result.prefilter,
      ranking: [...result.overview]
        .sort((a, b) => b.score - a.score)
        .map((o) => ({ pair: o.pair, score: o.score, decision: o.decision, regime: o.regime })),
    };
  }

  @Post('control/reconcile')
  @ApiOperation({ summary: 'Cocokkan catatan bot dengan Indodax' })
  async reconcile() {
    return this.reconciliation.reconcile();
  }

  @Get('control/reconcile/last')
  @ApiOperation({ summary: 'Hasil rekonsiliasi terakhir' })
  async lastReconcile() {
    return this.reconciliation.getLastReport() ?? { message: 'Belum pernah dijalankan' };
  }

  /**
   * Jalankan pemulihan posisi yang gagal.
   *
   * Alur FAILED -> DETECT -> ALERT -> RECONCILE -> RECOVER / MANUAL.
   * Selama masih ada posisi FAILED, kill switch menahan seluruh entry baru.
   */
  @Post('control/recover')
  @ApiOperation({ summary: 'Pulihkan posisi berstatus FAILED atau yang menggantung' })
  async recover() {
    return this.recovery.recover();
  }

  @Get('control/recover/last')
  @ApiOperation({ summary: 'Hasil pemulihan terakhir' })
  async lastRecovery() {
    return this.recovery.getLastReport() ?? { message: 'Belum pernah dijalankan' };
  }

  // ─── Kesehatan sistem ─────────────────────────────────────────────────────

  @Get('health')
  @ApiOperation({ summary: 'Status seluruh komponen operasional' })
  async health() {
    return this.healthService.check();
  }

  // ─── Konfigurasi & strategi ───────────────────────────────────────────────

  @Get('config')
  @ApiOperation({ summary: 'Parameter aktif' })
  async getConfig() {
    return {
      mode: this.config.mode,
      activeStrategy: this.strategies.active().name,
      params: this.config.params(),
      overrides: this.config.listOverrides(),
    };
  }

  /**
   * Ubah parameter saat bot berjalan.
   *
   * Kunci rahasia (API key, secret, token) DITOLAK di sini — lihat
   * `BotConfigService.set`. Rahasia hanya boleh datang dari variabel
   * lingkungan, tidak pernah lewat jalur HTTP.
   */
  @Post('config')
  @ApiOperation({ summary: 'Ubah parameter saat bot berjalan' })
  async setConfig(@Body() body: { key: string; value: string; description?: string }) {
    if (!body?.key || body.value === undefined) {
      return { success: false, message: 'Butuh field key dan value' };
    }
    try {
      await this.config.set(body.key, String(body.value), body.description);
    } catch (err) {
      // Pesan penolakan rahasia memang ditujukan untuk operator - aman ditampilkan.
      throw new BadRequestException(err.message);
    }
    return { success: true, params: this.config.params() };
  }

  @Get('config/audit')
  @ApiOperation({
    summary: 'Audit .env: parameter mati, yang hilang, dan nilai yang bermasalah',
  })
  async auditConfig() {
    return this.configAudit.audit();
  }

  @Get('strategies')
  @ApiOperation({ summary: 'Daftar strategi yang tersedia' })
  async getStrategies() {
    return this.strategies.list();
  }

  @Post('strategies/:name/activate')
  @ApiOperation({ summary: 'Ganti strategi aktif' })
  async activateStrategy(@Param('name') name: string) {
    return this.strategies.setActive(name.toUpperCase());
  }

  // ─── Risiko ───────────────────────────────────────────────────────────────

  @Get('risk')
  @ApiOperation({ summary: 'Status kill switch dan sisa jatah risiko' })
  async getRisk() {
    const [kill, remaining, streak, dd] = await Promise.all([
      this.risk.checkKillSwitch(),
      this.risk.getRemainingDailyRisk(),
      this.risk.getConsecutiveLosses(),
      this.portfolio.getMaxDrawdown(),
    ]);
    return {
      halted: kill.halted,
      reasons: kill.reasons,
      remainingDailyRiskPercent: Number(remaining.toFixed(2)),
      consecutiveLosses: streak,
      ...dd,
      limits: this.config.params(),
    };
  }

  // ─── Analisis & pasar ─────────────────────────────────────────────────────

  @Get('analysis/latest')
  @ApiOperation({ summary: 'Analisis harian terakhir' })
  async getLatestAnalysis() {
    const data = await this.analysis.getLatestAnalysis();
    if (!data) return { message: 'Belum ada analisis' };
    return {
      id: data.id,
      date: data.date,
      createdAt: data.createdAt,
      topGainers: safeParse(data.topGainers),
      topLosers: safeParse(data.topLosers),
      marketSummary: safeParse(data.marketSummary),
      pairAnalysis: safeParse(data.pairAnalysis),
    };
  }

  @Get('analysis/history')
  @ApiOperation({ summary: 'Riwayat analisis' })
  async getAnalysisHistory(@Query('days') days = '7') {
    return this.analysis.getAnalysisHistory(parseInt(days, 10));
  }

  @Post('analysis/run')
  @ApiOperation({ summary: 'Jalankan analisis harian sekarang' })
  async runAnalysis() {
    const result = await this.analysis.runDailyAnalysis();
    return { success: true, analysisId: result.id };
  }

  @Get('scan/:pair')
  @ApiOperation({ summary: 'Analisis satu pair sekarang' })
  async scanPair(@Param('pair') pair: string) {
    const result = await this.analysis.analyzeNow(pair);
    return result ?? { error: 'Data tidak cukup atau pair tidak dikenal' };
  }

  @Get('market/summary')
  @ApiOperation({ summary: 'Ringkasan seluruh pair IDR dengan perubahan 24 jam' })
  async marketSummary(@Query('limit') limit = '30') {
    const market = await this.indodax.getMarketSummary();
    return market
      .filter((m) => m.volumeIdr >= 100_000_000)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, parseInt(limit, 10));
  }

  @Get('pairs')
  @ApiOperation({ summary: 'Metadata pair Indodax (tick, minimum, fee)' })
  async getPairs(@Query('q') q?: string) {
    const all = this.pairs.all().filter((p) => p.baseCurrency === 'idr');
    return q ? all.filter((p) => p.id.includes(q.toLowerCase())) : all.slice(0, 100);
  }

  /**
   * Saldo Indodax.
   *
   * Hanya ANGKA saldo yang dikembalikan. Kunci API dan secret tidak pernah
   * ikut dalam respons mana pun — `hasCredentials()` hanya menjawab ada atau
   * tidaknya kredensial, bukan isinya.
   *
   * Pesan galat mentah juga tidak diteruskan: respons Indodax bisa memuat
   * potongan permintaan berikut nonce dan nama kunci.
   */
  @Get('balance')
  @ApiOperation({ summary: 'Saldo Indodax' })
  async getBalance() {
    if (!this.indodax.hasCredentials()) {
      return { error: 'API key Indodax belum dikonfigurasi' };
    }
    try {
      return await this.indodax.getBalanceWithHold();
    } catch (err) {
      this.logger.error(`Gagal membaca saldo Indodax: ${err.message}`);
      return { error: 'Tidak bisa membaca saldo dari exchange. Periksa log server.' };
    }
  }

  @Get('ticker/:pair')
  @ApiOperation({ summary: 'Harga terkini' })
  async getTicker(@Param('pair') pair: string) {
    return this.indodax.getTicker(pair.toLowerCase());
  }

  // ─── Audit ────────────────────────────────────────────────────────────────

  @Get('audit')
  @ApiOperation({ summary: 'Jejak audit kejadian bot' })
  async getAudit(@Query('limit') limit = '100', @Query('category') category?: AuditCategory) {
    return this.audit.recent(parseInt(limit, 10), category);
  }

  @Get('audit/errors')
  @ApiOperation({ summary: 'Kejadian error terbaru' })
  async getAuditErrors(@Query('limit') limit = '50') {
    return this.audit.errors(parseInt(limit, 10));
  }
}

function safeParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
