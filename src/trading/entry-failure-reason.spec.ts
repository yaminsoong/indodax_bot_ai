import { TradingService } from './trading.service';

/**
 * Satu sifat: operator HARUS diberi tahu sebab penolakan, bukan disuruh
 * membaca log.
 *
 * Kasus nyata yang memicu tes ini: ZEREBROIDR ditolak dengan sebab yang sudah
 * diketahui persis — "Jarak stop 7.18% melebihi batas 6%" — tetapi kartu
 * Telegram hanya menampilkan "Order tidak tereksekusi — periksa log". Operator
 * menyimpulkan bot rusak, padahal aturannya bekerja sebagaimana mestinya.
 *
 * Sebabnya ada di tempat yang salah: `openManualPosition` menyusun pesan dari
 * `lastEntryFailure`, sedangkan jalur-jalur yang menolak hanya menulis ke log
 * dan tabel audit.
 */
describe('Sebab penolakan entry sampai ke operator', () => {
  let svc: TradingService;
  let risk: { evaluateEntry: jest.Mock };
  let tradeRepo: { findOne: jest.Mock };
  let audit: { log: jest.Mock };

  const candles = Array.from({ length: 200 }, (_, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: 700,
    high: 720,
    low: 690,
    close: 710,
    volume: 1000,
  }));

  beforeEach(() => {
    risk = { evaluateEntry: jest.fn() };
    tradeRepo = { findOne: jest.fn().mockResolvedValue(null) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    svc = Object.create(TradingService.prototype) as TradingService;
    Object.assign(svc, {
      risk,
      tradeRepo,
      audit,
      config: {
        params: () => ({
          candleTimeframe: 60,
          candleLimit: 200,
          requireHtfTrend: false,
          htfTimeframe: 240,
          makerEntry: false,
          makerFillTimeoutSeconds: 300,
        }),
        mode: 'LIVE',
      },
      pairs: { isTradable: () => ({ ok: true }) },
      indodax: { getCandles: jest.fn().mockResolvedValue(candles) },
      strategies: {
        active: () => ({
          name: 'UJI',
          minCandles: 10,
          evaluate: () => ({
            action: 'BUY',
            strength: 80,
            blockedBy: [],
            reasons: ['EMA tersusun bullish', 'ADX kuat'],
            suggestedStopLoss: 659,
            suggestedTakeProfit: 800,
            snapshot: {},
          }),
        }),
      },
      notification: { sendAlert: jest.fn().mockResolvedValue(undefined) },
      signalRepo: { save: jest.fn(), update: jest.fn() },
      intelligence: {},
      intelligenceGate: {},
      intelligenceConfig: { params: () => ({ enabled: false }) },
      signalAudit: {},
      lastEntryFailure: new Map(),
      inFlightEntries: new Set(),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  // ─── Penolakan risk engine ───────────────────────────────────────────────

  it('sebab dari risk engine ikut ke pesan, bukan "periksa log"', async () => {
    risk.evaluateEntry.mockResolvedValue({
      allowed: false,
      reason: 'Jarak stop 7.18% melebihi batas 6%',
    });

    const r = await svc.openManualPosition('zerebroidr', 'TELEGRAM_CONFIRM', 719);

    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Jarak stop 7\.18%/);
    expect(r.message).toMatch(/batas 6%/);
    expect(r.message).not.toMatch(/periksa log/);
  });

  it('sebab juga tersimpan agar bisa dibaca pemanggil lain', async () => {
    risk.evaluateEntry.mockResolvedValue({ allowed: false, reason: 'jatah risiko harian habis' });

    await svc.openManualPosition('zerebroidr');

    expect((svc as any).lastEntryFailure.get('zerebroidr')).toEqual({
      missed: false,
      reason: 'jatah risiko harian habis',
      // Penolakan aturan terjadi SEBELUM ada order yang dikirim. Penanda ini
      // menentukan apakah kartu progres boleh menampilkan "Mengirim ke
      // Indodax" sebagai tercapai.
      reachedExchange: false,
    });
  });

  it('penolakan aturan dilaporkan sebagai BELUM menyentuh bursa', async () => {
    // Kartu yang mengaku sudah mengirim membuat operator mencari masalah di
    // bursa untuk order yang tidak pernah ada di sana.
    risk.evaluateEntry.mockResolvedValue({ allowed: false, reason: 'ADX terlalu rendah' });

    const r = await svc.openManualPosition('zerebroidr');
    expect(r.reachedExchange).toBe(false);
  });

  it('penolakan risk BUKAN "missed" — maker yang lewat berbeda jenis', async () => {
    // `missed` dipakai untuk limit maker yang tidak tersentuh harga: tidak ada
    // yang salah dan tidak ada yang perlu diperbaiki. Penolakan aturan adalah
    // hal lain, dan menyamakannya menyembunyikan sebab yang bisa ditindak.
    risk.evaluateEntry.mockResolvedValue({ allowed: false, reason: 'ADX terlalu rendah' });

    const r = await svc.openManualPosition('zerebroidr');
    expect(r.missed).toBeFalsy();
  });

  it('risk menolak tanpa menyebut sebab tetap tidak menyuruh baca log', async () => {
    risk.evaluateEntry.mockResolvedValue({ allowed: false });

    const r = await svc.openManualPosition('zerebroidr');
    expect(r.message).not.toMatch(/periksa log/);
    expect(r.message).toMatch(/tanpa sebab tercatat/);
  });

  // ─── Pencegahan order ganda ──────────────────────────────────────────────

  it('sinyal yang sudah dieksekusi menyebut nomor trade-nya', async () => {
    // Menekan tombol pada kartu lama adalah hal wajar; pesannya harus
    // menjelaskan, bukan terlihat seperti kerusakan.
    tradeRepo.findOne.mockImplementation((opts: any) => {
      // Panggilan pertama memeriksa posisi terbuka, kedua memeriksa signalRef.
      if (opts?.where?.signalRef) {
        return Promise.resolve({ id: 7, status: 'CLOSED' });
      }
      return Promise.resolve(null);
    });

    const r = await svc.openManualPosition('zerebroidr');

    expect(r.message).toMatch(/#7/);
    expect(r.message).toMatch(/tunggu candle berikutnya/);
    expect(r.message).not.toMatch(/periksa log/);
  });

  it('entry yang sedang diproses dijelaskan sebagai sedang berjalan', async () => {
    risk.evaluateEntry.mockResolvedValue({ allowed: true, positionSize: 10000 });
    // Tandai sinyal sebagai sedang diproses dengan mencocokkan ref apa pun.
    (svc as any).inFlightEntries = {
      has: () => true,
      add: () => undefined,
      delete: () => undefined,
    };

    const r = await svc.openManualPosition('zerebroidr');

    expect(r.message).toMatch(/sedang diproses/);
    expect(r.message).not.toMatch(/periksa log/);
  });

  // ─── Posisi yang sudah ada ───────────────────────────────────────────────

  it('posisi terbuka yang sudah ada disebut dengan nomornya', async () => {
    tradeRepo.findOne.mockResolvedValue({ id: 3, status: 'OPEN' });

    const r = await svc.openManualPosition('zerebroidr');
    expect(r.message).toMatch(/#3/);
  });
});
