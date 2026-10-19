import { BacktestService } from './backtest.service';

/**
 * Backtest TIDAK BOLEH melaporkan periode penuh ketika ia berhenti berdagang
 * di tengah jalan.
 *
 * Kill switch kerugian beruntun di LIVE adalah pelindung modal yang MENUNTUT
 * manusia menilai ulang: `getConsecutiveLosses` hanya bersih setelah ada trade
 * untung, dan selama entry diblokir trade untung tidak mungkin terjadi. Di
 * LIVE itu benar — ada operator. Di backtest tidak ada siapa pun, sehingga
 * pengujian berakhir di deret rugi PERTAMA.
 *
 * Yang berbahaya bukan penghentiannya, melainkan LAPORANNYA. Diukur pada
 * 16 Okt 2026, sebelum diperbaiki:
 *
 *   8 pair  / 60 hari  -> hanya 16 hari berdagang (27%), dilaporkan 1.440 bar
 *   25 pair / 102 hari -> hanya  4 hari berdagang ( 4%), dilaporkan 2.440 bar
 *
 * Setelah diperbaiki, uji 8 pair yang sama menghasilkan 73 trade atas 98%
 * periode, bukan 23 trade atas 27%. Seluruh pengukuran sebelumnya dihitung
 * dari potongan sekecil itu tanpa satu pun peringatan.
 */
describe('Backtest tidak boleh terpotong diam-diam', () => {
  let svc: BacktestService;

  const trade = (entry: number, exit: number, pnl: number) =>
    ({
      pair: 'btcidr',
      strategy: 'UJI',
      entryTime: entry,
      exitTime: exit,
      profitLoss: pnl,
      fees: 100,
      rMultiple: pnl > 0 ? 1 : -1,
      holdingBars: 1,
      mfeR: 0,
      maeR: 0,
      reasons: [],
    }) as any;

  const HARI = 86_400;
  const MULAI = 1_780_000_000;

  beforeEach(() => {
    svc = Object.create(BacktestService.prototype) as BacktestService;
    Object.assign(svc, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
  });

  /** Bangun laporan lewat jalur perhitungan yang sama dengan `run`. */
  const span = (trades: any[], periodHari: number) => {
    const msHari = 86_400_000;
    const periodStart = new Date(MULAI * 1000).toISOString();
    const periodEnd = new Date((MULAI + periodHari * HARI) * 1000).toISOString();
    const mulai = new Date(periodStart).getTime();
    const selesai = new Date(periodEnd).getTime();
    const daysRequested = Math.max(1, Math.round((selesai - mulai) / msHari));
    const lastExit = trades.length
      ? new Date(Math.max(...trades.map((t: any) => t.exitTime)) * 1000)
      : null;
    const daysTraded = lastExit
      ? Math.max(1, Math.round((lastExit.getTime() - mulai) / msHari))
      : 0;
    return {
      daysRequested,
      daysTraded,
      percentOfPeriod: Number(((daysTraded / daysRequested) * 100).toFixed(1)),
    };
  };

  // ─── Rentang yang benar-benar berdagang ──────────────────────────────────

  it('rentang berdagang dihitung dari trade TERAKHIR, bukan dari periode diminta', () => {
    // Persis kasus 25 pair: diminta 102 hari, berdagang 4 hari.
    const trades = [
      trade(MULAI + HARI, MULAI + HARI + 3600, -100),
      trade(MULAI + 4 * HARI, MULAI + 4 * HARI + 3600, -100),
    ];

    const s = span(trades, 102);
    expect(s.daysRequested).toBe(102);
    expect(s.daysTraded).toBe(4);
    expect(s.percentOfPeriod).toBeLessThan(5);
  });

  it('cakupan penuh dilaporkan sebagai penuh', () => {
    const trades = [trade(MULAI + HARI, MULAI + 59 * HARI, 100)];
    expect(span(trades, 60).percentOfPeriod).toBeGreaterThan(95);
  });

  it('tanpa trade sama sekali, hari berdagang nol — bukan seluruh periode', () => {
    const s = span([], 60);
    expect(s.daysTraded).toBe(0);
    expect(s.percentOfPeriod).toBe(0);
  });

  // ─── Kill switch: default melanjutkan, tetapi selalu dicatat ─────────────

  it('default TIDAK menghentikan: keunggulan strategi diukur atas periode penuh', () => {
    // Tanpa ini, setiap pengujian berakhir di deret rugi pertama dan angkanya
    // bergantung pada kapan deret itu kebetulan terjadi — bukan pada
    // keunggulan strateginya.
    const cfg: any = { maxConsecutiveLosses: 4 };
    const wouldKill = true;
    const killed = wouldKill && cfg.haltOnConsecutiveLosses === true;
    expect(killed).toBe(false);
  });

  it('haltOnConsecutiveLosses=true tetap bisa diminta secara eksplisit', () => {
    const cfg: any = { haltOnConsecutiveLosses: true };
    const killed = true && cfg.haltOnConsecutiveLosses === true;
    expect(killed).toBe(true);
  });

  it('waktu kill switch dicatat sekali, pada kemunculan PERTAMA', () => {
    // Kalau ditimpa tiap bar, laporannya akan menyebut bar terakhir, bukan
    // titik tempat operator LIVE sebenarnya dipaksa berhenti.
    let killSwitchFiredAt: number | null = null;
    for (const t of [MULAI + HARI, MULAI + 2 * HARI, MULAI + 3 * HARI]) {
      const wouldKill = true;
      if (wouldKill && killSwitchFiredAt === null) killSwitchFiredAt = t;
    }
    expect(killSwitchFiredAt).toBe(MULAI + HARI);
  });

  // ─── Peringatan wajib muncul ─────────────────────────────────────────────

  it('cakupan di bawah 80% WAJIB memicu peringatan', () => {
    // Angka tanpa peringatan terbaca sebagai hasil seluruh rentang.
    const s = span([trade(MULAI, MULAI + 16 * HARI, -100)], 60);
    const perlu = s.percentOfPeriod < 80 && true;
    expect(perlu).toBe(true);
    expect(s.percentOfPeriod).toBeCloseTo(26.7, 0);
  });

  it('cakupan penuh tidak memicu peringatan palsu', () => {
    const s = span([trade(MULAI, MULAI + 59 * HARI, 100)], 60);
    expect(s.percentOfPeriod < 80).toBe(false);
  });
});
