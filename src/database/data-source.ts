import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

import { Trade } from './entities/trade.entity';
import { Signal } from './entities/signal.entity';
import { DailyAnalysis } from './entities/analysis.entity';
import { BotConfig } from './entities/bot-config.entity';
import { EquitySnapshot } from './entities/equity-snapshot.entity';
import { AuditLog } from './entities/audit-log.entity';
import { BacktestResult } from './entities/backtest-result.entity';
import { SignalAnalysis } from './entities/signal-analysis.entity';

loadEnv();

export const ENTITIES = [
  Trade,
  Signal,
  DailyAnalysis,
  BotConfig,
  EquitySnapshot,
  AuditLog,
  BacktestResult,
  SignalAnalysis,
];

/**
 * DataSource untuk TypeORM CLI (menjalankan dan membuat migrasi).
 *
 * Aplikasi sendiri TIDAK memakai berkas ini — ia mengonfigurasi TypeORM lewat
 * `TypeOrmModule.forRoot` di AppModule. Keduanya sengaja menunjuk daftar
 * entity dan berkas migrasi yang sama, sehingga CLI dan runtime tidak pernah
 * melihat skema yang berbeda.
 *
 * Pemakaian:
 *   npm run migration:run      -- jalankan migrasi yang belum diterapkan
 *   npm run migration:revert   -- batalkan migrasi terakhir
 *   npm run migration:generate -- buat migrasi dari selisih entity vs database
 *
 * `synchronize` selalu false di sini: CLI migrasi tidak boleh mengubah skema
 * secara diam-diam.
 */
/**
 * Catatan: berkas ini harus mengekspor TEPAT SATU instance DataSource.
 * Menambah `export default AppDataSource` membuat CLI TypeORM menolaknya
 * dengan pesan "must contain only one export of DataSource instance".
 */
export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_PATH || 'trading-bot.db',
  entities: ENTITIES,
  /**
   * Hanya sumber TypeScript. CLI selalu dijalankan lewat ts-node, sehingga
   * menyertakan `dist/**` juga akan membuat setiap migrasi terbaca dua kali
   * dan ditolak dengan "Duplicate migrations". Runtime aplikasi memakai
   * globnya sendiri di AppModule yang menunjuk direktori hasil kompilasi.
   */
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});
