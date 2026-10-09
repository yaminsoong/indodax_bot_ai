import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestResult } from '../database/entities/backtest-result.entity';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketIntelligenceModule } from '../market-intelligence/market-intelligence.module';
import { BacktestService } from './backtest.service';
import { OptimizerService } from './optimizer.service';
import { BacktestController } from './backtest.controller';
import { ApiKeyGuard } from '../common/security/api-key.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([BacktestResult]),
    IndodaxModule,
    IndicatorsModule,
    StrategyModule,
    MarketIntelligenceModule,
  ],
  providers: [BacktestService, OptimizerService, ApiKeyGuard],
  controllers: [BacktestController],
  exports: [BacktestService, OptimizerService],
})
export class BacktestModule {}
