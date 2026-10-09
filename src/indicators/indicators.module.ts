import { Module } from '@nestjs/common';
import { TechnicalService } from './technical.service';

@Module({
  providers: [TechnicalService],
  exports: [TechnicalService],
})
export class IndicatorsModule {}
