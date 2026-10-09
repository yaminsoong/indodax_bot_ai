import { Module } from '@nestjs/common';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EmaScalpingStrategy } from './ema-scalping.strategy';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import { DonchianBreakoutStrategy } from './donchian-breakout.strategy';
import { StrategyRegistry } from './strategy.registry';

@Module({
  imports: [IndicatorsModule],
  providers: [EmaScalpingStrategy, MeanReversionStrategy, DonchianBreakoutStrategy, StrategyRegistry],
  exports: [StrategyRegistry, EmaScalpingStrategy, MeanReversionStrategy, DonchianBreakoutStrategy],
})
export class StrategyModule {}
