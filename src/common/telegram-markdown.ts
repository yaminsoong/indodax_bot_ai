/**
 * Ubah Markdown umum menjadi dialek Markdown lama Telegram.
 *
 * Masalah yang diselesaikan, diverifikasi langsung terhadap API Telegram:
 * model bahasa menghasilkan Markdown standar (`**tebal**`, `* butir`), sementara
 * `parse_mode=Markdown` Telegram memakai SATU bintang untuk tebal dan tidak
 * mengenal `**`. Akibatnya Telegram menolak pesannya:
 *
 *     Bad Request: can't parse entities: Can't find end of the entity
 *     starting at byte offset 192
 *
 * Penolakan itu tidak terlihat sebagai galat bagi pengguna — lapisan notifikasi
 * mengirim ulang pesannya TANPA format sama sekali. Jadi gejalanya bukan pesan
 * yang hilang, melainkan jawaban panjang tanpa penebalan dan tanpa struktur,
 * yang justru paling sulit dibaca di ponsel.
 *
 * Instruksi di prompt tidak cukup: model tidak taat format secara konsisten.
 * Karena itu konversi dilakukan di sini, pada keluarannya, sebagai jaring kedua.
 */

/** Ubah teks bergaya Markdown standar agar aman bagi Markdown lama Telegram. */
export function toTelegramMarkdown(text: string): string {
  let out = text;

  // Butir daftar lebih dulu: `* item` di awal baris adalah butir, bukan tebal.
  // Dikerjakan sebelum pemrosesan bintang agar tidak tertukar.
  out = out.replace(/^[ \t]*\*[ \t]+/gm, '  • ');
  out = out.replace(/^[ \t]*-[ \t]+/gm, '  • ');

  // `**tebal**` dan `__tebal__` menjadi bentuk satu penanda.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+)__/g, '*$1*');

  // Judul Markdown tidak dikenal Telegram; jadikan tebal saja.
  out = out.replace(/^#{1,6}[ \t]+(.+)$/gm, '*$1*');

  // Sisa penanda yang tidak berpasangan akan membuat Telegram menolak seluruh
  // pesan. Lebih baik kehilangan satu penebalan daripada seluruh formatnya.
  out = balance(out, '*');
  out = balance(out, '_');
  out = balance(out, '`');

  // Hanya baris kosong di tepi yang dibuang, BUKAN spasi di awal baris:
  // `trim()` penuh memakan indentasi butir pertama, sehingga butir teratas
  // sejajar berbeda dari butir di bawahnya dan daftarnya terlihat rusak.
  return out.replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * Buang penanda terakhir yang tidak berpasangan.
 *
 * Telegram menuntut penanda berpasangan sempurna. Menghitung jumlahnya dan
 * membuang yang terakhir bila ganjil jauh lebih sederhana daripada mengurai
 * struktur Markdown — dan cukup, karena yang perlu dicegah hanyalah penolakan.
 */
function balance(text: string, marker: string): string {
  const count = text.split(marker).length - 1;
  if (count % 2 === 0) return text;

  const last = text.lastIndexOf(marker);
  return text.slice(0, last) + text.slice(last + 1);
}
