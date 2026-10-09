import { RiskService } from './risk.service';
import { Trade } from '../database/entities/trade.entity';
import { makeParams } from '../../test/fixtures/bot-params';
import { BotParams } from '../config/bot-config.service';

/**
 * Take profit bertingkat menentukan berapa banyak posisi dijual dan kapan.
 * Kesalahan di sini berbiaya langsung dan sulit terlihat dari log, jadi tiap
 * cabangnya diuji — termasuk kasus yang dulu merusak versi partial tunggal.
 */
describe('Take profit bertingkat', () => {
  let svc: RiskService;
  let params: BotParams;

  const config = {
    params: () => params,
    get mode() {
      return 'SIMULATION';
    },
    correlationGroup: () => 'OTHER',
  };
  const pairs = {
    takerFeeRate: () => 0.002,
    makerFeeRate: () => 0.001,
    feeRate: (_p: string, maker: boolean) => (maker ? 0.001 : 0.002),
    isTradable: () => ({ ok: true }),
    require: () => ({ minOrderIdr: 10000, tradedCurrency: 'btc' }),
  };

  beforeEach(() => {
    params = makeParams();
    svc = new RiskService(
      config as any,
      pairs as any,
      // Spread tidak diketahui dalam pengujian ini: null memaksa jalur
      // cadangan (tick size) alih-alih mengarang angka spread.
      { getCachedSpreadPercent: () => null } as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
    );
  });

  // ─── Urutan tingkat ──────────────────────────────────────────────────────

  it('memproses tingkat secara berurutan walau harga melonjak jauh', () => {
    // Harga langsung ke 10R. Tetap TP1 yang diproses lebih dulu — melewatkan
    // tingkat akan menyisakan porsinya tidak pernah terjual.
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
    expect(svc.nextTakeProfitLevel(t, 1500)?.index).toBe(0);
  });

  it('tingkat berikutnya baru aktif setelah yang sebelumnya tercatat', () => {
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 1 });
    // TP2 di 2R = 1100. Harga 1090 belum cukup walau jauh di atas TP1.
    expect(svc.nextTakeProfitLevel(t, 1090)).toBeNull();
    expect(svc.nextTakeProfitLevel(t, 1100)?.index).toBe(1);
  });

  it('menandai tingkat terakhir sebagai final agar sisa ditutup penuh', () => {
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 2 });
    const level = svc.nextTakeProfitLevel(t, 1175); // 3.5R
    expect(level?.isFinal).toBe(true);
    expect(level?.index).toBe(2);
  });

  it('berhenti setelah seluruh tingkat terisi', () => {
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 3 });
    expect(svc.nextTakeProfitLevel(t, 99999)).toBeNull();
  });

  // ─── Pembagian porsi ─────────────────────────────────────────────────────

  it('porsi seluruh tingkat berjumlah tepat 100 persen', () => {
    const total = svc.takeProfitPlan(1000, 50).reduce((s, l) => s + l.closePercent, 0);
    expect(total).toBe(100);
  });

  it('porsi dihitung dari posisi AWAL, bukan sisa', () => {
    // Inti perbedaannya: 30% + 30% + 40% dari posisi awal menghabiskan posisi.
    // Bila dihitung dari sisa, 30% lalu 30% dari 70% hanya 21%, dan seterusnya
    // menyisakan remah yang jatuh di bawah minimum order.
    const plan = svc.takeProfitPlan(1000, 50);
    const quantity = 10;
    const sold = plan.reduce((s, l) => s + quantity * (l.closePercent / 100), 0);
    expect(sold).toBeCloseTo(quantity, 10);
  });

  it('harga tiap tingkat naik sesuai kelipatan risikonya', () => {
    const plan = svc.takeProfitPlan(1000, 50);
    expect(plan.map((l) => l.price)).toEqual([1050, 1100, 1175]);
    expect(plan.map((l) => l.atR)).toEqual([1.0, 2.0, 3.5]);
  });

  // ─── Konfigurasi menyimpang ──────────────────────────────────────────────

  it('membatasi total porsi pada 100 persen walau dikonfigurasi berlebih', () => {
    // Menjual lebih dari yang dimiliki akan ditolak exchange di tengah jalan
    // dan meninggalkan posisi setengah tertutup.
    params = makeParams({
      takeProfitLevels: [
        { atR: 1, closePercent: 60 },
        { atR: 2, closePercent: 60 },
        { atR: 3, closePercent: 60 },
      ],
    });
    const total = svc.takeProfitPlan(1000, 50).reduce((s, l) => s + l.closePercent, 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it('mendukung satu target tunggal bila hanya satu tingkat dikonfigurasi', () => {
    params = makeParams({ takeProfitLevels: [{ atR: 3, closePercent: 100 }] });
    const plan = svc.takeProfitPlan(1000, 50);
    expect(plan).toHaveLength(1);
    expect(plan[0].price).toBe(1150);

    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
    expect(svc.nextTakeProfitLevel(t, 1150)?.isFinal).toBe(true);
  });

  it('tidak memicu apa pun bila daftar tingkat kosong', () => {
    params = makeParams({ takeProfitLevels: [] });
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
    expect(svc.nextTakeProfitLevel(t, 99999)).toBeNull();
    expect(svc.takeProfitPlan(1000, 50)).toEqual([]);
  });

  it('mengembalikan null bila risiko awal tidak diketahui', () => {
    // Tanpa jarak risiko, "1R" tidak punya arti dan tingkat tidak bisa dihitung.
    const t = makeTrade({ initialRiskPerUnit: 0, tpLevelsFilled: 0 });
    expect(svc.nextTakeProfitLevel(t, 99999)).toBeNull();
  });

  it('tidak memicu saat posisi sedang rugi', () => {
    const t = makeTrade({ entryPrice: 1000, initialRiskPerUnit: 50, tpLevelsFilled: 0 });
    expect(svc.nextTakeProfitLevel(t, 970)).toBeNull();
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
    quantity: 10,
    remainingQuantity: 10,
    totalValue: 10000,
    entryFee: 0,
    exitFee: 0,
    stopLossPrice: 950,
    takeProfitPrice: 1150,
    trailingStopPrice: 0,
    initialRiskPerUnit: 50,
    riskAmountIdr: 500,
    breakEvenMoved: 0,
    tpLevelsFilled: 0,
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
