import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from '../database/entities/trade.entity';
import { NotificationModule } from './notification.module';
import { TradingModule } from '../trading/trading.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketIntelligenceModule } from '../market-intelligence/market-intelligence.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { IndodaxModule } from '../indodax/indodax.module';
import { TelegramCommandService } from './telegram-command.service';
import { TradeConfirmService } from './trade-confirm.service';
import { OpportunityWatcherService } from './opportunity-watcher.service';
import { NewsModule } from '../news/news.module';
import { GlobalMarketModule } from '../global-market/global-market.module';
import { AnalystModule } from '../analyst/analyst.module';

/**
 * Dipisahkan dari NotificationModule agar tidak terjadi dependensi melingkar:
 * TradingModule membutuhkan NotificationModule, sedangkan handler perintah
 * membutuhkan TradingModule.
 */
@Module({
  imports: [
    // Pengawas peluang memeriksa posisi terbuka sebelum menawarkan.
    TypeOrmModule.forFeature([Trade]),
    NewsModule,
    GlobalMarketModule,
    AnalystModule,
    NotificationModule,
    TradingModule,
    AnalysisModule,
    StrategyModule,
    MarketIntelligenceModule,
    MonitoringModule,
    // Perintah /chart memeriksa pair dan timeframe lewat IndodaxService.
    IndodaxModule,
  ],
  providers: [TelegramCommandService, TradeConfirmService, OpportunityWatcherService],
  exports: [TradeConfirmService, OpportunityWatcherService],
})
export class TelegramCommandModule {}
