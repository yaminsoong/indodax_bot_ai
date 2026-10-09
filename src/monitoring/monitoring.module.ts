import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from '../database/entities/trade.entity';
import { IndodaxModule } from '../indodax/indodax.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradingModule } from '../trading/trading.module';
import { NotificationModule } from '../notification/notification.module';
import { MarketIntelligenceModule } from '../market-intelligence/market-intelligence.module';
import { HealthService } from './health.service';

/**
 * Pemantauan operasional.
 *
 * Dipisahkan dari TradingModule dengan sengaja: pemantauan hanya MEMBACA
 * keadaan dan tidak pernah mengubah posisi. Kalau kedua tanggung jawab itu
 * disatukan, cepat atau lambat pemeriksa kesehatan akan ikut "memperbaiki"
 * sesuatu di jalur trading.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Trade]),
    IndodaxModule,
    StrategyModule,
    TradingModule,
    NotificationModule,
    MarketIntelligenceModule,
  ],
  providers: [HealthService],
  exports: [HealthService],
})
export class MonitoringModule {}
