import { OrderProgressService, OrderProgressState } from './order-progress.service';

/**
 * Laporan progres order.
 *
 * Sebelum ini, menekan CONFIRM menghasilkan satu pesan di akhir dan diam
 * selebihnya — 90 detik untuk order taker, sampai 5 menit untuk maker.
 * Operator tidak bisa membedakan "sedang menunggu" dari "macet", dan ketika
 * pesan gagal muncul tidak ada jejak apa pun tentang apa yang sudah terjadi.
 *
 * Yang diuji di sini adalah teksnya, karena itulah yang menentukan apakah
 * operator paham keadaan uangnya.
 */
describe('OrderProgressService', () => {
  let svc: OrderProgressService;
  let notification: { sendTrackable: jest.Mock; updateMessage: jest.Mock };

  const state = (over: Partial<OrderProgressState> = {}): OrderProgressState => ({
    pair: 'fartcoinidr',
    phase: 'MENUNGGU_TERISI',
    ...over,
  });

  beforeEach(() => {
    notification = {
      sendTrackable: jest.fn().mockResolvedValue(555),
      updateMessage: jest.fn().mockResolvedValue(true),
    };
    svc = new OrderProgressService(notification as any);
  });

  // ─── Tiap tahap harus bisa dibedakan ─────────────────────────────────────

  it('tahap berjalan ditandai sedang diproses', () => {
    const t = svc.render(state({ phase: 'MENGIRIM_ORDER' }));
    expect(t).toMatch(/SEDANG DIPROSES/);
    expect(t).toContain('◐ Mengirim ke Indodax');
    // Langkah sebelumnya sudah tercapai.
    expect(t).toContain('● Memeriksa risiko');
    // Langkah sesudahnya belum.
    expect(t).toContain('○ Menunggu terisi');
  });

  it('terisi menandai seluruh langkah selesai', () => {
    const t = svc.render(state({ phase: 'TERISI' }));
    expect(t).toMatch(/POSISI TERBUKA/);
    expect(t).not.toContain('○');
    expect(t).not.toContain('◐');
  });

  it('tidak terisi memakai tanda jam, BUKAN tanda gagal', () => {
    // Order yang tidak tersentuh harga bukan kerusakan; menandainya dengan ❌
    // membuat operator mencari masalah yang tidak ada.
    const t = svc.render(state({ phase: 'TIDAK_TERISI' }));
    expect(t).toMatch(/⏳/);
    expect(t).not.toMatch(/❌/);
  });

  it('ditolak memakai tanda gagal dan menyebut sebabnya', () => {
    const t = svc.render(
      state({ phase: 'DITOLAK', detail: 'quantity amount has more precision than allowed (0)' }),
    );
    expect(t).toMatch(/❌/);
    expect(t).toContain('precision');
    expect(t).toMatch(/Sebab:/);
  });

  it('terisi sebagian dibedakan dari keduanya', () => {
    const t = svc.render(state({ phase: 'TERISI_SEBAGIAN', filledFraction: 0.4 }));
    expect(t).toMatch(/TERISI SEBAGIAN/);
    expect(t).toContain('Terisi    40%');
  });

  // ─── Konsekuensi terhadap uang harus dinyatakan ──────────────────────────

  it('saat menunggu, menyatakan dana ditahan tetapi BELUM terpakai', () => {
    // Pembedaan yang penting: dana tertahan bukan dana hilang.
    const t = svc.render(state({ phase: 'MENUNGGU_TERISI' }));
    expect(t).toMatch(/ditahan sementara/i);
    expect(t).toMatch(/belum terpakai/i);
  });

  it('saat tidak terisi, menyatakan tidak ada uang terpakai', () => {
    expect(svc.render(state({ phase: 'TIDAK_TERISI' }))).toMatch(/Tidak ada uang terpakai/i);
  });

  it('saat ditolak, juga menyatakan tidak ada uang terpakai', () => {
    expect(svc.render(state({ phase: 'DITOLAK' }))).toMatch(/Tidak ada uang terpakai/i);
  });

  it('saat terisi, menyatakan stop loss sudah terpasang', () => {
    expect(svc.render(state({ phase: 'TERISI' }))).toMatch(/Stop loss dan take profit sudah dipasang/i);
  });

  it('terisi sebagian menjelaskan sisanya dibatalkan', () => {
    const t = svc.render(state({ phase: 'TERISI_SEBAGIAN', filledFraction: 0.4 }));
    expect(t).toMatch(/Sisanya dibatalkan/i);
    expect(t).toMatch(/kembali bebas/i);
  });

  // ─── Rencana ditampilkan bila sudah dihitung ─────────────────────────────

  it('menampilkan stop loss, TP, dan risiko setelah dihitung', () => {
    const t = svc.render(
      state({
        phase: 'MENUNGGU_TERISI',
        referencePrice: 2945,
        positionSizeIdr: 11049,
        riskIdr: 255,
        stopLossPrice: 2870,
        takeProfits: [
          { level: 1, price: 3020, closePercent: 30 },
          { level: 2, price: 3095, closePercent: 30 },
        ],
      }),
    );
    expect(t).toMatch(/Stop loss/);
    expect(t).toMatch(/TP1/);
    expect(t).toMatch(/TP2/);
    expect(t).toMatch(/Risiko/);
  });

  it('tanpa angka, blok rencana tidak ditampilkan sama sekali', () => {
    // Lebih baik tidak menampilkan apa pun daripada menampilkan nol.
    const t = svc.render(state({ phase: 'MEMERIKSA_RISIKO' }));
    expect(t).not.toMatch(/Stop loss/);
    expect(t).not.toMatch(/Rp 0/);
  });

  it('hitungan waktu tersisa ditampilkan saat menunggu', () => {
    const t = svc.render(state({ phase: 'MENUNGGU_TERISI', secondsLeft: 47 }));
    expect(t).toContain('47s lagi');
  });

  // ─── Pengiriman ──────────────────────────────────────────────────────────

  it('start mengembalikan id pesan untuk diperbarui', async () => {
    await expect(svc.start(state())).resolves.toBe(555);
  });

  it('update memakai id yang sama, bukan mengirim pesan baru', async () => {
    await svc.update(555, state({ phase: 'TERISI' }));
    expect(notification.updateMessage).toHaveBeenCalledWith(555, expect.any(String));
    expect(notification.sendTrackable).not.toHaveBeenCalled();
  });

  it('tanpa id pesan, update tidak melakukan apa pun', async () => {
    await svc.update(null, state());
    expect(notification.updateMessage).not.toHaveBeenCalled();
  });

  it('Telegram nonaktif tidak menggagalkan alur order', async () => {
    notification.sendTrackable.mockResolvedValue(null);
    await expect(svc.start(state())).resolves.toBeNull();
    await expect(svc.update(null, state())).resolves.toBeUndefined();
  });
});
