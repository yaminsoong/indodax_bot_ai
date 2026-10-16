import { IndodaxService } from './indodax.service';

/**
 * Bot yang memegang uang tidak boleh bergantung pada kerapian jam mesin yang
 * menjalankannya.
 *
 * Nonce pada TAPI lama dipakai SEKALIGUS sebagai `timestamp`, sehingga jam
 * yang meleset membuat seluruh panggilan privat ditolak "Invalid timestamp".
 * Diukur 2026-10-14: jam mesin ini 183 DETIK tertinggal dari server Indodax,
 * dan 20 galat berurutan muncul di log — pembacaan saldo dan rekonsiliasi
 * sama-sama gagal.
 *
 * Klien v2 sudah mengoreksinya lewat `clockOffsetMs`. Jalur lama TIDAK, dan
 * memakai `Date.now()` mentah. Perbedaan perlakuan antara dua protokol yang
 * melayani kunci yang sama adalah bentuk ketidaksinkronan yang sama dengan
 * /peluang vs menu skor.
 */
describe('Offset jam pada TAPI lama', () => {
  let svc: IndodaxService;
  let v2: { getClockOffsetMs: jest.Mock; syncClock: jest.Mock };

  const build = (offsetMs: number) => {
    v2 = {
      getClockOffsetMs: jest.fn().mockReturnValue(offsetMs),
      syncClock: jest.fn().mockResolvedValue(offsetMs),
    };

    svc = Object.create(IndodaxService.prototype) as IndodaxService;
    Object.assign(svc, {
      v2,
      lastNonce: 0,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    return svc;
  };

  const nonce = (s: IndodaxService): number => Number((s as any).nextNonce());

  // ─── Offset diterapkan ───────────────────────────────────────────────────

  it('nonce dikoreksi maju ketika jam mesin TERTINGGAL', () => {
    // Kasus nyata: mesin 183 detik di belakang server.
    const offset = 183_000;
    const s = build(offset);

    const sebelum = Date.now();
    const n = nonce(s);

    expect(n).toBeGreaterThanOrEqual(sebelum + offset);
    // Dan jelas berbeda dari jam mentah, yang itulah sebab penolakan.
    expect(n - sebelum).toBeGreaterThan(180_000);
  });

  it('nonce dikoreksi mundur ketika jam mesin MENDAHULUI', () => {
    const s = build(-120_000);
    const n = nonce(s);
    expect(n).toBeLessThan(Date.now());
  });

  it('offset nol berarti perilaku sama seperti sebelum perbaikan', () => {
    // Bila jam belum pernah disinkronkan, jangan mengubah apa pun.
    const s = build(0);
    const sebelum = Date.now();
    const n = nonce(s);
    expect(Math.abs(n - sebelum)).toBeLessThan(2000);
  });

  it('offset dibaca dari klien v2, bukan dihitung ulang sendiri', () => {
    // Dua sumber offset akan menyimpang, dan menyimpang tanpa terlihat.
    const s = build(50_000);
    nonce(s);
    expect(v2.getClockOffsetMs).toHaveBeenCalled();
  });

  // ─── Sifat monotonik tetap dijaga ────────────────────────────────────────

  it('nonce tetap naik ketat walau dipanggil beruntun', () => {
    // Indodax menolak nonce yang mengulang. Koreksi jam TIDAK boleh merusak
    // sifat ini — dua panggilan dalam milidetik yang sama harus tetap beda.
    const s = build(183_000);
    const urut = [nonce(s), nonce(s), nonce(s), nonce(s), nonce(s)];

    for (let i = 1; i < urut.length; i++) {
      expect(urut[i]).toBeGreaterThan(urut[i - 1]);
    }
  });

  it('offset yang berubah di tengah jalan tidak membuat nonce mundur', () => {
    // Sinkronisasi ulang bisa menghasilkan offset lebih kecil. Nonce yang
    // mundur akan ditolak sebagai nonce yang sudah terpakai.
    const s = build(183_000);
    const tinggi = nonce(s);

    v2.getClockOffsetMs.mockReturnValue(0);
    const berikutnya = nonce(s);

    expect(berikutnya).toBeGreaterThan(tinggi);
  });
});
