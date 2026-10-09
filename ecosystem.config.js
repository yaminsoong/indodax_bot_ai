/**
 * Konfigurasi PM2 — pengawas proses.
 *
 * Alasan keberadaannya: antara 9 September dan 6 Oktober 2026 bot ini tidak
 * menghasilkan satu pun baris data. Bukan karena kode rusak, melainkan karena
 * tidak ada yang menjaganya tetap hidup — ia hanya berjalan selama terminal
 * terbuka. Seluruh infrastruktur pengukuran (backtest, audit sinyal, equity
 * curve) tidak ada gunanya bila prosesnya mati tiap kali jendela ditutup.
 *
 * Pemakaian:
 *   npm run pm2:start     mulai dan daftarkan ke PM2
 *   npm run pm2:logs      ikuti log
 *   npm run pm2:status    lihat status, uptime, dan jumlah restart
 *   npm run pm2:stop      hentikan
 *
 * Agar bertahan setelah komputer reboot (Windows), lihat PANDUAN.md bagian
 * "Menjaga Bot Tetap Hidup".
 */
module.exports = {
  apps: [
    {
      name: 'indodax-bot',
      script: 'dist/main.js',
      cwd: __dirname,

      // Satu instans saja. Bot ini menyimpan state di SQLite dan memegang
      // mutex di dalam proses; dua instans akan sama-sama mengirim order
      // untuk posisi yang sama dan saling merusak basis datanya.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,

      /**
       * Jeda sebelum restart. Dibuat panjang dengan sengaja: bila penyebab
       * matinya adalah API Indodax yang menolak, restart cepat berulang hanya
       * akan menghabiskan jatah rate limit dan memperpanjang pemadaman.
       */
      restart_delay: 10000,

      /**
       * Hentikan percobaan setelah 10 kegagalan beruntun dalam waktu singkat.
       * Proses yang gagal menyala terus-menerus tidak akan sembuh sendiri, dan
       * PM2 yang terlihat "aktif" sementara bot sebenarnya mati berulang kali
       * lebih menyesatkan daripada status berhenti yang jujur.
       */
      max_restarts: 10,
      min_uptime: '60s',

      // Restart bila memori membengkak (indikasi kebocoran).
      max_memory_restart: '500M',

      env: {
        NODE_ENV: 'production',
      },

      // Log dipisah agar error mudah ditemukan tanpa menyaring log normal.
      output: 'logs/bot-out.log',
      error: 'logs/bot-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Jangan pernah restart otomatis karena berkas berubah: `npm run build`
      // menulis ulang seluruh dist/ dan akan memicu restart berkali-kali
      // di tengah proses kompilasi.
      watch: false,

      /**
       * Beri waktu bot menutup diri dengan rapi. main.ts menangani SIGINT dan
       * SIGTERM untuk menutup koneksi dan menghentikan polling Telegram;
       * mematikannya paksa bisa meninggalkan order yang baru terkirim tanpa
       * tercatat di basis data.
       */
      kill_timeout: 15000,
    },
  ],
};
