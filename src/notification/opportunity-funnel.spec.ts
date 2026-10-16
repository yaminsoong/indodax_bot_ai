import { OpportunityWatcherService } from './opportunity-watcher.service';

/**
 * Dua menu TIDAK BOLEH menyatakan hal yang saling bertentangan tentang pair
 * yang sama.
 *
 * Kejadian nyata 16 Okt 2026: satu menu menampilkan `STRKIDR — skor 70/100`
 * sementara `/peluang` berkata "Lolos ambang skor: 0 pair" dengan ambang 70.
 * Keduanya tidak mungkin sama-sama benar.
 *
 * Sebabnya bukan salah hitung, melainkan salah LABEL: angka itu dihitung
 * setelah penyaring KEPUTUSAN, padahal namanya menyebut SKOR. Pair berskor 70
 * yang keputusannya NO_TRADE hilang dari hitungan tanpa jejak.
 *
 * Karena itu corongnya kini dilaporkan utuh, dan tiap angka dihitung dari
 * kumpulan hit YANG SAMA supaya bisa dipertanggungjawabkan satu terhadap yang
 * lain.
 */
describe('Corong penyaring peluang', () => {
  let svc: OpportunityWatcherService;
  let scanner: { scan: jest.Mock };
  let risk: { checkKillSwitch: jest.Mock };
  let trades: { find: jest.Mock };

  const hit = (pair: string, score: number, decision: string) => ({
    pair,
    score,
    decision,
    type: 'SETUP',
    timeframe: '1H',
    direction: 'LONG',
    regime: 'BULL_TREND',
    price: 1000,
    detail: '',
  });

  beforeEach(() => {
    scanner = { scan: jest.fn().mockResolvedValue({ hits: [], overview: [], prefilter: {} }) };
    risk = { checkKillSwitch: jest.fn().mockResolvedValue({ halted: false, reasons: [] }) };
    trades = { find: jest.fn().mockResolvedValue([]) };

    svc = Object.create(OpportunityWatcherService.prototype) as OpportunityWatcherService;
    Object.assign(svc, {
      scanner,
      risk,
      trades,
      config: {
        params: () => ({
          opportunityMinScore: 70,
          tradingPairs: [],
          opportunityCooldownHours: 4,
          maxOpenPositions: 3,
        }),
      },
      lastOffered: new Map<string, number>(),
      universe: { isAuto: true },
      confirm: { sendDashboardCard: jest.fn(), offerNow: jest.fn() },
      tradeConfirm: { offer: jest.fn().mockResolvedValue(undefined) },
      indodax: { getTicker: jest.fn().mockResolvedValue({ last: 1000 }) },
      // Rencana selalu siap: suite ini menguji CORONGNYA, bukan penyusunan
      // rencana — itu punya pengujiannya sendiri.
      buildPlan: jest.fn().mockResolvedValue({ ok: true, message: 'rencana' }),
      notification: { isEnabled: () => true, sendWithButtons: jest.fn() },
      affordability: { check: jest.fn() },
      portfolio: { getState: jest.fn().mockResolvedValue({ equityIdr: 1_000_000 }) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  // ─── Kasus yang memicu tes ini ───────────────────────────────────────────

  it('pair yang lolos SKOR tetapi gagal KEPUTUSAN tetap terhitung', async () => {
    // Persis kasus STRKIDR: skor 70 dengan ambang 70, keputusan NO_TRADE.
    scanner.scan.mockResolvedValue({
      hits: [hit('strkidr', 70, 'NO_TRADE'), hit('btcidr', 72, 'NO_TRADE')],
      overview: [],
      prefilter: {},
    });

    const r = await svc.findAndOffer();

    expect(r.funnel.totalHits).toBe(2);
    // Keduanya mencapai ambang skor — ini yang dulu tidak terlihat.
    expect(r.funnel.passedScore).toBe(2);
    expect(r.funnel.passedDecision).toBe(0);
    expect(r.funnel.passedBoth).toBe(0);
    expect(r.offered).toHaveLength(0);
  });

  it('ambang skor dilaporkan apa adanya agar bisa dicocokkan menu lain', async () => {
    const r = await svc.findAndOffer();
    expect(r.funnel.minScore).toBe(70);
  });

  it('skor di BAWAH ambang tidak dihitung lolos skor', async () => {
    scanner.scan.mockResolvedValue({
      hits: [hit('adaidr', 69, 'NO_TRADE')],
      overview: [],
      prefilter: {},
    });

    const r = await svc.findAndOffer();
    expect(r.funnel.passedScore).toBe(0);
  });

  it('tepat di ambang dihitung lolos', async () => {
    scanner.scan.mockResolvedValue({ hits: [hit('x', 70, 'NO_TRADE')], overview: [], prefilter: {} });
    expect((await svc.findAndOffer()).funnel.passedScore).toBe(1);
  });

  // ─── Sisi sebaliknya ─────────────────────────────────────────────────────

  it('lolos KEPUTUSAN tetapi skor kurang juga terlihat', async () => {
    // Keadaan sebaliknya: tidak ada blocker, tetapi kualitasnya di bawah
    // ambang. Tindakannya beda — ini menunggu kualitas, bukan menunggu aturan.
    scanner.scan.mockResolvedValue({
      hits: [hit('dogeidr', 55, 'TRADE_SETUP')],
      overview: [],
      prefilter: {},
    });

    const r = await svc.findAndOffer();
    expect(r.funnel.passedDecision).toBe(1);
    expect(r.funnel.passedScore).toBe(0);
    expect(r.funnel.passedBoth).toBe(0);
  });

  it('HIGH_QUALITY_SETUP dihitung lolos keputusan, sama seperti TRADE_SETUP', async () => {
    scanner.scan.mockResolvedValue({
      hits: [hit('a', 80, 'HIGH_QUALITY_SETUP'), hit('b', 80, 'TRADE_SETUP')],
      overview: [],
      prefilter: {},
    });

    expect((await svc.findAndOffer()).funnel.passedDecision).toBe(2);
  });

  // ─── Angka harus saling konsisten ────────────────────────────────────────

  it('lolos keduanya tidak pernah melebihi angka mana pun di atasnya', async () => {
    scanner.scan.mockResolvedValue({
      hits: [
        hit('a', 80, 'TRADE_SETUP'),
        hit('b', 75, 'NO_TRADE'),
        hit('c', 60, 'TRADE_SETUP'),
        hit('d', 50, 'NO_TRADE'),
      ],
      overview: [],
      prefilter: {},
    });

    const f = (await svc.findAndOffer()).funnel;
    expect(f.passedBoth).toBeLessThanOrEqual(f.passedScore);
    expect(f.passedBoth).toBeLessThanOrEqual(f.passedDecision);
    expect(f.passedScore).toBeLessThanOrEqual(f.totalHits);
    expect(f.passedDecision).toBeLessThanOrEqual(f.totalHits);
    expect(f).toEqual({
      totalHits: 4,
      passedScore: 2,
      passedDecision: 2,
      passedBoth: 1,
      minScore: 70,
    });
  });

  it('considered tetap sama dengan lolos keduanya', async () => {
    // Pemanggil lama membaca `considered`; artinya tidak boleh berubah.
    scanner.scan.mockResolvedValue({
      hits: [hit('a', 80, 'TRADE_SETUP'), hit('b', 75, 'NO_TRADE')],
      overview: [],
      prefilter: {},
    });

    const r = await svc.findAndOffer();
    expect(r.considered).toBe(r.funnel.passedBoth);
  });

  // ─── Kill switch ─────────────────────────────────────────────────────────

  it('kill switch aktif tetap mengembalikan corong, bukan undefined', async () => {
    // Pembaca corong tidak boleh pecah hanya karena bot sedang dihentikan.
    risk.checkKillSwitch.mockResolvedValue({ halted: true, reasons: ['drawdown 20%'] });

    const r = await svc.findAndOffer();
    expect(r.funnel).toBeDefined();
    expect(r.funnel.minScore).toBe(70);
    expect(r.skipped[0]).toMatch(/kill switch/);
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});
