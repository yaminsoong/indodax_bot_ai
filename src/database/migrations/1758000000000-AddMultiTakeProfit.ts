import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Take profit bertingkat dan zona entry.
 *
 * `partialTaken` sengaja TIDAK dihapus. Kolom itu berisi riwayat trade yang
 * sudah selesai, dan menghapusnya akan menghilangkan jejak keputusan yang
 * pernah diambil bot — pada basis data yang memang disimpan untuk dianalisis,
 * itu kerugian yang tidak bisa dipulihkan. Kolom baru berjalan berdampingan.
 *
 * SETIAP PENAMBAHAN KOLOM DIPERIKSA LEBIH DULU, dan alasannya ditemukan dari
 * kegagalan sungguhan, bukan kehati-hatian teoretis:
 *
 * Bot ini bisa dijalankan dengan dua cara, dan keduanya membangun skema dengan
 * mekanisme berbeda. Dijalankan manual (`npm start`), `NODE_ENV` tidak disetel
 * sehingga `synchronize: true` dan TypeORM menambahkan kolom sendiri dari
 * entity — tanpa mencatat apa pun di tabel `migrations`. Dijalankan lewat PM2,
 * `ecosystem.config.js` memasang `NODE_ENV=production` sehingga `synchronize`
 * mati dan `migrationsRun` menyala.
 *
 * Akibatnya, berpindah dari `npm start` ke PM2 membuat migrasi ini mencoba
 * menambahkan kolom yang sudah dibuat `synchronize`, gagal dengan
 * `SqliteError: duplicate column name: tpLevelsFilled`, dan bot masuk putaran
 * restart tanpa henti — persis masalah uptime yang PM2 seharusnya pecahkan.
 */
export class AddMultiTakeProfit1758000000000 implements MigrationInterface {
  name = 'AddMultiTakeProfit1758000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing = await columnNames(queryRunner, 'trades');

    const additions: [string, string][] = [
      ['tpLevelsFilled', `integer NOT NULL DEFAULT 0`],
      ['takeProfitPlan', `text`],
      ['entryZoneLow', `real`],
      ['entryZoneHigh', `real`],
    ];

    for (const [column, definition] of additions) {
      if (existing.has(column)) continue;
      await queryRunner.query(`ALTER TABLE "trades" ADD COLUMN "${column}" ${definition}`);
    }

    // Posisi lama yang sudah mengambil partial dianggap sudah melewati satu
    // tingkat, supaya monitor tidak mencoba mengambilnya lagi.
    //
    // Dijalankan tanpa syarat: aman diulang, dan bila kolomnya dibuat
    // `synchronize` maka backfill ini justru BELUM pernah terjadi.
    if (existing.has('partialTaken')) {
      await queryRunner.query(
        `UPDATE "trades" SET "tpLevelsFilled" = 1 WHERE "partialTaken" = 1 AND "tpLevelsFilled" = 0`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const existing = await columnNames(queryRunner, 'trades');

    for (const column of ['entryZoneHigh', 'entryZoneLow', 'takeProfitPlan', 'tpLevelsFilled']) {
      if (!existing.has(column)) continue;
      await queryRunner.query(`ALTER TABLE "trades" DROP COLUMN "${column}"`);
    }
  }
}

/**
 * Nama kolom sebuah tabel menurut SQLite.
 *
 * `PRAGMA table_info` dipakai alih-alih `queryRunner.getTable()` karena yang
 * dibutuhkan hanya daftar nama, dan PRAGMA tidak bergantung pada cache metadata
 * TypeORM yang bisa sudah tidak sesuai setelah `synchronize` mengubah skema.
 */
async function columnNames(queryRunner: QueryRunner, table: string): Promise<Set<string>> {
  const rows: { name: string }[] = await queryRunner.query(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((r) => r.name));
}
