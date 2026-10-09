import { Module } from '@nestjs/common';
import { TradingModule } from '../trading/trading.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategyModule } from '../strategy/strategy.module';
import { NotificationModule } from '../notification/notification.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { NewsModule } from '../news/news.module';
import { GlobalMarketModule } from '../global-market/global-market.module';
import { AiModule } from '../ai/ai.module';
import { AnalystModule } from '../analyst/analyst.module';
import { DashboardController } from './dashboard.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports: [
    TradingModule,
    AnalysisModule,
    IndodaxModule,
    IndicatorsModule,
    StrategyModule,
    MonitoringModule,
    // Endpoint scan-report memakai ScannerReportService.
    NotificationModule,
    // Endpoint /api/news dan /api/global-market.
    NewsModule,
    GlobalMarketModule,
    AiModule,
    AnalystModule,
  ],
  controllers: [DashboardController],
  providers: [ApiKeyGuard],
})
export class DashboardModule {}
