import { TelegramMenuService } from './telegram-menu.service';

/**
 * Aksi menu dipisah menurut AKIBATNYA, bukan kemudahannya.
 *
 *   JEDA / LANJUTKAN  mengubah flag, tidak memindahkan uang  -> satu ketukan
 *   TUTUP POSISI      menjual aset dengan uang sungguhan     -> dua ketukan
 *
 * Membuat penutupan posisi satu ketukan akan menjadikannya semudah membuka
 * menu — dan penjualan tidak bisa dibatalkan.
 */
describe('Aksi menu Telegram', () => {
  let svc: TelegramMenuService;
  let notification: { sendWithButtons: jest.Mock; updateWithButtons: jest.Mock; isEnabled: jest.Mock };
  let portfolio: { getState: jest.Mock };
  let trading: { manualCloseTrade: jest.Mock };
  let config: { set: jest.Mock; params: () => Record<string, unknown>; mode: string; str: jest.Mock };
  let params: Record<string, unknown>;

  const posisi = (over: Record<string, unknown> = {}) => ({
    tradeId: 3,
    pair: 'dogeidr',
    quantity: 7.4,
    entryPrice: 1494,
    currentPrice: 1510,
    valueIdr: 11174,
    unrealizedPnl: 118,
    unrealizedPercent: 1.07,
    rMultiple: 0.8,
    ...over,
  });

  /** Teks terakhir yang ditampilkan ke operator, dari kirim maupun edit. */
  const teksTerakhir = (): string => {
    const edits = notification.updateWithButtons.mock.calls;
    const sends = notification.sendWithButtons.mock.calls;
    if (edits.length) return edits[edits.length - 1][1];
    return sends.length ? sends[sends.length - 1][0] : '';
  };

  const tombolTerakhir = (): Array<Array<{ label: string; data: string }>> => {
    const edits = notification.updateWithButtons.mock.calls;
    return edits.length ? edits[edits.length - 1][2] : [];
  };

  beforeEach(() => {
    params = {
      tradingEnabled: true,
      riskPerTradePercent: 1.5,
      maxPositionPercent: 65,
      maxDailyLossPercent: 5,
      maxDrawdownPercent: 15,
      maxConsecutiveLosses: 4,
      tradingPairs: ['dogeidr'],
      candleTimeframe: 60,
      makerEntry: false,
    };

    notification = {
      isEnabled: jest.fn().mockReturnValue(true),
      sendWithButtons: jest.fn().mockResolvedValue(undefined),
      updateWithButtons: jest.fn().mockResolvedValue('ok'),
    };
    portfolio = {
      getState: jest.fn().mockResolvedValue({
        equityIdr: 16953,
        cashIdr: 5779,
        positionsValueIdr: 11174,
        unrealizedPnl: 118,
        openPositions: 1,
        positions: [posisi()],
        degraded: false,
      }),
    };
    trading = { manualCloseTrade: jest.fn().mockResolvedValue({ success: true, message: 'ditutup' }) };
    config = {
      set: jest.fn().mockResolvedValue(undefined),
      params: () => params,
      str: jest.fn().mockReturnValue('EMA_SCALPING_V2'),
      mode: 'LIVE',
    };

    svc = Object.create(TelegramMenuService.prototype) as TelegramMenuService;
    Object.assign(svc, {
      notification,
      portfolio,
      risk: { checkKillSwitch: jest.fn().mockResolvedValue({ halted: false, reasons: [] }) },
      trading,
      config,
      pendingClose: new Map(),
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  const tutup = (arg: string) => (svc as any).onTutup(arg, 99);
  const aksi = (arg: string) => (svc as any).onAksi(arg, 99);

  // ─── Jeda / lanjutkan: satu ketukan ──────────────────────────────────────

  it('jeda langsung mengubah flag tanpa konfirmasi', async () => {
    await aksi('jeda');
    expect(config.set).toHaveBeenCalledWith('TRADING_ENABLED', 'false', expect.any(String));
  });

  it('lanjutkan langsung mengubah flag', async () => {
    await aksi('lanjut');
    expect(config.set).toHaveBeenCalledWith('TRADING_ENABLED', 'true', expect.any(String));
  });

  it('tombol berubah mengikuti keadaan, bukan dua tombol berdampingan', async () => {
    params.tradingEnabled = true;
    await aksi('');
    const label = tombolTerakhir()[0][0].label;
    expect(label).toMatch(/Jeda/);

    params.tradingEnabled = false;
    await aksi('');
    expect(tombolTerakhir()[0][0].label).toMatch(/Lanjutkan/);
  });

  it('panel digambar ulang setelah aksi agar keadaannya terlihat', async () => {
    await aksi('jeda');
    expect(notification.updateWithButtons).toHaveBeenCalled();
  });

  // ─── Tutup posisi: dua ketukan ───────────────────────────────────────────

  it('ketukan pertama HANYA meminta konfirmasi, tidak menjual', async () => {
    await tutup('3');
    expect(trading.manualCloseTrade).not.toHaveBeenCalled();
    expect(teksTerakhir()).toMatch(/TUTUP POSISI #3/);
  });

  it('kartu konfirmasi menampilkan P&L yang akan direalisasi', async () => {
    await tutup('3');
    const t = teksTerakhir();
    expect(t).toMatch(/masuk/);
    expect(t).toMatch(/sekarang/);
    expect(t).toMatch(/P&L/);
  });

  it('kartu konfirmasi menyatakan ini uang sungguhan saat LIVE', async () => {
    await tutup('3');
    expect(teksTerakhir()).toMatch(/uang sungguhan/i);
  });

  it('mode simulasi dinyatakan berbeda, tidak menakut-nakuti', async () => {
    (config as any).mode = 'SIMULATION';
    await tutup('3');
    expect(teksTerakhir()).toMatch(/tidak ada uang yang berpindah/i);
  });

  it('ketukan kedua dengan kode benar baru menjual', async () => {
    await tutup('3');
    const kode = (svc as any).pendingClose.get(3).id;

    await tutup(`ok:3:${kode}`);
    expect(trading.manualCloseTrade).toHaveBeenCalledWith(3);
  });

  // ─── Pengaman penutupan ──────────────────────────────────────────────────

  it('kode salah ditolak — kartu yang sudah digantikan tidak menjual', async () => {
    await tutup('3');
    await tutup('ok:3:kodelain');

    expect(trading.manualCloseTrade).not.toHaveBeenCalled();
    expect(teksTerakhir()).toMatch(/sudah digantikan/i);
  });

  it('menekan konfirmasi dua kali tidak menjual dua kali', async () => {
    await tutup('3');
    const kode = (svc as any).pendingClose.get(3).id;

    await tutup(`ok:3:${kode}`);
    await tutup(`ok:3:${kode}`);

    expect(trading.manualCloseTrade).toHaveBeenCalledTimes(1);
  });

  it('usulan kedaluwarsa ditolak', async () => {
    await tutup('3');
    const p = (svc as any).pendingClose.get(3);
    p.createdAt = Date.now() - 3 * 60 * 1000;

    await tutup(`ok:3:${p.id}`);
    expect(trading.manualCloseTrade).not.toHaveBeenCalled();
    expect(teksTerakhir()).toMatch(/kedaluwarsa/i);
  });

  it('tanpa usulan aktif tidak menjual apa pun', async () => {
    await tutup('ok:3:apapun');
    expect(trading.manualCloseTrade).not.toHaveBeenCalled();
  });

  it('batal membuang usulan dan kembali ke portfolio', async () => {
    await tutup('3');
    await tutup('batal:3');

    expect((svc as any).pendingClose.has(3)).toBe(false);
    expect(trading.manualCloseTrade).not.toHaveBeenCalled();
  });

  it('posisi yang sudah tidak terbuka tidak bisa dikonfirmasi', async () => {
    portfolio.getState.mockResolvedValue({
      equityIdr: 16953,
      cashIdr: 16953,
      positionsValueIdr: 0,
      unrealizedPnl: 0,
      openPositions: 0,
      positions: [],
      degraded: false,
    });

    await tutup('3');
    expect(teksTerakhir()).toMatch(/sudah tidak terbuka/i);
    expect((svc as any).pendingClose.has(3)).toBe(false);
  });

  it('kegagalan penutupan dilaporkan apa adanya', async () => {
    trading.manualCloseTrade.mockResolvedValue({ success: false, message: 'saldo koin kurang' });

    await tutup('3');
    const kode = (svc as any).pendingClose.get(3).id;
    await tutup(`ok:3:${kode}`);

    expect(teksTerakhir()).toMatch(/GAGAL MENUTUP/);
    expect(teksTerakhir()).toMatch(/saldo koin kurang/);
  });

  // ─── Portfolio menampilkan tombol per posisi ─────────────────────────────

  it('tiap posisi punya tombol tutup yang menyebut pair-nya', async () => {
    await (svc as any).render('portfolio', 99);
    const labels = tombolTerakhir().flat().map((b) => b.label);
    expect(labels.some((l) => l.includes('#3') && l.includes('DOGEIDR'))).toBe(true);
  });

  it('tanpa posisi tidak ada tombol tutup sama sekali', async () => {
    portfolio.getState.mockResolvedValue({
      equityIdr: 16953,
      cashIdr: 16953,
      positionsValueIdr: 0,
      unrealizedPnl: 0,
      openPositions: 0,
      positions: [],
      degraded: false,
    });

    await (svc as any).render('portfolio', 99);
    const labels = tombolTerakhir().flat().map((b) => b.label);
    expect(labels.some((l) => l.includes('Tutup'))).toBe(false);
  });

  // ─── Navigasi ────────────────────────────────────────────────────────────

  it('"unchanged" tidak mengirim pesan duplikat', async () => {
    notification.updateWithButtons.mockResolvedValue('unchanged');
    await (svc as any).render('risk', 99);
    expect(notification.sendWithButtons).not.toHaveBeenCalled();
  });

  it('kegagalan edit jatuh ke pesan baru', async () => {
    notification.updateWithButtons.mockResolvedValue('failed');
    await (svc as any).render('risk', 99);
    expect(notification.sendWithButtons).toHaveBeenCalled();
  });

  it('tanpa messageId langsung mengirim pesan baru', async () => {
    await (svc as any).render('risk', undefined);
    expect(notification.sendWithButtons).toHaveBeenCalled();
    expect(notification.updateWithButtons).not.toHaveBeenCalled();
  });

  it('jeda manual terlihat di menu utama', async () => {
    params.tradingEnabled = false;
    await (svc as any).render('utama', 99);
    expect(teksTerakhir()).toMatch(/sedang dijeda/i);
  });
});
