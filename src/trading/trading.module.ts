import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from '../database/entities/trade.entity';
import { Signal } from '../database/entities/signal.entity';
import { EquitySnapshot } from '../database/entities/equity-snapshot.entity';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategyModule } from '../strategy/strategy.module';
import { NotificationModule } from '../notification/notification.module';
import { MarketIntelligenceModule } from '../market-intelligence/market-intelligence.module';
import { RiskService } from './risk.service';
import { TradingService } from './trading.service';
import { PortfolioService } from './portfolio.service';
import { ExecutionService } from './execution.service';
import { ReconciliationService } from './reconciliation.service';
import { RecoveryService } from './recovery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trade, Signal, EquitySnapshot]),
    IndodaxModule,
    IndicatorsModule,
    StrategyModule,
    NotificationModule,
    MarketIntelligenceModule,
  ],
  providers: [
    PortfolioService,
    RiskService,
    ExecutionService,
    ReconciliationService,
    RecoveryService,
    TradingService,
  ],
  exports: [TradingService, RiskService, PortfolioService, ReconciliationService, RecoveryService],
})
export class TradingModule {}
