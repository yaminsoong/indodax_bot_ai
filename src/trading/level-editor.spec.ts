import { LevelEditorService } from './level-editor.service';

/**
 * Mengubah level pada posisi terbuka menyentuh uang yang SEDANG berisiko.
 * Tiga sifat menentukan boleh-tidaknya fitur ini ada:
 *
 * 1. Nilai mustahil ditolak. Stop LONG di ATAS harga sekarang akan langsung
 *    tereksekusi pada pemeriksaan monitor berikutnya — itu bukan "stop
 *    ketat", itu perintah jual yang menyamar.
 *
 * 2. Memperlebar risiko DINYATAKAN, bukan dilakukan diam-diam. Menurunkan
 *    stop terasa seperti "memberi ruang", padahal ia menambah rupiah yang
 *    bisa hilang.
 *
 * 3. Trailing stop yang sudah lebih ketat tidak boleh tampak dibatalkan. Bot
 *    memakai `max(stopLossPrice, trailingStopPrice)`, jadi menurunkan
 *    `stopLossPrice` saja TIDAK melonggarkan apa pun — dan operator yang
 *    tidak diberi tahu akan menyangka sudah melonggarkannya.
 */
describe('Edit level posisi terbuka', () => {
  let svc: LevelEditorService;
  let tradeRepo: { findOne: jest.Mock; update: jest.Mock };
  let audit: { log: jest.Mock };
  let indodax: { getTicker: jest.Mock };

  const posisi = (over: Record<string, unknown> = {}) => ({
    id: 3,
    pair: 'dogeidr',
    status: 'OPEN',
    quantity: 10,
    remainingQuantity: 10,
    entryPrice: 1000,
    stopLossPrice: 950,
    takeProfitPrice: 1100,
    trailingStopPrice: 0,
    ...over,
  });

  const build = (trade: any, harga: number | Error = 1000) => {
    tradeRepo = {
      findOne: jest.fn().mockResolvedValue(trade),
      update: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    indodax = {
      getTicker: jest
        .fn()
        .mockImplementation(() =>
          harga instanceof Error ? Promise.reject(harga) : Promise.resolve({ last: harga }),
        ),
    };

    svc = Object.create(LevelEditorService.prototype) as LevelEditorService;
    Object.assign(svc, {
      tradeRepo,
      audit,
      indodax,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    return svc;
  };

  // ─── Nilai mustahil ditolak ──────────────────────────────────────────────

  it('stop DI ATAS harga sekarang ditolak sebagai perintah jual terselubung', async () => {
    const s = build(posisi(), 1000);
    const r = await s.setStopLoss(3, 1010);

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/DI ATAS harga sekarang/);
    expect(r.message).toMatch(/perintah jual/);
    expect(tradeRepo.update).not.toHaveBeenCalled();
  });

  it('stop TEPAT di harga sekarang juga ditolak', async () => {
    const r = await build(posisi(), 1000).setStopLoss(3, 1000);
    expect(r.ok).toBe(false);
  });

  it('target DI BAWAH harga sekarang ditolak', async () => {
    const r = await build(posisi(), 1000).setTakeProfit(3, 990);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/DI BAWAH harga sekarang/);
  });

  it('stop di atas target ditolak', async () => {
    // Stop 1050 sah terhadap harga 1100, tetapi melewati target 1100.
    const r = await build(posisi({ takeProfitPrice: 1040 }), 1100).setStopLoss(3, 1050);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/tidak boleh berada di atas target/);
  });

  it('harga nol atau negatif ditolak', async () => {
    const s = build(posisi(), 1000);
    expect((await s.setStopLoss(3, 0)).ok).toBe(false);
    expect((await s.setStopLoss(3, -5)).ok).toBe(false);
  });

  // ─── Harga tidak terbaca: JANGAN mengubah ────────────────────────────────

  it('harga tidak terbaca membatalkan pengeditan, bukan memakai harga entry', async () => {
    // Stop di bawah entry tetapi di atas harga sekarang akan langsung
    // tereksekusi; memeriksanya terhadap entry akan meloloskannya.
    const s = build(posisi(), new Error('ticker timeout'));
    const r = await s.setStopLoss(3, 960);

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/tidak terbaca/);
    expect(r.message).toMatch(/langsung tereksekusi/);
    expect(tradeRepo.update).not.toHaveBeenCalled();
  });

  // ─── Perubahan sah ───────────────────────────────────────────────────────

  it('stop yang lebih ketat tersimpan dan menampilkan nilai lama vs baru', async () => {
    const s = build(posisi(), 1000);
    const r = await s.setStopLoss(3, 980);

    expect(r.ok).toBe(true);
    expect(tradeRepo.update).toHaveBeenCalledWith(3, {
      stopLossPrice: 980,
      takeProfitPrice: 1100,
    });
    expect(r.before).toEqual({ stopLoss: 950, takeProfit: 1100, riskIdr: 500 });
    expect(r.after).toEqual({ stopLoss: 980, takeProfit: 1100, riskIdr: 200 });
  });

  it('mengubah TP tidak menyentuh SL', async () => {
    const s = build(posisi(), 1000);
    await s.setTakeProfit(3, 1200);

    expect(tradeRepo.update).toHaveBeenCalledWith(3, {
      stopLossPrice: 950,
      takeProfitPrice: 1200,
    });
  });

  // ─── Memperlebar risiko harus dinyatakan ────────────────────────────────

  it('risiko yang DIPERLEBAR diperingatkan dengan angkanya', async () => {
    const s = build(posisi(), 1000);
    const r = await s.setStopLoss(3, 900);

    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Risiko DIPERLEBAR/);
    // 950 -> 900 pada 10 koin: risiko 500 -> 1.000
    expect(r.after!.riskIdr).toBe(1000);
  });

  it('stop yang lebih ketat TIDAK memicu peringatan perlebaran', async () => {
    const r = await build(posisi(), 1000).setStopLoss(3, 980);
    expect(r.message).not.toMatch(/DIPERLEBAR/);
  });

  // ─── Trailing stop yang lebih ketat ─────────────────────────────────────

  it('trailing yang lebih ketat dinyatakan membuat pengeditan belum berpengaruh', async () => {
    // Bot memakai max(stop, trailing) = 990, jadi menurunkan stop ke 960
    // tidak melonggarkan apa pun.
    const s = build(posisi({ trailingStopPrice: 990 }), 1000);
    const r = await s.setStopLoss(3, 960);

    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Trailing stop/);
    expect(r.message).toMatch(/belum berpengaruh/);
  });

  it('trailing yang lebih longgar tidak memicu catatan itu', async () => {
    const s = build(posisi({ trailingStopPrice: 940 }), 1000);
    const r = await s.setStopLoss(3, 980);
    expect(r.message).not.toMatch(/Trailing stop/);
  });

  // ─── Jejak audit ─────────────────────────────────────────────────────────

  it('setiap perubahan dicatat beserta nilai sebelum dan sesudah', async () => {
    // Perbedaan antara catatan bot dan kenyataan bursa hanya bisa ditelusuri
    // bila jejaknya ada.
    const s = build(posisi(), 1000);
    await s.setStopLoss(3, 980);

    const call = audit.log.mock.calls[0][0];
    expect(call.event).toBe('LEVEL_EDITED');
    expect(call.tradeId).toBe(3);
    expect(call.data.before.stopLoss).toBe(950);
    expect(call.data.after.stopLoss).toBe(980);
    expect(call.data.marketPrice).toBe(1000);
  });

  it('pengeditan yang DITOLAK tidak meninggalkan jejak audit', async () => {
    await build(posisi(), 1000).setStopLoss(3, 1010);
    expect(audit.log).not.toHaveBeenCalled();
  });

  // ─── Posisi yang tidak layak diedit ─────────────────────────────────────

  it('posisi yang sudah ditutup tidak bisa diedit', async () => {
    const r = await build(posisi({ status: 'CLOSED' }), 1000).setStopLoss(3, 980);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/CLOSED/);
  });

  it('trade yang tidak ada dilaporkan apa adanya', async () => {
    const r = await build(null, 1000).setStopLoss(99, 980);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/tidak ditemukan/);
  });

  // ─── Pengingat cara kerja stop ───────────────────────────────────────────

  it('pesan berhasil tetap mengingatkan stop hanya DIPANTAU BOT', async () => {
    // Indodax tidak menyediakan pembuatan order stop lewat API; operator yang
    // tidak tahu akan menyangka posisinya terlindungi saat bot mati.
    const r = await build(posisi(), 1000).setStopLoss(3, 980);
    expect(r.message).toMatch(/DIPANTAU BOT/);
  });
});
