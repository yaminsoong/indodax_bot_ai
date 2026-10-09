import { RiskService, startOfTradingDay } from './risk.service';
import { Trade } from '../database/entities/trade.entity';
import { BotParams } from '../config/bot-config.service';
import { makeParams } from '../../test/fixtures/bot-params';

/**
 * Aturan risiko menentukan berapa uang yang dipertaruhkan dan kapan kerugian
 * dihentikan. Kesalahan di sini berbiaya langsung, jadi setiap cabangnya diuji.
 */
describe('RiskService', () => {
  const defaultParams: BotParams = makeParams();

  let svc: RiskService;
  let params: BotParams;

  const config = {
    params: () => params,
    get mode() {
      return 'SIMULATION';
    },
    correlationGroup: (pair: string) =>
      ['btcidr', 'ethidr'].includes(pair) ? 'MAJOR' : 'OTHER',
  };

  const pairs = {
    takerFeeRate: () => 0.002, // 0.2% seperti Indodax
    isTradable: () => ({ ok: true }),
    require: () => ({ minOrderIdr: 10000, tradedCurrency: 'btc' }),
  };

  beforeEach(() => {
    params = { ...defaultParams };
    svc = new RiskService(
      config as any,
      pairs as any,
      {} as any, // portfolio — di-stub per test
      { log: jest.fn() } as any,
      {} as any, // tradeRepo — di-stub per test
    );
  });

  // ─── Batas hari WIB ─────────────────────────────────────────────────────

  describe('startOfTradingDay', () => {
    it('mengembalikan tengah malam WIB, bukan waktu lokal server', () => {
      // 09:00 WIB tanggal 9 → awal hari = 8 Sep 17:00 UTC
      const start = startOfTradingDay(new Date('2026-09-09T02:00:00Z'));
      expect(start.toISOString()).toBe('2026-09-08T17:00:00.000Z');
    });

    it('berpindah hari tepat pada 00:00 WIB', () => {
      const before = startOfTradingDay(new Date('2026-09-09T16:59:59Z'));
      const after = startOfTradingDay(new Date('2026-09-09T17:00:00Z'));
      expect(before.toISOString()).toBe('2026-09-08T17:00:00.000Z');
      expect(after.toISOString()).toBe('2026-09-09T17:00:00.000Z');
    });

    it('tidak pernah menghasilkan waktu di masa depan', () => {
      for (const iso of ['2026-01-01T00:00:00Z', '2026-06-15T12:00:00Z', '2026-12-31T23:59:00Z']) {
        const now = new Date(iso);
        const start = startOfTradingDay(now);
        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(now.getTime() - start.getTime()).toBeLessThan(24 * 3600_000);
      }
    });
  });

  // ─── P&L dengan fee ─────────────────────────────────────────────────────

  describe('calculatePnL', () => {
    it('membebankan fee kedua sisi', () => {
      const trade = makeTrade({
        entryPrice: 1000,
        quantity: 10,
        entryFee: 20, // 0.2% dari 10.000
        initialRiskPerUnit: 15,
      });

      // Jual di harga sama: seharusnya rugi sebesar total fee, bukan impas.
      const r = svc.calculatePnL(trade, 1000, 10);

      const exitFee = 1000 * 10 * 0.002; // 20
      expect(r.exitFee).toBeCloseTo(exitFee, 6);
      // proceeds 10.000 - 20 = 9.980; cost 10.000 + 20 = 10.020 → -40
      expect(r.profitLoss).toBeCloseTo(-40, 6);
      expect(r.profitLoss).toBeLessThan(0);
    });

    it('menghitung keuntungan bersih setelah fee', () => {
      const trade = makeTrade({
        entryPrice: 1000,
        quantity: 10,
        entryFee: 20,
        initialRiskPerUnit: 15,
      });
      // Naik 3%: kotor +300, fee keluar 1030*10*0.002 = 20.6
      const r = svc.calculatePnL(trade, 1030, 10);
      expect(r.profitLoss).toBeCloseTo(10300 - 20.6 - 10020, 4);
      expect(r.profitLoss).toBeGreaterThan(0);
    });

    it('menghitung R-multiple dari risiko awal', () => {
      const trade = makeTrade({
        entryPrice: 1000,
        quantity: 10,
        entryFee: 0,
        initialRiskPerUnit: 100, // risiko total 1000
      });
      // Naik 100/unit = +1000 kotor; fee 1100*10*0.002 = 22 → 978 bersih
      const r = svc.calculatePnL(trade, 1100, 10);
      expect(r.rMultiple).toBeCloseTo(978 / 1000, 4);
    });

    it('membagi fee entry secara proporsional pada penjualan sebagian', () => {
      const trade = makeTrade({
        entryPrice: 1000,
        quantity: 10,
        entryFee: 20,
        initialRiskPerUnit: 50,
      });
      // Jual separuh: hanya separuh fee entry yang dibebankan.
      const r = svc.calculatePnL(trade, 1000, 5);
      // proceeds 5000 - 10 = 4990; cost 5000 + 10 = 5010 → -20
      expect(r.profitLoss).toBeCloseTo(-20, 6);
    });
  });

  // ─── Pemicu stop / target ───────────────────────────────────────────────

  describe('shouldTriggerStopLoss', () => {
    it('memicu saat harga menyentuh stop awal', () => {
      const t = makeTrade({ stopLossPrice: 950, trailingStopPrice: 0 });
      expect(svc.shouldTriggerStopLoss(t, 950)).toBe(true);
      expect(svc.shouldTriggerStopLoss(t, 951)).toBe(false);
    });

    it('memakai trailing stop bila lebih tinggi dari stop awal', () => {
      const t = makeTrade({ stopLossPrice: 950, trailingStopPrice: 980 });
      expect(svc.shouldTriggerStopLoss(t, 975)).toBe(true);
    });

    it('mengabaikan trailing yang lebih rendah dari stop awal', () => {
      // Trailing tidak boleh memperlonggar perlindungan.
      const t = makeTrade({ stopLossPrice: 950, trailingStopPrice: 900 });
      expect(svc.shouldTriggerStopLoss(t, 940)).toBe(true);
      expect(svc.shouldTriggerStopLoss(t, 960)).toBe(false);
    });
  });

  // ─── Break-even & trailing ──────────────────────────────────────────────

  describe('calculateStopUpdate', () => {
    it('mengunci break-even di atas harga entry termasuk fee', () => {
      const t = makeTrade({
        entryPrice: 1000,
        stopLossPrice: 950,
        initialRiskPerUnit: 50,
        breakEvenMoved: 0,
      });
      // +1R = harga 1050
      const u = svc.calculateStopUpdate(t, 1050, 0)!;
      expect(u).not.toBeNull();
      expect(u.movedToBreakEven).toBe(true);
      // Titik impas = 1000 * (1 + 0.002*2) = 1004
      expect(u.newStop).toBeCloseTo(1004, 6);
      expect(u.newStop).toBeGreaterThan(t.entryPrice);
    });

    it('tidak menggeser stop sebelum mencapai ambang R', () => {
      const t = makeTrade({ entryPrice: 1000, stopLossPrice: 950, initialRiskPerUnit: 50 });
      expect(svc.calculateStopUpdate(t, 1020, 0)).toBeNull(); // baru +0.4R
    });

    it('mengikuti harga dengan jarak ATR setelah break-even', () => {
      const t = makeTrade({
        entryPrice: 1000,
        stopLossPrice: 950,
        initialRiskPerUnit: 50,
        breakEvenMoved: 1,
        trailingStopPrice: 1004,
      });
      // Harga 1200, ATR 20, pengali 2 → trailing 1160
      const u = svc.calculateStopUpdate(t, 1200, 20)!;
      expect(u.newStop).toBeCloseTo(1160, 6);
    });

    it('tidak pernah menurunkan stop', () => {
      const t = makeTrade({
        entryPrice: 1000,
        stopLossPrice: 950,
        initialRiskPerUnit: 50,
        breakEvenMoved: 1,
        trailingStopPrice: 1150,
      });
      // Harga turun ke 1100; trailing hitung 1060 < 1150 → tidak ada update
      expect(svc.calculateStopUpdate(t, 1100, 20)).toBeNull();
    });

    it('mengembalikan null bila risiko awal tidak diketahui', () => {
      const t = makeTrade({ initialRiskPerUnit: 0 });
      expect(svc.calculateStopUpdate(t, 1200, 20)).toBeNull();
    });
  });

  // ─── Partial take profit ────────────────────────────────────────────────

  describe('nextTakeProfitLevel', () => {
    it('memicu tingkat pertama pada ambang R-nya', () => {
      const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
      // TP1 default pada 1.0R = harga 1050
      expect(svc.nextTakeProfitLevel(t, 1050)?.index).toBe(0);
      expect(svc.nextTakeProfitLevel(t, 1049)).toBeNull();
    });

    it('melanjutkan ke tingkat berikutnya setelah yang pertama terisi', () => {
      const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 1 });
      // TP2 default pada 2.0R = harga 1100
      expect(svc.nextTakeProfitLevel(t, 1100)?.index).toBe(1);
      // Belum sampai TP2 walau sudah jauh di atas TP1.
      expect(svc.nextTakeProfitLevel(t, 1080)).toBeNull();
    });

    it('menandai tingkat terakhir sebagai final', () => {
      const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 2 });
      const level = svc.nextTakeProfitLevel(t, 2000);
      expect(level?.isFinal).toBe(true);
    });

    it('berhenti setelah seluruh tingkat terisi', () => {
      const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 3 });
      expect(svc.nextTakeProfitLevel(t, 9999)).toBeNull();
    });

    it('mengembalikan null bila risiko awal tidak diketahui', () => {
      const t = makeTrade({ initialRiskPerUnit: 0, tpLevelsFilled: 0 });
      expect(svc.nextTakeProfitLevel(t, 5000)).toBeNull();
    });

    it('tidak pernah melewati satu tingkat sekaligus', () => {
      // Harga melonjak langsung ke 5R; tingkat tetap diproses berurutan agar
      // tidak ada porsi yang tidak pernah terjual.
      const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
      expect(svc.nextTakeProfitLevel(t, 1250)?.index).toBe(0);
    });
  });

  describe('takeProfitPlan', () => {
    it('menghitung harga tiap tingkat dari risiko per unit', () => {
      const plan = svc.takeProfitPlan(1000, 50);
      expect(plan).toHaveLength(3);
      expect(plan[0].price).toBeCloseTo(1050, 6); // 1.0R
      expect(plan[1].price).toBeCloseTo(1100, 6); // 2.0R
      expect(plan[2].price).toBeCloseTo(1175, 6); // 3.5R
    });

    it('porsi seluruh tingkat berjumlah 100 persen', () => {
      const total = svc.takeProfitPlan(1000, 50).reduce((s, l) => s + l.closePercent, 0);
      expect(total).toBe(100);
    });
  });

  // ─── Batas durasi ───────────────────────────────────────────────────────

  describe('isStale', () => {
    it('menandai posisi yang melewati batas jam', () => {
      const t = makeTrade({ openedAt: new Date(Date.now() - 49 * 3600_000) });
      expect(svc.isStale(t)).toBe(true);
    });

    it('tidak menandai posisi yang masih dalam batas', () => {
      const t = makeTrade({ openedAt: new Date(Date.now() - 2 * 3600_000) });
      expect(svc.isStale(t)).toBe(false);
    });

    it('nonaktif bila maxHoldingHours = 0', () => {
      params.maxHoldingHours = 0;
      const t = makeTrade({ openedAt: new Date(Date.now() - 500 * 3600_000) });
      expect(svc.isStale(t)).toBe(false);
    });
  });
});

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    pair: 'btcidr',
    type: 'BUY',
    status: 'OPEN',
    mode: 'SIMULATION',
    strategy: 'TEST',
    entryPrice: 1000,
    signalPrice: 1000,
    quantity: 10,
    remainingQuantity: 10,
    totalValue: 10000,
    entryFee: 0,
    exitFee: 0,
    stopLossPrice: 950,
    takeProfitPrice: 1100,
    trailingStopPrice: 0,
    initialRiskPerUnit: 50,
    riskAmountIdr: 500,
    breakEvenMoved: 0,
    partialTaken: 0,
    realizedPnl: 0,
    highestPrice: 1000,
    lowestPrice: 1000,
    closeAttempts: 0,
    openedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Trade;
}
