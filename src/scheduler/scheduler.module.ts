import { Module } from '@nestjs/common';
import { TradingModule } from '../trading/trading.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { NotificationModule } from '../notification/notification.module';
import { StrategyModule } from '../strategy/strategy.module';
import { IndodaxModule } from '../indodax/indodax.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [
    TradingModule,
    AnalysisModule,
    NotificationModule,
    StrategyModule,
    IndodaxModule,
    MonitoringModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
