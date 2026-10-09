import { toTelegramMarkdown } from './telegram-markdown';

/**
 * Diverifikasi langsung terhadap API Telegram: keluaran AI apa adanya DITOLAK
 * dengan `can't parse entities: Can't find end of the entity`, sementara hasil
 * konversinya diterima dengan penebalan utuh.
 *
 * Penolakan itu tidak tampak sebagai galat bagi pengguna — lapisan notifikasi
 * mengirim ulang pesannya tanpa format sama sekali. Gejalanya bukan pesan yang
 * hilang, melainkan jawaban panjang tanpa struktur, yang justru paling sulit
 * dibaca di ponsel.
 */
describe('toTelegramMarkdown', () => {
  /** Telegram menolak pesan bila penanda tidak berpasangan sempurna. */
  const berpasangan = (text: string, marker: string) =>
    (text.split(marker).length - 1) % 2 === 0;

  // ─── Konversi penanda ────────────────────────────────────────────────────

  it('mengubah **tebal** menjadi *tebal*', () => {
    expect(toTelegramMarkdown('ini **tebal** ya')).toBe('ini *tebal* ya');
  });

  it('mengubah __tebal__ menjadi *tebal*', () => {
    expect(toTelegramMarkdown('ini __tebal__ ya')).toBe('ini *tebal* ya');
  });

  it('membiarkan *tebal* satu penanda apa adanya', () => {
    expect(toTelegramMarkdown('ini *tebal* ya')).toBe('ini *tebal* ya');
  });

  it('mengubah judul Markdown menjadi tebal', () => {
    expect(toTelegramMarkdown('## Ringkasan')).toBe('*Ringkasan*');
    expect(toTelegramMarkdown('# Judul Besar')).toBe('*Judul Besar*');
  });

  // ─── Butir daftar ────────────────────────────────────────────────────────

  it('mengubah butir bintang menjadi titik agar tidak tertukar dengan tebal', () => {
    // Inti masalahnya: `* item` di awal baris adalah butir, bukan pembuka tebal.
    const r = toTelegramMarkdown('* satu\n* dua');
    expect(r).toBe('  • satu\n  • dua');
    expect(berpasangan(r, '*')).toBe(true);
  });

  it('mengubah butir tanda hubung menjadi titik', () => {
    expect(toTelegramMarkdown('- satu\n- dua')).toBe('  • satu\n  • dua');
  });

  it('butir berindentasi juga dikenali', () => {
    expect(toTelegramMarkdown('   * menjorok')).toBe('  • menjorok');
  });

  it('tanda hubung di tengah kalimat tidak diubah', () => {
    expect(toTelegramMarkdown('turun -89% hari ini')).toBe('turun -89% hari ini');
  });

  // ─── Penyeimbangan penanda ───────────────────────────────────────────────

  it('membuang bintang tunggal yang tidak berpasangan', () => {
    const r = toTelegramMarkdown('kalimat dengan *satu bintang nyasar');
    expect(berpasangan(r, '*')).toBe(true);
    expect(r).toBe('kalimat dengan satu bintang nyasar');
  });

  it('membuang garis bawah yang tidak berpasangan', () => {
    const r = toTelegramMarkdown('nilai _tanpa penutup');
    expect(berpasangan(r, '_')).toBe(true);
  });

  it('membuang backtick yang tidak berpasangan', () => {
    const r = toTelegramMarkdown('kode `tanpa penutup');
    expect(berpasangan(r, '`')).toBe(true);
  });

  it('lebih baik kehilangan satu penebalan daripada seluruh format', () => {
    // Bila satu penanda nyasar dibiarkan, Telegram menolak SELURUH pesan dan
    // mengirim ulang tanpa format apa pun.
    const r = toTelegramMarkdown('*tebal benar* lalu *nyasar');
    expect(berpasangan(r, '*')).toBe(true);
    expect(r).toContain('*tebal benar*');
  });

  // ─── Kasus nyata dari keluaran Gemini ────────────────────────────────────

  it('jawaban AI sungguhan menjadi berpasangan sempurna', () => {
    // Teks ini DITOLAK Telegram sebelum konversi — diuji langsung ke API-nya.
    const dariAi = [
      'Berikut faktor penentu utama:',
      '',
      '1. **Teknikal & Tekanan Jual Kuat:**',
      '   * Tren sedang *bearish* (termasuk HTF 60m).',
      '   * Order book condong jual -89%.',
      '',
      '2. **Berita Negatif:**',
      '   * Likuidasi $550M menekan harga.',
    ].join('\n');

    expect(berpasangan(dariAi, '*')).toBe(false); // sebelum: ganjil, ditolak
    const r = toTelegramMarkdown(dariAi);
    expect(berpasangan(r, '*')).toBe(true); // sesudah: diterima
    expect(r).toContain('*Teknikal & Tekanan Jual Kuat:*');
    expect(r).toContain('  • Tren sedang *bearish*');
    expect(r).not.toContain('**');
  });

  // ─── Masukan ekstrem ─────────────────────────────────────────────────────

  it('teks kosong tidak melempar', () => {
    expect(toTelegramMarkdown('')).toBe('');
  });

  it('teks tanpa penanda apa pun tidak berubah', () => {
    expect(toTelegramMarkdown('kalimat biasa saja')).toBe('kalimat biasa saja');
  });

  it('bintang bertumpuk banyak tetap berakhir berpasangan', () => {
    expect(berpasangan(toTelegramMarkdown('***a*** **b** *c'), '*')).toBe(true);
  });

  it('hasilnya selalu berpasangan untuk gabungan penanda apa pun', () => {
    const kasus = [
      '**a** _b_ `c`',
      '*a _b* c_',
      '__a__ **b** *c',
      '`a` **b `c**',
      '# Judul\n* butir\n**tebal**',
    ];
    for (const k of kasus) {
      const r = toTelegramMarkdown(k);
      expect(berpasangan(r, '*')).toBe(true);
      expect(berpasangan(r, '_')).toBe(true);
      expect(berpasangan(r, '`')).toBe(true);
    }
  });
});
