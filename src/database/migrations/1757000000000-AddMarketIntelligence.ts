import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Menambahkan skema Market Intelligence.
 *
 * Migrasi ini ditulis IDEMPOTEN — setiap perubahan diperiksa dulu dengan
 * `hasTable` / `hasColumn` sebelum dijalankan. Alasannya konkret: database
 * yang sudah berjalan dibuat oleh `synchronize: true`, sehingga sebagian
 * objek di sini bisa saja SUDAH ada sebelum migrasi pertama kali dijalankan.
 * Migrasi yang mengasumsikan database kosong akan langsung gagal di situ.
 *
 * Tidak ada data yang dihapus dan tidak ada kolom lama yang diubah tipenya:
 * seluruhnya penambahan. `down()` mengembalikan keadaan dengan membuang apa
 * yang ditambahkan, bukan dengan menulis ulang tabel.
 */
export class AddMarketIntelligence1757000000000 implements MigrationInterface {
  name = 'AddMarketIntelligence1757000000000';

  /** Kolom baru pada tabel trades. */
  private readonly tradeColumns: TableColumn[] = [
    new TableColumn({ name: 'signalRef', type: 'text', isNullable: true }),
    new TableColumn({ name: 'intelligenceScore', type: 'integer', isNullable: true }),
    new TableColumn({ name: 'marketRegime', type: 'text', isNullable: true }),
    new TableColumn({ name: 'signalAnalysisId', type: 'integer', isNullable: true }),
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    // --- Tabel signal_analysis ---------------------------------------------
    if (!(await queryRunner.hasTable('signal_analysis'))) {
      await queryRunner.createTable(
        new Table({
          name: 'signal_analysis',
          columns: [
            { name: 'id', type: 'integer', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
            { name: 'pair', type: 'varchar', isNullable: false },
            { name: 'barTime', type: 'integer', default: 0 },
            { name: 'strategy', type: 'text', default: "'UNKNOWN'" },
            { name: 'timeframe', type: 'text', default: "'1H'" },
            { name: 'direction', type: 'text', default: "'NONE'" },
            { name: 'score', type: 'integer', default: 0 },
            { name: 'decision', type: 'text', default: "'NO_TRADE'" },
            { name: 'marketRegime', type: 'text', default: "'SIDEWAYS'" },
            { name: 'trendScore', type: 'real', default: 0 },
            { name: 'structureScore', type: 'real', default: 0 },
            { name: 'momentumScore', type: 'real', default: 0 },
            { name: 'volumeScore', type: 'real', default: 0 },
            { name: 'supportResistanceScore', type: 'real', default: 0 },
            { name: 'volatilityScore', type: 'real', default: 0 },
            { name: 'orderBookScore', type: 'real', default: 0 },
            { name: 'riskRewardScore', type: 'real', default: 0 },
            { name: 'entryPrice', type: 'real', default: 0 },
            { name: 'stopLoss', type: 'real', default: 0 },
            { name: 'takeProfit1', type: 'real', default: 0 },
            { name: 'takeProfit2', type: 'real', default: 0 },
            { name: 'takeProfit3', type: 'real', default: 0 },
            { name: 'riskReward', type: 'real', default: 0 },
            { name: 'atrPercent', type: 'real', default: 0 },
            { name: 'reasons', type: 'text', isNullable: true },
            { name: 'blockers', type: 'text', isNullable: true },
            { name: 'riskFactors', type: 'text', isNullable: true },
            { name: 'context', type: 'text', isNullable: true },
            { name: 'executed', type: 'integer', default: 0 },
            { name: 'tradeId', type: 'integer', isNullable: true },
            { name: 'mode', type: 'text', default: "'SIMULATION'" },
            { name: 'observeOnly', type: 'integer', default: 0 },
            { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          ],
        }),
        true,
      );

      await queryRunner.createIndex(
        'signal_analysis',
        new TableIndex({ name: 'IDX_signal_analysis_pair_createdAt', columnNames: ['pair', 'createdAt'] }),
      );
      await queryRunner.createIndex(
        'signal_analysis',
        new TableIndex({ name: 'IDX_signal_analysis_strategy_decision', columnNames: ['strategy', 'decision'] }),
      );
      await queryRunner.createIndex(
        'signal_analysis',
        new TableIndex({ name: 'IDX_signal_analysis_score', columnNames: ['score'] }),
      );
    }

    // --- Kolom baru pada trades --------------------------------------------
    if (await queryRunner.hasTable('trades')) {
      for (const column of this.tradeColumns) {
        if (!(await queryRunner.hasColumn('trades', column.name))) {
          await queryRunner.addColumn('trades', column);
        }
      }

      /**
       * Indeks unik parsial untuk idempotensi order.
       *
       * Dibuat lewat SQL mentah karena `WHERE signalRef IS NOT NULL` adalah
       * indeks parsial SQLite yang tidak diwakili TableIndex. Tanpa klausa itu,
       * seluruh baris lama yang signalRef-nya NULL akan saling bertabrakan.
       */
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trades_signalRef"
         ON "trades" ("signalRef") WHERE "signalRef" IS NOT NULL`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trades_signalRef"`);

    if (await queryRunner.hasTable('trades')) {
      for (const column of this.tradeColumns) {
        if (await queryRunner.hasColumn('trades', column.name)) {
          await queryRunner.dropColumn('trades', column.name);
        }
      }
    }

    if (await queryRunner.hasTable('signal_analysis')) {
      await queryRunner.dropTable('signal_analysis');
    }
  }
}
