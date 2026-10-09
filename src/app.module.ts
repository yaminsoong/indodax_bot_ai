import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';

import { resolveTradingMode } from './common/live-mode';

import { Trade } from './database/entities/trade.entity';
import { Signal } from './database/entities/signal.entity';
import { DailyAnalysis } from './database/entities/analysis.entity';
import { BotConfig } from './database/entities/bot-config.entity';
import { EquitySnapshot } from './database/entities/equity-snapshot.entity';
import { AuditLog } from './database/entities/audit-log.entity';
import { BacktestResult } from './database/entities/backtest-result.entity';
import { SignalAnalysis } from './database/entities/signal-analysis.entity';

import { DatabaseModule } from './database/database.module';
import { BotConfigModule } from './config/bot-config.module';
import { IndodaxModule } from './indodax/indodax.module';
import { IndicatorsModule } from './indicators/indicators.module';
import { StrategyModule } from './strategy/strategy.module';
import { TradingModule } from './trading/trading.module';
import { AnalysisModule } from './analysis/analysis.module';
import { BacktestModule } from './backtest/backtest.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { NotificationModule } from './notification/notification.module';
import { TelegramCommandModule } from './notification/telegram-command.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MarketIntelligenceModule } from './market-intelligence/market-intelligence.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { NewsModule } from './news/news.module';
import { AiModule } from './ai/ai.module';
import { AnalystModule } from './analyst/analyst.module';
import { GlobalMarketModule } from './global-market/global-market.module';

/**
 * Apakah skema boleh disesuaikan otomatis dari entity.
 *
 * Mode LIVE dan NODE_ENV=production selalu memakai migrasi. Keputusan ini
 * dibuat sekali di sini supaya `synchronize` dan `migrationsRun` tidak pernah
 * menyala bersamaan — kombinasi itu membuat TypeORM mengubah skema lebih dulu,
 * lalu migrasi gagal karena perubahannya sudah terlanjur ada.
 */
const SYNCHRONIZE = (() => {
  // Nilai KOSONG diperlakukan sebagai "tidak disetel", bukan sebagai "nyala".
  //
  // `.env` memuat baris `DB_SYNCHRONIZE=` tanpa nilai. Dengan pemeriksaan
  // `!== undefined`, string kosong terbaca sebagai disetel dan `'' !== 'false'`
  // bernilai true — artinya produksi akan menyalakan `synchronize`, hal yang
  // justru diperingatkan di bawah karena bisa MENGHAPUS kolom berisi riwayat
  // trade. Saat ini urutan pemuatan menyelamatkannya secara kebetulan: const
  // ini dinilai sebelum ConfigModule membaca `.env`. Ketergantungan pada
  // kebetulan itu yang ditutup di sini.
  const override = (process.env.DB_SYNCHRONIZE ?? '').trim();
  if (override !== '') return override !== 'false';
  const live = resolveTradingMode((key) => process.env[key]).mode === 'LIVE';
  return !(live || process.env.NODE_ENV === 'production');
})();

const ENTITIES = [
  Trade,
  Signal,
  DailyAnalysis,
  BotConfig,
  EquitySnapshot,
  AuditLog,
  BacktestResult,
  SignalAnalysis,
];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),

    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DATABASE_PATH || 'trading-bot.db',
      entities: ENTITIES,
      migrations: [join(__dirname, 'database', 'migrations', '*{.ts,.js}')],
      /**
       * `synchronize` menyesuaikan skema otomatis dari entity. Praktis saat
       * pengembangan, tetapi di produksi ia bisa MENGHAPUS kolom hanya karena
       * entity-nya diubah — pada database yang berisi riwayat trade sungguhan,
       * itu kehilangan data yang tidak bisa dipulihkan.
       *
       * Karena itu ia dimatikan sendirinya pada mode LIVE dan
       * NODE_ENV=production, dan migrasi dijalankan sebagai gantinya.
       * DB_SYNCHRONIZE tetap bisa menimpa keputusan ini secara eksplisit,
       * untuk keadaan yang memang menuntutnya.
       */
      synchronize: SYNCHRONIZE,
      migrationsRun: !SYNCHRONIZE,
      logging: process.env.DB_LOGGING === 'true',
    }),

    DatabaseModule,
    BotConfigModule,
    IndodaxModule,
    IndicatorsModule,
    StrategyModule,
    MarketIntelligenceModule,
    AiModule,
    AnalystModule,
    NewsModule,
    GlobalMarketModule,
    NotificationModule,
    TradingModule,
    AnalysisModule,
    BacktestModule,
    MonitoringModule,
    SchedulerModule,
    TelegramCommandModule,
    DashboardModule,
  ],
})
export class AppModule {}
