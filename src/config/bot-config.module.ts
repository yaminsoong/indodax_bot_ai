import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotConfig } from '../database/entities/bot-config.entity';
import { BotConfigService } from './bot-config.service';
import { ConfigAuditService } from './config-audit.service';
import { TradingUniverseService } from './trading-universe.service';
import { IndodaxModule } from '../indodax/indodax.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BotConfig]), IndodaxModule],
  providers: [BotConfigService, ConfigAuditService, TradingUniverseService],
  exports: [BotConfigService, ConfigAuditService, TradingUniverseService],
})
export class BotConfigModule {}
