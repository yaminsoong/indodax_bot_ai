import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SignalAnalysis } from '../database/entities/signal-analysis.entity';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { BotConfigModule } from '../config/bot-config.module';
import { NewsModule } from '../news/news.module';
import { GlobalMarketModule } from '../global-market/global-market.module';

import { IndicatorEngineService } from './indicators/indicator-engine.service';
import { StructureEngineService } from './structure/structure-engine.service';
import { SupportResistanceService } from './levels/support-resistance.service';
import { RegimeEngineService } from './regime/regime-engine.service';
import { MultiTimeframeService } from './mtf/multi-timeframe.service';
import { MarketDataProvider } from './mtf/market-data.provider';
import { ConfluenceEngineService } from './confluence/confluence-engine.service';
import { SignalExplainerService } from './signal-explainer.service';
import { MarketIntelligenceService } from './market-intelligence.service';
import { MarketIntelligenceConfigService } from './mi-config.service';
import { SignalAuditService } from './signal-audit.service';
import { StrategyGateService } from './strategy-gate.service';
import { SignalScannerService } from './scanner/signal-scanner.service';
import { MarketIntelligenceController } from './market-intelligence.controller';
import { CompositeScoreService } from './composite/composite-score.service';
import { FomoGuardService } from './fomo/fomo-guard.service';
import { ApiKeyGuard } from '../common/security/api-key.guard';

/**
 * Market Intelligence Engine.
 *
 * Modul ini SENGAJA tidak mengimpor TradingModule maupun ExecutionService.
 * Ketergantungannya hanya ke data pasar, indikator, dan konfigurasi - sehingga
 * secara struktural mustahil bagi lapisan analisis untuk mengirim order.
 * Arah ketergantungan berjalan satu arah: TradingModule memakai modul ini,
 * tidak sebaliknya.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SignalAnalysis]),
    IndodaxModule,
    IndicatorsModule,
    BotConfigModule,
    NewsModule,
    GlobalMarketModule,
  ],
  providers: [
    IndicatorEngineService,
    StructureEngineService,
    SupportResistanceService,
    RegimeEngineService,
    MultiTimeframeService,
    MarketDataProvider,
    ConfluenceEngineService,
    SignalExplainerService,
    MarketIntelligenceConfigService,
    MarketIntelligenceService,
    SignalAuditService,
    StrategyGateService,
    SignalScannerService,
    CompositeScoreService,
    FomoGuardService,
    ApiKeyGuard,
  ],
  controllers: [MarketIntelligenceController],
  exports: [
    MarketIntelligenceService,
    MarketIntelligenceConfigService,
    SignalAuditService,
    StrategyGateService,
    SignalScannerService,
    MarketDataProvider,
    MultiTimeframeService,
    ConfluenceEngineService,
    IndicatorEngineService,
    StructureEngineService,
    SupportResistanceService,
    RegimeEngineService,
    SignalExplainerService,
    CompositeScoreService,
    FomoGuardService,
  ],
})
export class MarketIntelligenceModule {}
