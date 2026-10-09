/**
 * Salin aset statis dashboard ke dist/.
 * nest build hanya mengompilasi TypeScript, sehingga index.html tidak ikut
 * terbawa dan dashboard akan kosong saat dijalankan dari dist/.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'dashboard', 'public');
const dest = path.join(__dirname, '..', 'dist', 'dashboard', 'public');

if (!fs.existsSync(src)) {
  console.log('Tidak ada aset dashboard untuk disalin');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
let count = 0;
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  count++;
}
console.log(`${count} aset dashboard disalin ke dist/`);
