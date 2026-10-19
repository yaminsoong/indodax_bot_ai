import { Module } from '@nestjs/common';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { MarketIntelligenceModule } from '../market-intelligence/market-intelligence.module';
import { NotificationService } from './notification.service';
import { ChartRendererService } from './chart-renderer.service';
import { ChartBuilderService } from './chart-builder.service';
import { ScannerReportService } from './scanner-report.service';
import { OrderProgressService } from './order-progress.service';

@Module({
  imports: [IndodaxModule, IndicatorsModule, MarketIntelligenceModule],
  providers: [
    OrderProgressService,NotificationService, ChartRendererService, ChartBuilderService, ScannerReportService],
  exports: [
    OrderProgressService,NotificationService, ChartRendererService, ChartBuilderService, ScannerReportService],
})
export class NotificationModule {}
