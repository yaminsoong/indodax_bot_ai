import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { BacktestService } from './backtest.service';
import { OptimizerService, SweepSpec } from './optimizer.service';
import { BotConfigService, BotParams } from '../config/bot-config.service';
import { BacktestConfig } from './backtest.types';
import { ApiKeyGuard } from '../common/security/api-key.guard';

interface RunBacktestDto {
  pairs?: string[];
  timeframe?: number;
  bars?: number;
  initialCapital?: number;
  strategy?: string;
  slippagePercent?: number;
  spreadPercent?: number;
  feePercentOverride?: number;
  makerEntry?: boolean;
  makerOffsetPercent?: number;
  /** Aktifkan lapisan Market Intelligence; default mengikuti konfigurasi live. */
  useIntelligence?: boolean;
  paramOverrides?: Partial<BotParams>;
}

/**
 * Endpoint backtest.
 *
 * DILINDUNGI guard yang sama dengan dashboard. Sebelumnya seluruh controller
 * ini terbuka tanpa autentikasi: siapa pun yang bisa menjangkau port bot dapat
 * membaca parameter strategi sekaligus memaksa ratusan panggilan ke Indodax
 * lewat endpoint sweep — habisnya jatah rate limit membuat bot berhenti
 * menerima data pasar.
 */
@ApiTags('Backtest')
@ApiSecurity('x-api-key')
@UseGuards(ApiKeyGuard)
@Controller('api/backtest')
export class BacktestController {
  constructor(
    private readonly backtest: BacktestService,
    private readonly optimizer: OptimizerService,
    private readonly config: BotConfigService,
  ) {}

  private buildConfig(dto: RunBacktestDto): BacktestConfig {
    const params = this.config.params();
    return {
      pairs: dto.pairs?.length ? dto.pairs.map((p) => p.toLowerCase()) : params.tradingPairs,
      timeframe: dto.timeframe ?? params.candleTimeframe,
      bars: Math.min(dto.bars ?? 1000, 5000),
      initialCapital: dto.initialCapital ?? this.config.simulationCapitalIdr,
      strategy: dto.strategy ?? this.config.str('ACTIVE_STRATEGY', 'EMA_SCALPING_V2'),
      slippagePercent: dto.slippagePercent ?? 0.05,
      spreadPercent: dto.spreadPercent,
      useIntelligence: dto.useIntelligence,
      feePercentOverride: dto.feePercentOverride,
      // Default mengikuti konfigurasi bot agar backtest mencerminkan cara
      // eksekusi yang benar-benar dipakai saat live.
      makerEntry: dto.makerEntry ?? params.makerEntry,
      makerOffsetPercent: dto.makerOffsetPercent ?? params.makerOffsetPercent,
      paramOverrides: dto.paramOverrides,
    };
  }

  @Post('run')
  @ApiOperation({ summary: 'Jalankan backtest pada data historis' })
  async run(@Body() dto: RunBacktestDto = {}) {
    const report = await this.backtest.run(this.buildConfig(dto));
    return {
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      barsTested: report.barsTested,
      metrics: report.metrics,
      warnings: report.warnings,
      // Daftar trade penuh dipotong agar respons tetap wajar.
      recentTrades: report.trades.slice(-50),
      equityCurve: report.equityCurve.filter((_, i) => i % Math.ceil(report.equityCurve.length / 300 || 1) === 0),
    };
  }

  @Post('sweep')
  @ApiOperation({ summary: 'Uji beberapa kombinasi parameter sekaligus' })
  async sweep(@Body() dto: RunBacktestDto & { specs?: SweepSpec[] } = {}) {
    const specs: SweepSpec[] = dto.specs?.length
      ? dto.specs
      : [
          { param: 'minAdx', values: [15, 20, 25, 30] },
          { param: 'atrStopMultiplier', values: [1.0, 1.5, 2.0] },
          { param: 'atrTargetMultiplier', values: [2.0, 3.0, 4.0] },
        ];

    return this.optimizer.sweep(this.buildConfig(dto), specs);
  }

  @Post('walk-forward')
  @ApiOperation({ summary: 'Validasi walk-forward — deteksi overfitting' })
  async walkForward(
    @Body() dto: RunBacktestDto & { specs?: SweepSpec[]; windows?: number } = {},
  ) {
    const specs: SweepSpec[] = dto.specs?.length
      ? dto.specs
      : [
          { param: 'minAdx', values: [18, 22, 26] },
          { param: 'atrTargetMultiplier', values: [2.0, 3.0, 4.0] },
        ];

    return this.optimizer.walkForward(this.buildConfig(dto), specs, dto.windows ?? 4);
  }

  @Get('history')
  @ApiOperation({ summary: 'Riwayat backtest yang pernah dijalankan' })
  async history(@Query('limit') limit = '20') {
    return this.backtest.getHistory(parseInt(limit, 10));
  }
}
