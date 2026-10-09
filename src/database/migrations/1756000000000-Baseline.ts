import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Skema dasar seluruh tabel bot.
 *
 * Dibutuhkan karena versi sebelumnya membuat skema lewat `synchronize: true`,
 * sehingga tidak pernah ada migrasi yang membuat tabel inti. Tanpa berkas ini,
 * instalasi BARU dengan NODE_ENV=production (di mana synchronize dimatikan dan
 * migrasi dijalankan) akan gagal dengan "no such table: trades".
 *
 * Seluruh pernyataan memakai IF NOT EXISTS. Pada database yang sudah berjalan,
 * migrasi ini praktis tidak melakukan apa-apa selain mencatat dirinya sebagai
 * sudah dijalankan — persis yang diinginkan.
 */

export class Baseline1756000000000 implements MigrationInterface {
    name = 'Baseline1756000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "trades" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "pair" varchar NOT NULL, "type" text NOT NULL, "status" text NOT NULL, "mode" text NOT NULL, "strategy" text NOT NULL DEFAULT ('UNKNOWN'), "entryPrice" real NOT NULL, "signalPrice" real NOT NULL DEFAULT (0), "quantity" real NOT NULL, "remainingQuantity" real NOT NULL DEFAULT (0), "totalValue" real NOT NULL, "entryFee" real NOT NULL DEFAULT (0), "entryOrderId" varchar, "exitPrice" real, "exitFee" real NOT NULL DEFAULT (0), "exitOrderId" varchar, "profitLoss" real, "profitLossPercent" real, "rMultiple" real, "realizedPnl" real NOT NULL DEFAULT (0), "stopLossPrice" real NOT NULL, "takeProfitPrice" real NOT NULL, "trailingStopPrice" real, "initialRiskPerUnit" real NOT NULL DEFAULT (0), "riskAmountIdr" real NOT NULL DEFAULT (0), "breakEvenMoved" integer NOT NULL DEFAULT (0), "partialTaken" integer NOT NULL DEFAULT (0), "highestPrice" real NOT NULL DEFAULT (0), "lowestPrice" real NOT NULL DEFAULT (0), "closeReason" text, "signalData" text, "signalRef" text, "intelligenceScore" integer, "marketRegime" text, "signalAnalysisId" integer, "lastError" text, "closeAttempts" integer NOT NULL DEFAULT (0), "openedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_18c398cb81545a47837f47d82c" ON "trades" ("pair", "status") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_358b36d15b38834d8879b74fd0" ON "trades" ("status") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "signals" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "pair" varchar NOT NULL, "action" text NOT NULL, "strategy" text NOT NULL DEFAULT ('UNKNOWN'), "price" real NOT NULL, "ema5" real NOT NULL DEFAULT (0), "ema13" real NOT NULL DEFAULT (0), "ema21" real NOT NULL DEFAULT (0), "ema50" real NOT NULL DEFAULT (0), "rsi" real NOT NULL DEFAULT (0), "macdHistogram" real NOT NULL DEFAULT (0), "atr" real NOT NULL DEFAULT (0), "atrPercent" real NOT NULL DEFAULT (0), "adx" real NOT NULL DEFAULT (0), "choppiness" real NOT NULL DEFAULT (0), "volume" real NOT NULL DEFAULT (0), "volumeAvg" real NOT NULL DEFAULT (0), "trend" text NOT NULL DEFAULT ('NEUTRAL'), "regime" text NOT NULL DEFAULT ('RANGING'), "htfTrend" text NOT NULL DEFAULT ('UNKNOWN'), "orderBookImbalance" real NOT NULL DEFAULT (0), "strength" integer NOT NULL DEFAULT (0), "reason" text, "blockedBy" text, "executed" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_93bda0c1ede8aeea81f0b1fcc1" ON "signals" ("pair", "createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "daily_analysis" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "date" varchar NOT NULL, "topGainers" text NOT NULL, "topLosers" text NOT NULL, "marketSummary" text NOT NULL, "pairAnalysis" text NOT NULL, "totalProfit" real NOT NULL DEFAULT (0), "totalTrades" integer NOT NULL DEFAULT (0), "winTrades" integer NOT NULL DEFAULT (0), "lossTrades" integer NOT NULL DEFAULT (0), "winRate" real NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "bot_config" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "key" varchar NOT NULL, "value" text NOT NULL, "description" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_775a7f23b6ff82f5c3871ca7b47" UNIQUE ("key"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "equity_snapshots" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mode" text NOT NULL, "cashIdr" real NOT NULL, "positionsValueIdr" real NOT NULL, "equityIdr" real NOT NULL, "peakEquityIdr" real NOT NULL DEFAULT (0), "drawdownPercent" real NOT NULL DEFAULT (0), "openPositions" integer NOT NULL DEFAULT (0), "unrealizedPnl" real NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_c047b68d5f1b3f5478ecb976fe" ON "equity_snapshots" ("createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "audit_logs" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "category" text NOT NULL, "event" text NOT NULL, "pair" text, "tradeId" integer, "message" text, "data" text, "durationMs" integer NOT NULL DEFAULT (0), "isError" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_61995557e2d9b61ed5754232e1" ON "audit_logs" ("category", "createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "backtest_results" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "strategy" text NOT NULL, "pairs" text NOT NULL, "timeframe" integer NOT NULL, "periodStart" text NOT NULL, "periodEnd" text NOT NULL, "initialCapital" real NOT NULL, "finalEquity" real NOT NULL, "totalReturnPercent" real NOT NULL, "totalTrades" integer NOT NULL, "winRate" real NOT NULL, "profitFactor" real NOT NULL, "maxDrawdownPercent" real NOT NULL, "sharpeRatio" real NOT NULL, "expectancyR" real NOT NULL, "totalFees" real NOT NULL DEFAULT (0), "params" text NOT NULL, "report" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "signal_analysis" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "pair" varchar NOT NULL, "barTime" integer NOT NULL DEFAULT (0), "strategy" text NOT NULL DEFAULT ('UNKNOWN'), "timeframe" text NOT NULL DEFAULT ('1H'), "direction" text NOT NULL DEFAULT ('NONE'), "score" integer NOT NULL DEFAULT (0), "decision" text NOT NULL DEFAULT ('NO_TRADE'), "marketRegime" text NOT NULL DEFAULT ('SIDEWAYS'), "trendScore" real NOT NULL DEFAULT (0), "structureScore" real NOT NULL DEFAULT (0), "momentumScore" real NOT NULL DEFAULT (0), "volumeScore" real NOT NULL DEFAULT (0), "supportResistanceScore" real NOT NULL DEFAULT (0), "volatilityScore" real NOT NULL DEFAULT (0), "orderBookScore" real NOT NULL DEFAULT (0), "riskRewardScore" real NOT NULL DEFAULT (0), "entryPrice" real NOT NULL DEFAULT (0), "stopLoss" real NOT NULL DEFAULT (0), "takeProfit1" real NOT NULL DEFAULT (0), "takeProfit2" real NOT NULL DEFAULT (0), "takeProfit3" real NOT NULL DEFAULT (0), "riskReward" real NOT NULL DEFAULT (0), "atrPercent" real NOT NULL DEFAULT (0), "reasons" text, "blockers" text, "riskFactors" text, "context" text, "executed" integer NOT NULL DEFAULT (0), "tradeId" integer, "mode" text NOT NULL DEFAULT ('SIMULATION'), "observeOnly" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_7b99559dbe6b7dfb0c07cd03c1" ON "signal_analysis" ("score") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_aef4debbedc7ab3f71c6a0eae2" ON "signal_analysis" ("strategy", "decision") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_eccc366f542d5719ac8078dfb0" ON "signal_analysis" ("pair", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_eccc366f542d5719ac8078dfb0"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aef4debbedc7ab3f71c6a0eae2"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_7b99559dbe6b7dfb0c07cd03c1"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "signal_analysis"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "backtest_results"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_61995557e2d9b61ed5754232e1"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_c047b68d5f1b3f5478ecb976fe"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "equity_snapshots"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "bot_config"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "daily_analysis"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_93bda0c1ede8aeea81f0b1fcc1"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "signals"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_358b36d15b38834d8879b74fd0"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_18c398cb81545a47837f47d82c"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "trades"`);
    }

}
