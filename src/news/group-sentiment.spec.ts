import { GroupSentimentService } from './group-sentiment.service';
import { SentimentService } from './sentiment.service';

/**
 * Lapisan ini membaca pesan orang asing dan memasukkannya ke sistem yang
 * memegang uang. Tiga sifat menentukan apakah itu boleh:
 *
 *   1. grup yang diamati TIDAK bisa menjalankan perintah apa pun
 *   2. isinya HANYA boleh menurunkan keyakinan, tidak pernah menaikkan
 *   3. keramaian dibaca sebagai "harga sudah bergerak", bukan "akan bergerak"
 *
 * Grup sinyal kripto adalah tempat pump-and-dump bekerja: orang yang sudah
 * memegang koin meneriakkannya supaya orang lain membeli dari mereka.
 */
describe('GroupSentimentService', () => {
  let svc: GroupSentimentService;

  const build = (watch: string) =>
    new GroupSentimentService(new SentimentService(), {
      get: (k: string, d: string) => (k === 'TELEGRAM_WATCH_GROUPS' ? watch : d),
    } as any);

  beforeEach(() => {
    svc = build('-100123,-100456');
  });

  // --- Siapa yang diamati -------------------------------------------------

  it('mati bila tidak ada grup yang didaftarkan', () => {
    expect(build('').isEnabled()).toBe(false);
  });

  it('hidup bila ada grup yang didaftarkan', () => {
    expect(svc.isEnabled()).toBe(true);
  });

  it('spasi di daftar grup tidak membuatnya gagal cocok', () => {
    const s = build(' -100123 , -100456 ');
    expect(s.isWatched('-100123')).toBe(true);
    expect(s.isWatched('-100456')).toBe(true);
  });

  it('pesan dari grup yang TIDAK diamati ditolak', () => {
    // Inilah yang menjaga agar grup sembarangan tidak bisa menyuntikkan bahan.
    expect(svc.observe('-999999', 'Grup Asing', 'Bitcoin melonjak')).toBe(false);
    expect(svc.assess().messageCount).toBe(0);
  });

  it('pesan dari grup yang diamati diterima', () => {
    expect(svc.observe('-100123', 'Grup Sinyal', 'Bitcoin melonjak tajam')).toBe(true);
    expect(svc.assess().messageCount).toBe(1);
  });

  // --- Perintah tidak boleh lewat -----------------------------------------

  it('teks yang berbentuk perintah TIDAK dicatat', () => {
    // Pengamat harus menolaknya supaya tidak ada jalur apa pun dari grup ke
    // penangan perintah, sekarang maupun setelah kode ini diubah orang lain.
    expect(svc.observe('-100123', 'Grup', '/close 3')).toBe(false);
    expect(svc.observe('-100123', 'Grup', '/pause')).toBe(false);
    expect(svc.assess().messageCount).toBe(0);
  });

  it('pesan kosong diabaikan', () => {
    expect(svc.observe('-100123', 'Grup', '   ')).toBe(false);
  });

  // --- Penilaian ----------------------------------------------------------

  it('menilai arah pesan dengan kamus yang sama, termasuk Bahasa Indonesia', () => {
    svc.observe('-100123', 'Grup', 'Bitcoin anjlok, investor panik jual');
    svc.observe('-100123', 'Grup', 'Harga melonjak setelah aturan disetujui');

    const r = svc.assess();
    expect(r.positiveCount).toBe(1);
    expect(r.negativeCount).toBe(1);
  });

  it('pesan tanpa arah tidak dihitung sebagai positif maupun negatif', () => {
    svc.observe('-100123', 'Grup', 'ada yang tahu jam berapa market buka');

    const r = svc.assess();
    expect(r.messageCount).toBe(1);
    expect(r.positiveCount).toBe(0);
    expect(r.negativeCount).toBe(0);
  });

  it('data sedikit ditandai belum bisa disimpulkan', () => {
    svc.observe('-100123', 'Grup', 'Bitcoin melonjak');
    expect(svc.assess().inconclusive).toBe(true);
  });

  it('peringatan SELALU disertakan, lepas dari isinya', () => {
    // Tanpa peringatan ini, hitungan positif terbaca seolah sinyal beli.
    svc.observe('-100123', 'Grup', 'Bitcoin melonjak');
    const r = svc.assess();
    expect(r.caveat).toMatch(/HANYA boleh menurunkan keyakinan/);
    expect(r.caveat).toMatch(/sudah bergerak/);
  });

  // --- Sebutan koin -------------------------------------------------------

  it('menghitung sebutan koin hanya setelah melewati ambang', () => {
    // Satu orang menyebut sebuah koin bukan sentimen; itu satu orang.
    svc.observe('-100123', 'Grup', 'pepe kelihatan bagus');
    svc.observe('-100123', 'Grup', 'pepe naik terus');
    let r = svc.assess(['pepe', 'btc']);
    expect(r.mentions).toHaveLength(0);

    svc.observe('-100123', 'Grup', 'masuk pepe sekarang');
    r = svc.assess(['pepe', 'btc']);
    expect(r.mentions).toEqual([{ coin: 'pepe', count: 3 }]);
  });

  it('nama koin pendek tidak salah cocok dengan kata biasa', () => {
    // Masalah yang sama dengan lapisan berita: "sol" tidak boleh cocok
    // dengan "solusi".
    svc.observe('-100123', 'Grup', 'ada solusi lain tidak');
    svc.observe('-100123', 'Grup', 'cari solusi dong');
    svc.observe('-100123', 'Grup', 'solusinya apa');

    expect(svc.assess(['sol']).mentions).toHaveLength(0);
  });

  it('sebutan dihitung walau koin ada di awal atau akhir pesan', () => {
    svc.observe('-100123', 'Grup', 'doge');
    svc.observe('-100123', 'Grup', 'beli doge');
    svc.observe('-100123', 'Grup', 'doge gimana');

    expect(svc.assess(['doge']).mentions).toEqual([{ coin: 'doge', count: 3 }]);
  });

  // --- Jendela waktu dan batas memori -------------------------------------

  it('pesan lebih dari 6 jam tidak dihitung', () => {
    svc.observe('-100123', 'Grup', 'Bitcoin melonjak');
    (svc as any).messages[0].at = Date.now() - 7 * 60 * 60 * 1000;

    expect(svc.assess().messageCount).toBe(0);
  });

  it('jumlah pesan yang disimpan dibatasi agar memori tidak tumbuh terus', () => {
    for (let i = 0; i < 600; i++) svc.observe('-100123', 'Grup', `pesan ${i} melonjak`);
    expect(svc.assess().messageCount).toBeLessThanOrEqual(500);
  });

  it('menghitung grup aktif, bukan grup yang didaftarkan', () => {
    // Dua grup didaftarkan, hanya satu mengirim pesan.
    svc.observe('-100123', 'Grup A', 'Bitcoin melonjak');
    expect(svc.assess().activeGroups).toBe(1);
  });

  it('pesan terbaru yang berarah dikembalikan dengan umurnya', () => {
    svc.observe('-100123', 'Grup Sinyal', 'Bitcoin anjlok tajam');
    const r = svc.recentDirected(3);

    expect(r).toHaveLength(1);
    expect(r[0].chatTitle).toBe('Grup Sinyal');
    expect(r[0].score).toBeLessThan(0);
    expect(r[0].hoursAgo).toBeLessThan(0.1);
  });

  it('pesan tanpa arah tidak muncul di daftar terbaru', () => {
    svc.observe('-100123', 'Grup', 'halo semua');
    expect(svc.recentDirected()).toHaveLength(0);
  });
});
