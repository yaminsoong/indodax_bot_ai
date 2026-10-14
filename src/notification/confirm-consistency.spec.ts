import { TradeConfirmService } from './trade-confirm.service';

/**
 * Satu sifat menentukan apakah tombol CONFIRM boleh menyentuh uang nyata:
 * **angka yang ditampilkan harus sama dengan order yang dieksekusi.**
 *
 * Sebelum perbaikan ini ada TIGA harga berbeda dalam satu alur:
 *
 *   onBuy              `ticker.last`          harga hidup, yang dilihat operator
 *   onConfirm          `order.price`          tersimpan, bisa 5 menit lalu
 *   openManualPosition `candles[last].close`  penutupan bar, bisa 60 menit lalu
 *
 * Operator menyetujui rencana dari harga pertama, validasinya memakai harga
 * kedua, dan ordernya memakai harga ketiga.
 */
describe('Konsistensi konfirmasi order', () => {
  let svc: TradeConfirmService;
  let risk: { evaluateEntry: jest.Mock; takeProfitPlan: jest.Mock };
  let trading: { openManualPosition: jest.Mock };
  let indodax: { getTicker: jest.Mock };
  let progress: { start: jest.Mock; update: jest.Mock };

  const HARGA_USULAN = 1000;

  const decision = (over: Record<string, unknown> = {}) => ({
    allowed: true,
    positionSize: 11049,
    quantity: 11.049,
    stopLossPrice: 980,
    takeProfitPrice: 1070,
    riskAmountIdr: 255,
    initialRiskPerUnit: 20,
    ...over,
  });

  const pasangUsulan = (id = 'abc123') => {
    (svc as any).pending.set('fartcoinidr', {
      id,
      pair: 'fartcoinidr',
      price: HARGA_USULAN,
      stopLoss: 980,
      takeProfit: 1070,
      positionSize: 11049,
      quantity: 11.049,
      riskIdr: 255,
      riskReward: 3.5,
      createdAt: Date.now(),
    });
  };

  beforeEach(() => {
    risk = {
      evaluateEntry: jest.fn().mockResolvedValue(decision()),
      takeProfitPlan: jest.fn().mockReturnValue([{ level: 1, price: 1050, closePercent: 100, atR: 2 }]),
    };
    trading = {
      openManualPosition: jest.fn().mockResolvedValue({ success: true, message: 'dibuka' }),
    };
    indodax = { getTicker: jest.fn().mockResolvedValue({ last: HARGA_USULAN }) };
    progress = { start: jest.fn().mockResolvedValue(1), update: jest.fn().mockResolvedValue(undefined) };

    svc = Object.create(TradeConfirmService.prototype) as TradeConfirmService;
    Object.assign(svc, {
      notification: { isEnabled: () => true, sendWithButtons: jest.fn(), sendChart: jest.fn() },
      charts: { build: jest.fn() },
      progress,
      analysis: {},
      trading,
      risk,
      config: { params: () => ({ makerEntry: false, orderFillTimeoutSeconds: 90, makerFillTimeoutSeconds: 300 }), mode: 'LIVE' },
      intelligence: {},
      indodax,
      pending: new Map(),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  const confirm = (arg: string) => (svc as any).onConfirm(arg);

  // ─── Harga diambil ulang dan dipakai konsisten ───────────────────────────

  it('mengambil harga HIDUP saat konfirmasi, bukan memakai harga usulan', async () => {
    pasangUsulan();
    await confirm('fartcoinidr:abc123');
    expect(indodax.getTicker).toHaveBeenCalledWith('fartcoinidr');
  });

  it('memvalidasi risiko dengan harga hidup, bukan harga usulan', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1003 });

    await confirm('fartcoinidr:abc123');

    const [, hargaDipakai] = risk.evaluateEntry.mock.calls[0];
    expect(hargaDipakai).toBe(1003);
    expect(hargaDipakai).not.toBe(HARGA_USULAN);
  });

  it('mengeksekusi dengan harga yang SAMA dengan yang divalidasi', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1003 });

    await confirm('fartcoinidr:abc123');

    expect(trading.openManualPosition).toHaveBeenCalledWith('fartcoinidr', 'TELEGRAM_CONFIRM', 1003);
  });

  it('menjaga JARAK stop tetap sama saat harga bergeser', async () => {
    // Usulan: harga 1000, stop 980 -> jarak 20 (2%).
    // Harga naik ke 1003 -> stop harus 983, bukan tetap 980.
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1003 });

    await confirm('fartcoinidr:abc123');

    const [, , stopDipakai] = risk.evaluateEntry.mock.calls[0];
    expect(stopDipakai).toBe(983);
  });

  it('kartu progres menampilkan angka hasil recheck, bukan usulan lama', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1003 });
    risk.evaluateEntry.mockResolvedValue(
      decision({ positionSize: 9000, riskAmountIdr: 199, stopLossPrice: 983 }),
    );

    await confirm('fartcoinidr:abc123');

    const state = progress.start.mock.calls[0][0];
    expect(state.referencePrice).toBe(1003);
    expect(state.positionSizeIdr).toBe(9000);
    expect(state.riskIdr).toBe(199);
    expect(state.stopLossPrice).toBe(983);
  });

  // ─── Pergeseran harga membatalkan ────────────────────────────────────────

  it('membatalkan bila harga bergerak melebihi toleransi', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1020 }); // +2%

    const r = await confirm('fartcoinidr:abc123');

    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/harga sudah bergerak/i);
    expect(r).toMatch(/\+2\.00%/);
  });

  it('membatalkan juga bila harga TURUN melebihi toleransi', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 980 }); // -2%

    const r = await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/harga sudah bergerak/i);
  });

  it('pergeseran kecil masih diizinkan', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue({ last: 1003 }); // +0,3%

    await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).toHaveBeenCalled();
  });

  it('harga tidak terbaca membatalkan, tidak memesan dengan harga lama', async () => {
    pasangUsulan();
    indodax.getTicker.mockResolvedValue(null);

    const r = await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/tidak terbaca/i);
  });

  // ─── Kartu yang sudah digantikan ─────────────────────────────────────────

  it('menolak CONFIRM dari kartu yang sudah digantikan usulan baru', async () => {
    // Operator menekan BUY dua kali; kartu lama masih tertera di layar.
    pasangUsulan('baru99');

    const r = await confirm('fartcoinidr:lama11');

    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/sudah digantikan/i);
  });

  it('kartu terbaru tetap berfungsi', async () => {
    pasangUsulan('baru99');
    await confirm('fartcoinidr:baru99');
    expect(trading.openManualPosition).toHaveBeenCalled();
  });

  it('usulan tetap tersimpan saat kartu basi ditolak', async () => {
    // Menolak kartu lama TIDAK boleh membuang usulan yang masih berlaku.
    pasangUsulan('baru99');
    await confirm('fartcoinidr:lama11');
    expect((svc as any).pending.has('fartcoinidr')).toBe(true);
  });

  // ─── Pengaman yang sudah ada tetap berlaku ───────────────────────────────

  it('tanpa usulan aktif tidak memesan apa pun', async () => {
    const r = await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/Tidak ada usulan aktif/i);
  });

  it('usulan kedaluwarsa ditolak', async () => {
    pasangUsulan();
    (svc as any).pending.get('fartcoinidr').createdAt = Date.now() - 6 * 60 * 1000;

    const r = await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/kedaluwarsa/i);
  });

  it('Risk Engine menolak berarti tidak ada order', async () => {
    pasangUsulan();
    risk.evaluateEntry.mockResolvedValue({ allowed: false, reason: 'jatah risiko habis' });

    const r = await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).not.toHaveBeenCalled();
    expect(r).toMatch(/jatah risiko habis/);
  });

  it('CONFIRM dua kali tidak memesan dua kali', async () => {
    pasangUsulan();
    await confirm('fartcoinidr:abc123');
    await confirm('fartcoinidr:abc123');
    expect(trading.openManualPosition).toHaveBeenCalledTimes(1);
  });
});
