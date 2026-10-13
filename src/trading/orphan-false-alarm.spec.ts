import { ReconciliationService } from './reconciliation.service';

/**
 * Order maker yang SEDANG ditunggu bot tidak boleh dilaporkan sebagai yatim.
 *
 * Order maker belum dicatat di database selama masa tunggunya — ia baru masuk
 * setelah terisi. Rekonsiliasi karena itu tidak bisa membedakan order yang
 * sedang dikelola bot dari sisa crash, dan melaporkan yang pertama sebagai
 * yang kedua.
 *
 * Dua kejadian nyata yang tampak IDENTIK dari luar:
 *
 *   2026-10-12  order 67214272, umur 33 menit, setelah proses di-restart
 *               -> yatim SUNGGUHAN, dana terkunci sampai dibatalkan manual
 *
 *   2026-10-13  order 67278941, umur 1 menit, bot sedang menunggu
 *               -> ALARM PALSU, dibatalkan bot sendiri 4 menit kemudian
 *
 * Alarm palsu berbahaya justru karena itu: ia melatih operator mengabaikan
 * peringatan yang sekali waktu benar.
 */
describe('Rekonsiliasi: order yang sedang ditunggu bukan yatim', () => {
  let svc: ReconciliationService;
  let indodax: { getOpenOrders: jest.Mock };
  let execution: { inFlightOrderIds: jest.Mock };
  let tradeRepo: { find: jest.Mock };

  const build = () => {
    const s = Object.create(ReconciliationService.prototype) as ReconciliationService;
    Object.assign(s, {
      config: { params: () => ({}), mode: 'LIVE', isLive: true },
      indodax,
      execution,
      pairs: { require: () => ({ minOrderIdr: 10000, tradedCurrency: 'fartcoin' }) },
      notification: { sendAlert: jest.fn() },
      audit: { log: jest.fn() },
      tradeRepo,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    return s;
  };

  /**
   * Memanggil metode PRODUKSI, bukan meniru logikanya.
   *
   * Versi pertama test ini menyalin ulang perulangannya — yang hanya
   * membuktikan testnya sendiri. `findOrphanOrders` karena itu diekstrak dari
   * `reconcile()` agar bisa dipanggil langsung.
   */
  const runOrphanCheck = async (service: ReconciliationService) => {
    const orders = await indodax.getOpenOrders();
    const found = service.findOrphanOrders(orders, new Set<string>());
    return { orphanOrders: found.length, discrepancies: found };
  };

  beforeEach(() => {
    indodax = { getOpenOrders: jest.fn().mockResolvedValue([]) };
    execution = { inFlightOrderIds: jest.fn().mockReturnValue(new Set<string>()) };
    tradeRepo = { find: jest.fn().mockResolvedValue([]) };
    svc = build();
  });

  // ─── Alarm palsu yang harus hilang ───────────────────────────────────────

  it('order yang sedang ditunggu bot TIDAK dilaporkan yatim', async () => {
    indodax.getOpenOrders.mockResolvedValue([
      { order_id: '67278941', pair: 'fartcoinidr', type: 'buy' },
    ]);
    execution.inFlightOrderIds.mockReturnValue(new Set(['67278941']));

    const r = await runOrphanCheck(svc);
    expect(r.orphanOrders).toBe(0);
    expect(r.discrepancies).toEqual([]);
  });

  // ─── Yatim sungguhan harus tetap terdeteksi ──────────────────────────────

  it('order yang TIDAK ditunggu siapa pun tetap dilaporkan yatim', async () => {
    // Kasus 12 Oktober: proses di-restart, logika tunggu mati bersamanya.
    indodax.getOpenOrders.mockResolvedValue([
      { order_id: '67214272', pair: 'fartcoinidr', type: 'buy' },
    ]);
    execution.inFlightOrderIds.mockReturnValue(new Set<string>());

    const r = await runOrphanCheck(svc);
    expect(r.orphanOrders).toBe(1);
    expect(r.discrepancies[0].detail).toContain('67214272');
  });

  it('memisahkan yang ditunggu dari yang yatim dalam satu pemeriksaan', async () => {
    indodax.getOpenOrders.mockResolvedValue([
      { order_id: 'ditunggu', pair: 'fartcoinidr', type: 'buy' },
      { order_id: 'yatim', pair: 'dogeidr', type: 'buy' },
    ]);
    execution.inFlightOrderIds.mockReturnValue(new Set(['ditunggu']));

    const r = await runOrphanCheck(svc);
    expect(r.orphanOrders).toBe(1);
    expect(r.discrepancies[0].detail).toContain('yatim');
  });

  // ─── Pencocokan id harus tahan tipe ──────────────────────────────────────

  it('id numerik dari exchange cocok dengan id string yang dilacak', async () => {
    // Indodax mengembalikan order_id sebagai angka pada sebagian endpoint.
    indodax.getOpenOrders.mockResolvedValue([
      { order_id: 67278941, pair: 'fartcoinidr', type: 'buy' },
    ]);
    execution.inFlightOrderIds.mockReturnValue(new Set(['67278941']));

    expect((await runOrphanCheck(svc)).orphanOrders).toBe(0);
  });

  // ─── Keadaan batas ───────────────────────────────────────────────────────

  it('tanpa order terbuka tidak ada yang dilaporkan', async () => {
    expect((await runOrphanCheck(svc)).orphanOrders).toBe(0);
  });

  it('daftar in-flight kosong tidak membuat semuanya lolos', async () => {
    indodax.getOpenOrders.mockResolvedValue([
      { order_id: 'a', pair: 'x', type: 'buy' },
      { order_id: 'b', pair: 'y', type: 'buy' },
    ]);
    expect((await runOrphanCheck(svc)).orphanOrders).toBe(2);
  });
});
