import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/security/api-key.guard';
import { BotConfigService } from '../config/bot-config.service';
import { MarketIntelligenceService } from './market-intelligence.service';
import { MarketIntelligenceConfigService } from './mi-config.service';
import { SignalAuditService } from './signal-audit.service';
import { ScannerFilter, SignalScannerService } from './scanner/signal-scanner.service';
import { TradeDirection } from './market-intelligence.types';
import { formatPair } from './signal-explainer.service';

/**
 * API Market Intelligence.
 *
 * SELURUHNYA hanya-baca terhadap keadaan trading: tidak ada satu pun endpoint
 * di sini yang bisa membuka atau menutup posisi. Analisis tetap terpisah dari
 * eksekusi, termasuk di lapisan HTTP.
 *
 * Kontrak API yang sudah ada tidak disentuh — seluruh rute di bawah ini baru,
 * berada di bawah prefiks `/api/intelligence`.
 */
@ApiTags('Market Intelligence')
@ApiSecurity('x-api-key')
@UseGuards(ApiKeyGuard)
@Controller('api/intelligence')
export class MarketIntelligenceController {
  constructor(
    private readonly intelligence: MarketIntelligenceService,
    private readonly miConfig: MarketIntelligenceConfigService,
    private readonly signalAudit: SignalAuditService,
    private readonly scanner: SignalScannerService,
    private readonly config: BotConfigService,
  ) {}

  // --- Analisis ------------------------------------------------------------

  @Get('analyze/:pair')
  @ApiOperation({ summary: 'Analisis lengkap satu pair (multi-timeframe)' })
  async analyze(@Param('pair') pair: string, @Query('direction') direction?: string) {
    const report = await this.intelligence.analyze(pair.toLowerCase(), {
      direction: (direction?.toUpperCase() as TradeDirection) ?? 'LONG',
      atrStopMultiplier: this.config.params().atrStopMultiplier,
    });

    return {
      pair: report.pair,
      asOf: new Date(report.mtf.asOf * 1000).toISOString(),
      score: report.confluence.score,
      decision: report.confluence.decision,
      direction: report.confluence.direction,
      executable: report.confluence.executable,
      regime: report.confluence.regime,
      breakdown: report.confluence.breakdown,
      dimensions: report.confluence.dimensions,
      setup: report.confluence.setup,
      blockers: report.confluence.blockers,
      riskFactors: report.confluence.riskFactors,
      alignment: report.mtf.alignment,
      missingTimeframes: report.mtf.missing,
      explanation: report.explanation,
    };
  }

  @Get('analyze/:pair/explain')
  @ApiOperation({ summary: 'Penjelasan sinyal dalam bentuk teks siap baca' })
  async explain(@Param('pair') pair: string, @Query('direction') direction?: string) {
    const report = await this.intelligence.analyze(pair.toLowerCase(), {
      direction: (direction?.toUpperCase() as TradeDirection) ?? 'LONG',
      atrStopMultiplier: this.config.params().atrStopMultiplier,
    });
    return { text: report.explanation.text, ...report.explanation };
  }

  @Get('timeframes/:pair')
  @ApiOperation({ summary: 'Rincian per timeframe: bias, regime, struktur, zona' })
  async timeframes(@Param('pair') pair: string) {
    const report = await this.intelligence.analyze(pair.toLowerCase());
    const out: Record<string, any> = {};

    for (const [tf, a] of Object.entries(report.mtf.timeframes)) {
      if (!a) continue;
      out[tf] = {
        role: a.role,
        bars: a.bars,
        barTime: new Date(a.barTime * 1000).toISOString(),
        bias: a.bias,
        biasConfidence: a.biasConfidence,
        biasReasons: a.biasReasons,
        regime: a.regime.regime,
        regimeConfidence: a.regime.confidence,
        regimeEvidence: a.regime.evidence,
        volatility: a.regime.volatility,
        structureTrend: a.structure?.trend ?? null,
        recentEvents: (a.structure?.events ?? []).slice(-8),
        zones: a.levels?.zones ?? [],
        nearestSupport: a.levels?.nearestSupport ?? null,
        nearestResistance: a.levels?.nearestResistance ?? null,
        indicators: a.indicators,
      };
    }

    return { pair: report.pair, alignment: report.mtf.alignment, timeframes: out };
  }

  // --- Market overview (bagian 17 spesifikasi) -----------------------------

  @Get('overview')
  @ApiOperation({ summary: 'Ringkasan pasar: harga, tren, regime, skor, sinyal' })
  async overview(@Query('pairs') pairs?: string) {
    const list = pairs
      ? pairs.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
      : this.config.params().tradingPairs;

    const reports = await this.intelligence.analyzeMany(list);

    return reports.map((report) => {
      const a = report.mtf.timeframes[report.confluence.timeframe];
      const structure = a?.structure?.latest.BOS ?? a?.structure?.latest.CHOCH;

      return {
        pair: formatPair(report.pair),
        pairId: report.pair,
        price: a?.indicators.price.close ?? null,
        trend: a?.bias ?? 'UNKNOWN',
        regime: report.confluence.regime,
        structure: structure ? `${structure.type} ${structure.direction}` : (a?.structure?.trend ?? 'UNKNOWN'),
        rsi: a?.indicators.momentum.rsi14 ?? null,
        relativeVolume: a?.indicators.volume.relativeVolume ?? null,
        atrPercent: a?.indicators.volatility.atrPercent ?? null,
        volatility: a?.regime.volatility ?? null,
        score: report.confluence.score,
        signal: report.confluence.blockers.length ? 'NO_TRADE' : report.confluence.decision,
        riskReward: report.confluence.setup?.riskReward ?? null,
        blockers: report.confluence.blockers,
      };
    });
  }

  // --- Scanner (bagian 18 spesifikasi) -------------------------------------

  @Post('scan')
  @ApiOperation({
    summary: 'Pindai pasar. Tanpa daftar pair, scanner mencari sendiri dari seluruh pair IDR likuid',
  })
  async scan(@Body() filter: ScannerFilter = {}) {
    // Daftar pair yang kosong diteruskan apa adanya supaya scanner menjalankan
    // penyaringan likuiditasnya sendiri. Sebelumnya endpoint ini mengisi
    // kekosongan itu dengan TRADING_PAIRS, sehingga "pindai pasar" sebenarnya
    // hanya memeriksa tiga pair yang sudah ditentukan — persis kebalikan dari
    // gunanya scanner.
    return this.scanner.scan(
      filter.pairs?.length
        ? { ...filter, pairs: filter.pairs.map((p) => p.toLowerCase()) }
        : filter,
    );
  }

  // --- Audit sinyal (bagian 13 spesifikasi) --------------------------------

  @Get('signals')
  @ApiOperation({ summary: 'Riwayat analitis: setiap keputusan beserta alasannya' })
  async signals(@Query('limit') limit = '50', @Query('pair') pair?: string) {
    return this.signalAudit.recent(parseInt(limit, 10), pair?.toLowerCase());
  }

  @Get('signals/distribution')
  @ApiOperation({ summary: 'Distribusi skor selama N hari terakhir' })
  async distribution(@Query('days') days = '30') {
    return this.signalAudit.scoreDistribution(parseInt(days, 10));
  }

  @Get('signals/blockers')
  @ApiOperation({ summary: 'Alasan penolakan yang paling sering muncul' })
  async blockers(@Query('days') days = '30') {
    return this.signalAudit.blockerStats(parseInt(days, 10));
  }

  // --- Konfigurasi ---------------------------------------------------------

  @Get('config')
  @ApiOperation({ summary: 'Parameter Market Intelligence yang berlaku' })
  async getConfig() {
    return {
      params: this.miConfig.params(),
      warnings: this.miConfig.warnings(),
      note:
        'Skor adalah QUALITY SCORE dari rule engine, BUKAN probabilitas profit. ' +
        'Validasi hubungan skor dengan hasil lewat walk-forward sebelum menaikkan ambang.',
    };
  }
}
