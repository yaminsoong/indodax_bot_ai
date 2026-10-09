import { OpportunityWatcherService } from './opportunity-watcher.service';
import { makeParams } from '../../test/fixtures/bot-params';
import { BotParams } from '../config/bot-config.service';

/**
 * Pengawas peluang mengirim tawaran yang ujungnya ditekan operator, jadi satu
 * sifat menentukan apakah ia berguna atau merusak: **tawaran yang akan ditolak
 * saat tombolnya ditekan tidak boleh pernah dikirim.** Notifikasi yang berakhir
 * dengan penolakan melatih operator untuk mengabaikan notifikasi.
 *
 * Versi pertama lapisan ini menyaring `hits` scanner berdasarkan SKOR saja.
 * Pada pemindaian nyata itu salah total: 57 dari 57 hit berstatus NO_TRADE
 * sementara satu di antaranya berskor 71 — lolos ambang, lalu ditolak Risk
 * Engine. Keputusan analitis harus diperiksa lebih dulu.
 */
describe('OpportunityWatcherService', () => {
  let svc: OpportunityWatcherService;
  let params: BotParams;
  let scanner: { scan: jest.Mock };
  let risk: { checkKillSwitch: jest.Mock; evaluateEntry: jest.Mock; takeProfitPlan: jest.Mock };
  let confirm: { offer: jest.Mock };
  let trades: { find: jest.Mock };
  let indodax: { getTicker: jest.Mock };

  const hit = (over: Partial<{ pair: string; score: number; decision: string }> = {}) => ({
    pair: 'btcidr',
    type: 'STRONG_TREND',
    timeframe: '1H',
    direction: 'LONG',
    score: 80,
    decision: 'TRADE_SETUP',
    regime: 'TRENDING',
    price: 1_500_000_000,
    detail: 'uji',
    ...over,
  });

  beforeEach(() => {
    params = makeParams({
      opportunityAlertEnabled: true,
      opportunityMinScore: 70,
      opportunityCooldownHours: 4,
      opportunityMaxPerScan: 2,
    });

    scanner = { scan: jest.fn().mockResolvedValue({ hits: [hit()], overview: [] }) };
    risk = {
      checkKillSwitch: jest.fn().mockResolvedValue({ halted: false, reasons: [] }),
      evaluateEntry: jest.fn().mockResolvedValue({
        allowed: true,
        positionSize: 200_000,
        quantity: 0.0001,
        stopLossPrice: 1_480_000_000,
        takeProfitPrice: 1_540_000_000,
        riskAmountIdr: 10_000,
        initialRiskPerUnit: 20_000_000,
      }),
      takeProfitPlan: jest.fn().mockReturnValue([
        { level: 1, price: 1_520_000_000, closePercent: 30, atR: 1 },
        { level: 2, price: 1_560_000_000, closePercent: 70, atR: 3 },
      ]),
    };
    confirm = { offer: jest.fn().mockResolvedValue(undefined) };
    trades = { find: jest.fn().mockResolvedValue([]) };
    indodax = { getTicker: jest.fn().mockResolvedValue({ last: 1_500_000_000 }) };

    svc = new OpportunityWatcherService(
      trades as any,
      { isEnabled: () => true } as any,
      confirm as any,
      scanner as any,
      risk as any,
      { params: () => params, get mode() { return 'SIMULATION'; } } as any,
      // Universe AUTO dalam pengujian: pemindaian tidak dibatasi daftar pair.
      { get isAuto() { return true; } } as any,
      indodax as any,
    );
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'debug').mockImplementation(() => undefined);
  });

  // ─── Keputusan analitis diperiksa sebelum skor ───────────────────────────

  it('TIDAK menawarkan setup berstatus NO_TRADE walau skornya tinggi', async () => {
    // Kasus nyata: ORCAIDR skor 71, decision NO_TRADE. Lolos ambang skor 70,
    // lalu ditolak Risk Engine. Tawaran itu seharusnya tidak pernah dikirim.
    scanner.scan.mockResolvedValue({ hits: [hit({ score: 71, decision: 'NO_TRADE' })], overview: [] });

    const r = await svc.findAndOffer();

    expect(confirm.offer).not.toHaveBeenCalled();
    expect(r.offered).toEqual([]);
    expect(risk.evaluateEntry).not.toHaveBeenCalled(); // tidak membuang panggilan
  });

  it('menawarkan TRADE_SETUP yang lolos ambang skor', async () => {
    const r = await svc.findAndOffer();
    expect(r.offered).toEqual(['btcidr']);
    expect(confirm.offer).toHaveBeenCalledTimes(1);
  });

  it('menawarkan HIGH_QUALITY_SETUP juga', async () => {
    scanner.scan.mockResolvedValue({ hits: [hit({ decision: 'HIGH_QUALITY_SETUP' })], overview: [] });
    expect((await svc.findAndOffer()).offered).toEqual(['btcidr']);
  });

  it('setup sah tetapi skor di bawah ambang tidak ditawarkan', async () => {
    scanner.scan.mockResolvedValue({ hits: [hit({ score: 65 })], overview: [] });
    const r = await svc.findAndOffer();
    expect(r.offered).toEqual([]);
    expect(r.skipped.join(' ')).toMatch(/di bawah ambang 70/);
  });

  it('membedakan "tidak ada setup" dari "skor kurang"', async () => {
    // Dua keadaan berbeda; pesan yang sama untuk keduanya membuat operator
    // tidak bisa tahu apakah sistemnya selektif atau rusak.
    scanner.scan.mockResolvedValue({ hits: [hit({ score: 71, decision: 'NO_TRADE' })], overview: [] });
    expect((await svc.findAndOffer()).skipped.join(' ')).toMatch(/semuanya NO_TRADE/);
  });

  // ─── Validasi Risk Engine sebelum menawarkan ─────────────────────────────

  it('tidak menawarkan bila Risk Engine menolak, dan menyebut alasannya', async () => {
    risk.evaluateEntry.mockResolvedValue({
      allowed: false,
      reason: 'Ukuran posisi 4000 IDR di bawah minimum 10000 IDR',
    });

    const r = await svc.findAndOffer();
    expect(confirm.offer).not.toHaveBeenCalled();
    expect(r.skipped.join(' ')).toMatch(/di bawah minimum 10000/);
  });

  it('alasan penolakan dibawa apa adanya, bukan diringkas jadi "ditolak"', async () => {
    risk.evaluateEntry.mockResolvedValue({ allowed: false, reason: 'jatah risiko harian habis' });
    expect((await svc.findAndOffer()).skipped.join(' ')).toContain('jatah risiko harian habis');
  });

  it('harga tidak terbaca tidak menggagalkan seluruh putaran', async () => {
    indodax.getTicker.mockRejectedValue(new Error('timeout'));
    const r = await svc.findAndOffer();
    expect(r.skipped.join(' ')).toMatch(/harga tidak terbaca/);
  });

  // ─── Tidak membanjiri ────────────────────────────────────────────────────

  it('tidak menawarkan pair yang sudah punya posisi terbuka', async () => {
    trades.find.mockResolvedValue([{ pair: 'BTCIDR' }]);
    const r = await svc.findAndOffer();
    expect(r.offered).toEqual([]);
    expect(r.skipped.join(' ')).toMatch(/sudah ada posisi/);
  });

  it('menghormati masa tenang agar pair yang sama tidak diulang', async () => {
    await svc.findAndOffer();
    expect(confirm.offer).toHaveBeenCalledTimes(1);

    const r = await svc.findAndOffer();
    expect(r.offered).toEqual([]);
    expect(r.skipped.join(' ')).toMatch(/masa tenang/);
  });

  it('masa tenang berakhir setelah waktunya lewat', async () => {
    await svc.findAndOffer();
    svc['lastOffered'].set('btcidr', Date.now() - 5 * 3_600_000); // 5 jam lalu
    expect((await svc.findAndOffer()).offered).toEqual(['btcidr']);
  });

  it('membatasi jumlah tawaran per pemeriksaan', async () => {
    scanner.scan.mockResolvedValue({
      hits: [hit({ pair: 'btcidr' }), hit({ pair: 'ethidr' }), hit({ pair: 'solidr' })],
      overview: [],
    });
    const r = await svc.findAndOffer();
    expect(r.offered).toHaveLength(2); // opportunityMaxPerScan
  });

  it('menawarkan skor tertinggi lebih dulu', async () => {
    scanner.scan.mockResolvedValue({
      hits: [hit({ pair: 'btcidr', score: 72 }), hit({ pair: 'ethidr', score: 95 })],
      overview: [],
    });
    expect((await svc.findAndOffer()).offered[0]).toBe('ethidr');
  });

  // ─── Menghormati penghenti ───────────────────────────────────────────────

  it('tidak menawarkan apa pun saat kill switch aktif', async () => {
    risk.checkKillSwitch.mockResolvedValue({ halted: true, reasons: ['drawdown harian terlampaui'] });
    const r = await svc.findAndOffer();
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(r.skipped.join(' ')).toMatch(/kill switch/);
  });

  it('cron tidak berjalan bila fitur dimatikan', async () => {
    params = makeParams({ opportunityAlertEnabled: false });
    await svc.watch();
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('kegagalan scanner tidak melempar keluar dari cron', async () => {
    scanner.scan.mockRejectedValue(new Error('scanner mati'));
    await expect(svc.watch()).resolves.toBeUndefined();
  });

  // ─── Isi tawaran ─────────────────────────────────────────────────────────

  it('tawaran memuat stop loss, TP, ukuran, dan risiko rupiah', async () => {
    await svc.findAndOffer();
    const pesan = confirm.offer.mock.calls[0][1] as string;

    expect(pesan).toMatch(/Stop loss/i);
    expect(pesan).toMatch(/TP1/);
    expect(pesan).toMatch(/TP2/);
    expect(pesan).toMatch(/Risiko/i);
    expect(pesan).toMatch(/Imbalan/i);
  });

  it('tawaran menyatakan bahwa order butuh konfirmasi kedua', async () => {
    // Tanpa ini, operator bisa mengira satu ketukan sudah memesan.
    await svc.findAndOffer();
    expect(confirm.offer.mock.calls[0][1]).toMatch(/konfirmasi kedua/i);
  });

  it('tawaran menyebut mode agar tidak tertukar simulasi dengan uang sungguhan', async () => {
    await svc.findAndOffer();
    expect(confirm.offer.mock.calls[0][1]).toMatch(/SIMULATION/);
  });
});

/**
 * Pembatasan pemindaian pada daftar pair yang disetel eksplisit.
 *
 * Pada 2026-10-09 pengawas menawarkan MUBARAKIDR padahal operator sudah
 * menyetel `TRADING_PAIRS=fartcoinidr,dogeidr` berdasarkan hasil backtest.
 * Pair itu memang likuid, tetapi tidak pernah diuji — dan ordernya gagal
 * karena presisi kuantitas yang baru diketahui setelah dicoba.
 */
describe('OpportunityWatcherService: menghormati TRADING_PAIRS', () => {
  const build = (isAuto: boolean, tradingPairs: string[]) => {
    const scanner = { scan: jest.fn().mockResolvedValue({ hits: [], overview: [] }) };
    const svc = Object.create(OpportunityWatcherService.prototype) as OpportunityWatcherService;
    Object.assign(svc, {
      trades: { find: jest.fn().mockResolvedValue([]) },
      notification: { isEnabled: () => true },
      tradeConfirm: { offer: jest.fn() },
      scanner,
      risk: { checkKillSwitch: jest.fn().mockResolvedValue({ halted: false, reasons: [] }) },
      config: {
        params: () => ({
          tradingPairs,
          opportunityMinScore: 70,
          opportunityCooldownHours: 4,
          opportunityMaxPerScan: 2,
        }),
        mode: 'SIMULATION',
      },
      universe: { get isAuto() { return isAuto; } },
      indodax: {},
      lastOffered: new Map(),
      logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    });
    return { svc, scanner };
  };

  it('daftar eksplisit membatasi pemindaian pada pair itu saja', async () => {
    const { svc, scanner } = build(false, ['fartcoinidr', 'dogeidr']);
    await svc.findAndOffer();
    expect(scanner.scan).toHaveBeenCalledWith({
      direction: 'LONG',
      pairs: ['fartcoinidr', 'dogeidr'],
    });
  });

  it('TRADING_PAIRS=auto tetap memindai seluruh pasar', async () => {
    const { svc, scanner } = build(true, ['btcidr']);
    await svc.findAndOffer();
    expect(scanner.scan).toHaveBeenCalledWith({ direction: 'LONG', pairs: undefined });
  });
});
