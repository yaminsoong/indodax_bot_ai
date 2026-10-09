/**
 * Cari dan simpan TELEGRAM_CHAT_ID secara otomatis.
 *
 *   npm run telegram:setup
 *
 * Telegram tidak mengizinkan bot mengirim pesan duluan kepada orang yang belum
 * pernah memulai percakapan — itulah sebab galat "chat not found", yang terdengar
 * seperti chat id-nya salah padahal sebenarnya percakapannya yang belum ada.
 * Skrip ini menunggu Anda mengirim /start, lalu menuliskan chat id yang benar
 * ke .env.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_PATH = path.join(__dirname, '..', '.env');

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function tg(token, method) {
  return new Promise((resolve, reject) => {
    https
      .get(`https://api.telegram.org/bot${token}/${method}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Respons Telegram tidak terbaca'));
          }
        });
      })
      .on('error', reject);
  });
}

/** Tulis satu kunci ke .env tanpa mengubah apa pun yang lain. */
function writeKey(key, value) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, `${key}=${value}`);
  else text += `\n${key}=${value}\n`;
  fs.writeFileSync(ENV_PATH, text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = readEnv();
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token || token.startsWith('your_')) {
    console.error('\nTELEGRAM_BOT_TOKEN belum diisi di .env.');
    console.error('Buat bot lewat @BotFather di Telegram, lalu salin tokennya ke .env.\n');
    process.exit(1);
  }

  const me = await tg(token, 'getMe');
  if (!me.ok) {
    console.error(`\nToken ditolak Telegram: ${me.description}\n`);
    process.exit(1);
  }

  const username = me.result.username;
  console.log(`\nBot    : @${username} (${me.result.first_name})`);
  console.log(`Token  : valid\n`);

  // Coba temukan chat dari riwayat yang sudah ada.
  let found = await findChat(token);

  if (!found) {
    console.log('Bot ini belum pernah menerima pesan dari siapa pun.\n');
    console.log(`  1. Buka Telegram, cari  @${username}`);
    console.log('  2. Tekan START, atau kirim pesan apa saja\n');
    console.log('Menunggu pesan Anda (batas 2 menit)…\n');

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !found) {
      await sleep(3000);
      found = await findChat(token);
      if (found) break;
      process.stdout.write('.');
    }
    console.log('');
  }

  if (!found) {
    console.error('\nTidak ada pesan diterima. Jalankan lagi setelah menekan START.\n');
    process.exit(1);
  }

  const label = found.username
    ? '@' + found.username
    : found.first_name || found.title || '(tanpa nama)';
  console.log(`Ditemukan: ${label}  (chat id ${found.id}, tipe ${found.type})`);

  if (env.TELEGRAM_CHAT_ID === String(found.id)) {
    console.log('\n.env sudah berisi chat id ini. Tidak ada yang perlu diubah.\n');
  } else {
    writeKey('TELEGRAM_CHAT_ID', String(found.id));
    console.log(`\nTELEGRAM_CHAT_ID disimpan ke .env (sebelumnya: ${env.TELEGRAM_CHAT_ID || 'kosong'}).`);
  }

  // Kirim pesan uji: satu-satunya bukti bahwa jalurnya benar-benar bekerja.
  const test = await sendTest(token, found.id, username);
  console.log(
    test.ok
      ? '\nPesan uji terkirim. Periksa Telegram Anda — jalur notifikasi sudah aktif.\n'
      : `\nPesan uji GAGAL: ${test.description}\n`,
  );
})().catch((err) => {
  console.error('\nGagal:', err.message, '\n');
  process.exit(1);
});

async function findChat(token) {
  const upd = await tg(token, 'getUpdates');
  if (!upd.ok) return null;
  for (const u of upd.result || []) {
    const msg = u.message || u.edited_message;
    if (msg && msg.chat) return msg.chat;
  }
  return null;
}

function sendTest(token, chatId, username) {
  const text =
    `Bot Trading Indodax terhubung.\n\n` +
    `Mulai sekarang notifikasi trade, stop loss, dan peringatan akan masuk ke sini. ` +
    `Ketik /help untuk daftar perintah.`;
  const url =
    `https://api.telegram.org/bot${token}/sendMessage` +
    `?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}`;

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ ok: false, description: 'respons tidak terbaca' });
          }
        });
      })
      .on('error', (e) => resolve({ ok: false, description: e.message }));
  });
}
