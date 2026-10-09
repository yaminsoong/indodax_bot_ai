/**
 * Periksa .env tanpa menjalankan bot.
 *
 * Dipakai sebelum `npm run pm2:start`: lebih baik mengetahui konfigurasinya
 * tertinggal di belakang kode sekarang, daripada menemukannya berminggu-minggu
 * kemudian saat bertanya mengapa tidak ada data yang terkumpul.
 *
 *   npm run config:audit
 *   npm run config:audit -- .env.backup
 */
const path = require('path');
const fs = require('fs');

const distPath = path.join(__dirname, '..', 'dist', 'config', 'config-audit.service.js');
if (!fs.existsSync(distPath)) {
  console.error('dist/ belum ada. Jalankan `npm run build` lebih dulu.');
  process.exit(1);
}

const { ConfigAuditService } = require(distPath);

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '.env');

const report = new ConfigAuditService().audit(target);

const ICON = { CRITICAL: 'KRITIS ', WARNING: 'WARN   ', INFO: 'info   ' };

console.log(`\nBerkas : ${report.envFile}`);
console.log(`Hasil  : ${report.summary}\n`);

if (!report.findings.length) {
  console.log('  Tidak ada masalah. Semua parameter yang dipakai kode ada di .env.\n');
} else {
  for (const f of report.findings) {
    console.log(`  [${ICON[f.severity]}] ${f.key}`);
    console.log(`              ${f.detail}\n`);
  }
}

// Keluar dengan kode != 0 bila ada temuan kritis, supaya bisa dipakai di
// skrip lain sebagai gerbang sebelum menyalakan bot.
const critical = report.findings.filter((f) => f.severity === 'CRITICAL').length;
if (critical > 0) {
  console.log(`${critical} masalah KRITIS — perbaiki sebelum menjalankan bot.\n`);
  process.exit(1);
}
