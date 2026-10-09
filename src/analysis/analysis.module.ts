import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyAnalysis } from '../database/entities/analysis.entity';
import { IndodaxModule } from '../indodax/indodax.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategyModule } from '../strategy/strategy.module';
import { NotificationModule } from '../notification/notification.module';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DailyAnalysis]),
    IndodaxModule,
    IndicatorsModule,
    StrategyModule,
    NotificationModule,
  ],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
