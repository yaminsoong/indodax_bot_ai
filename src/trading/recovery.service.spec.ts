import { RecoveryService } from './recovery.service';
import { buildSignalRef } from './trading.service';
import { Trade } from '../database/entities/trade.entity';

/** Repositori palsu berbasis array - cukup untuk menguji alur pemulihan. */
function fakeRepo(rows: Partial<Trade>[]) {
  const store = rows.map((r, i) => ({ id: i + 1, ...r })) as Trade[];
  return {
    store,
    find: jest.fn(async ({ where }: any = {}) => {
      if (!where) return store;
      if (where.status?._type === 'in') {
        return store.filter((t) => where.status._value.includes(t.status));
      }
      return store.filter((t) => t.status === where.status);
    }),
    findOne: jest.fn(async ({ where }: any) => store.find((t) => t.id === where.id) ?? null),
    count: jest.fn(async ({ where }: any = {}) =>
      where ? store.filter((t) => t.status === where.status).length : store.length,
    ),
    update: jest.fn(async (id: number, patch: any) => {
      const row = store.find((t) => t.id === id);
      if (row) Object.assign(row, patch);
    }),
  };
}

function baseTrade(overrides: Partial<Trade> = {}): Partial<Trade> {
  return {
    pair: 'btcidr',
    status: 'FAILED',
    mode: 'LIVE',
    strategy: 'EMA_SCALPING_V2',
    entryPrice: 100_000_000,
    quantity: 0.01,
    remainingQuantity: 0.01,
    totalValue: 1_000_000,
    entryFee: 2000,
    stopLossPrice: 98_000_000,
    takeProfitPrice: 104_000_000,
    initialRiskPerUnit: 2_000_000,
    realizedPnl: 0,
    closeAttempts: 5,
    lastError: 'Order jual tidak terisi',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Deps {
  repo: ReturnType<typeof fakeRepo>;
  execution: any;
  indodax: any;
  notification: any;
  audit: any;
}

function build(rows: Partial<Trade>[], overrides: Partial<Deps> = {}) {
  const repo = overrides.repo ?? fakeRepo(rows);

  const config: any = {
    mode: 'LIVE',
    isLive: true,
    bool: (_key: string, fallback: boolean) => fallback,
    params: () => ({}),
  };

  const indodax = overrides.indodax ?? {
    hasCredentials: () => true,
    getBalance: jest.fn(async () => ({ idr: 5_000_000, btc: 0 })),
    getTicker: jest.fn(async () => ({ last: 99_000_000 })),
    getTradeHistory: jest.fn(async () => []),
  };

  const pairs: any = {
    require: () => ({ tradedCurrency: 'btc', minOrderIdr: 10000, takerFeePercent: 0.2 }),
    takerFeeRate: () => 0.002,
  };

  const execution = overrides.execution ?? {
    execute: jest.fn(async () => ({
      success: true,
      filledCoin: 0.01,
      filledIdr: 990_000,
      avgPrice: 99_000_000,
      feeIdr: 1980,
      partial: false,
      slippagePercent: 0,
      style: 'TAKER',
    })),
  };

  const portfolio: any = { adjustSimulatedCash: jest.fn() };

  const risk: any = {
    calculatePnL: (trade: Trade, exitPrice: number, qty?: number) => {
      const quantity = qty ?? trade.remainingQuantity ?? trade.quantity;
      const profitLoss = (exitPrice - trade.entryPrice) * quantity;
      return { profitLoss, profitLossPercent: 0, exitFee: 0, rMultiple: 0 };
    },
  };

  const notification = overrides.notification ?? {
    sendAlert: jest.fn(async () => undefined),
    sendInfo: jest.fn(async () => undefined),
  };

  const audit = overrides.audit ?? { log: jest.fn(async () => undefined) };

  const service = new RecoveryService(
    config,
    indodax,
    pairs,
    execution,
    portfolio,
    risk,
    notification,
    audit,
    repo as any,
  );

  return { service, repo, execution, indodax, notification, audit };
}

describe('buildSignalRef (proteksi order ganda)', () => {
  it('menghasilkan kunci yang sama untuk pair, strategi, dan candle yang sama', () => {
    expect(buildSignalRef('BTCIDR', 'EMA_SCALPING_V2', 1700000000)).toBe(
      buildSignalRef('btcidr', 'EMA_SCALPING_V2', 1700000000),
    );
  });

  it('berbeda bila candle-nya berbeda', () => {
    expect(buildSignalRef('btcidr', 'EMA_SCALPING_V2', 1700000000)).not.toBe(
      buildSignalRef('btcidr', 'EMA_SCALPING_V2', 1700000900),
    );
  });

  it('berbeda antar pair dan antar strategi', () => {
    expect(buildSignalRef('btcidr', 'A', 1)).not.toBe(buildSignalRef('ethidr', 'A', 1));
    expect(buildSignalRef('btcidr', 'A', 1)).not.toBe(buildSignalRef('btcidr', 'B', 1));
  });

  it('tanpa waktu candle memakai jendela satu menit', () => {
    const a = buildSignalRef('btcidr', 'A');
    const b = buildSignalRef('btcidr', 'A');
    expect(a).toBe(b);
    expect(a).toMatch(/^btcidr:A:\d+$/);
  });
});

describe('RecoveryService', () => {
  it('menandai posisi CLOSED bila koinnya sudah tidak ada di exchange', async () => {
    const { service, repo } = build([baseTrade()]);
    const report = await service.recover();

    expect(report.results[0].outcome).toBe('RECONCILED_CLOSED');
    expect(repo.store[0].status).toBe('CLOSED');
    expect(repo.store[0].closeReason).toBe('RECOVERED_RECONCILED');
    expect(report.needsAttention).toBe(false);
  });

  it('tidak mengarang P&L saat harga keluar tidak dapat dipastikan', async () => {
    const { service, repo } = build([baseTrade()]);
    await service.recover();

    expect(repo.store[0].profitLoss).toBeNull();
    expect(repo.store[0].lastError).toMatch(/tidak dapat dipastikan/);
  });

  it('memakai harga dari riwayat trade exchange bila tersedia', async () => {
    const indodax = {
      hasCredentials: () => true,
      getBalance: jest.fn(async () => ({ idr: 5_000_000, btc: 0 })),
      getTicker: jest.fn(async () => ({ last: 99_000_000 })),
      getTradeHistory: jest.fn(async () => [
        { type: 'sell', price: '101000000', trade_time: 2 },
        { type: 'sell', price: '95000000', trade_time: 1 },
      ]),
    };
    const { service, repo } = build([baseTrade()], { indodax });
    await service.recover();

    expect(repo.store[0].exitPrice).toBe(101_000_000);
    expect(repo.store[0].profitLoss).toBeGreaterThan(0);
  });

  it('menjual ulang posisi yang koinnya masih dipegang', async () => {
    const indodax = {
      hasCredentials: () => true,
      getBalance: jest.fn(async () => ({ idr: 5_000_000, btc: 0.01 })),
      getTicker: jest.fn(async () => ({ last: 99_000_000 })),
      getTradeHistory: jest.fn(async () => []),
    };
    const { service, repo, execution } = build([baseTrade()], { indodax });
    const report = await service.recover();

    expect(execution.execute).toHaveBeenCalled();
    expect(execution.execute.mock.calls[0][0].urgent).toBe(true);
    expect(report.results[0].outcome).toBe('RECOVERED_SOLD');
    expect(repo.store[0].status).toBe('CLOSED');
    expect(repo.store[0].closeReason).toBe('RECOVERED_SOLD');
  });

  it('meminta tindakan manual bila penjualan ulang tetap gagal', async () => {
    const indodax = {
      hasCredentials: () => true,
      getBalance: jest.fn(async () => ({ idr: 0, btc: 0.01 })),
      getTicker: jest.fn(async () => ({ last: 99_000_000 })),
      getTradeHistory: jest.fn(async () => []),
    };
    const execution = {
      execute: jest.fn(async () => ({
        success: false,
        filledCoin: 0,
        filledIdr: 0,
        avgPrice: 0,
        feeIdr: 0,
        partial: false,
        error: 'Saldo tidak cukup',
        slippagePercent: 0,
        style: 'TAKER',
      })),
    };
    const { service, repo, notification } = build([baseTrade()], { indodax, execution });
    const report = await service.recover();

    expect(report.results[0].outcome).toBe('MANUAL_ACTION_REQUIRED');
    expect(report.needsAttention).toBe(true);
    expect(repo.store[0].status).toBe('FAILED');
    expect(notification.sendAlert).toHaveBeenCalled();
    expect(notification.sendAlert.mock.calls[0][0]).toMatch(/TINDAKAN MANUAL/);
  });

  it('tidak menutup paksa posisi pada mode simulasi', async () => {
    const repo = fakeRepo([baseTrade({ mode: 'SIMULATION' })]);
    const service = new RecoveryService(
      { mode: 'SIMULATION', isLive: false, bool: (_k: string, f: boolean) => f } as any,
      { hasCredentials: () => true } as any,
      { require: () => ({ tradedCurrency: 'btc' }) } as any,
      { execute: jest.fn() } as any,
      { adjustSimulatedCash: jest.fn() } as any,
      { calculatePnL: jest.fn() } as any,
      { sendAlert: jest.fn(async () => undefined), sendInfo: jest.fn(async () => undefined) } as any,
      { log: jest.fn(async () => undefined) } as any,
      repo as any,
    );

    const report = await service.recover();
    expect(report.results[0].outcome).toBe('MANUAL_ACTION_REQUIRED');
    expect(repo.store[0].status).toBe('FAILED');
  });

  it('melaporkan UNRESOLVED bila kredensial exchange tidak tersedia', async () => {
    const indodax = {
      hasCredentials: () => false,
      getBalance: jest.fn(),
      getTicker: jest.fn(),
      getTradeHistory: jest.fn(),
    };
    const { service } = build([baseTrade()], { indodax });
    const report = await service.recover();

    expect(report.results[0].outcome).toBe('UNRESOLVED');
    expect(report.needsAttention).toBe(true);
  });

  it('melaporkan ada tidaknya posisi yang belum terselesaikan', async () => {
    const withFailed = build([baseTrade()]);
    expect(await withFailed.service.hasUnresolvedPositions()).toBe(true);

    const clean = build([baseTrade({ status: 'CLOSED' })]);
    expect(await clean.service.hasUnresolvedPositions()).toBe(false);
  });

  it('tidak menyentuh posisi yang statusnya sudah berubah sejak daftar dibuat', async () => {
    const repo = fakeRepo([baseTrade()]);
    // Status berubah setelah daftar diambil - misalnya ditutup manual operator.
    repo.findOne = jest.fn(async (_args: any) => ({ ...repo.store[0], status: 'CLOSED' }) as any) as any;

    const { service } = build([], { repo });
    const report = await service.recover();
    expect(report.results[0].outcome).toBe('RECONCILED_CLOSED');
    expect(report.results[0].detail).toMatch(/sudah berubah/);
  });

  it('mengembalikan laporan kosong yang aman bila tidak ada apa-apa untuk dipulihkan', async () => {
    const { service, notification } = build([]);
    const report = await service.recover();

    expect(report.results).toHaveLength(0);
    expect(report.needsAttention).toBe(false);
    expect(notification.sendAlert).not.toHaveBeenCalled();
  });
});
