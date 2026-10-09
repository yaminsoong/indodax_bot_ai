import { LIVE_CONFIRMATION_PHRASE, resolveTradingMode } from './live-mode';

function reader(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

describe('resolveTradingMode', () => {
  it('default ke SIMULATION bila tidak ada konfigurasi', () => {
    const res = resolveTradingMode(reader({}));
    expect(res.mode).toBe('SIMULATION');
    expect(res.requested).toBe('SIMULATION');
    expect(res.blockedReason).toBeUndefined();
  });

  it('tetap SIMULATION bila TRADING_MODE bukan LIVE', () => {
    expect(resolveTradingMode(reader({ TRADING_MODE: 'SIMULATION' })).mode).toBe('SIMULATION');
    expect(resolveTradingMode(reader({ TRADING_MODE: 'paper' })).mode).toBe('SIMULATION');
  });

  it('MENOLAK LIVE bila konfirmasi tidak ada', () => {
    const res = resolveTradingMode(reader({ TRADING_MODE: 'LIVE' }));
    expect(res.mode).toBe('SIMULATION');
    expect(res.requested).toBe('LIVE');
    expect(res.blockedReason).toContain(LIVE_CONFIRMATION_PHRASE);
  });

  it('MENOLAK LIVE bila frasa konfirmasi salah', () => {
    const res = resolveTradingMode(
      reader({ TRADING_MODE: 'LIVE', LIVE_TRADING_CONFIRMED: 'yes' }),
    );
    expect(res.mode).toBe('SIMULATION');
    expect(res.blockedReason).toBeDefined();
  });

  it('MENOLAK LIVE bila konfirmasi hanya "true"', () => {
    const res = resolveTradingMode(
      reader({ TRADING_MODE: 'LIVE', LIVE_TRADING_CONFIRMED: 'true' }),
    );
    expect(res.mode).toBe('SIMULATION');
  });

  it('mengizinkan LIVE hanya dengan frasa yang tepat', () => {
    const res = resolveTradingMode(
      reader({ TRADING_MODE: 'LIVE', LIVE_TRADING_CONFIRMED: LIVE_CONFIRMATION_PHRASE }),
    );
    expect(res.mode).toBe('LIVE');
    expect(res.blockedReason).toBeUndefined();
  });

  it('mengabaikan spasi di sekitar frasa konfirmasi', () => {
    const res = resolveTradingMode(
      reader({ TRADING_MODE: 'LIVE', LIVE_TRADING_CONFIRMED: `  ${LIVE_CONFIRMATION_PHRASE}  ` }),
    );
    expect(res.mode).toBe('LIVE');
  });

  it('menerima TRADING_MODE dalam huruf kecil', () => {
    const res = resolveTradingMode(
      reader({ TRADING_MODE: 'live', LIVE_TRADING_CONFIRMED: LIVE_CONFIRMATION_PHRASE }),
    );
    expect(res.mode).toBe('LIVE');
  });

  it('konfirmasi saja tanpa TRADING_MODE=LIVE tidak mengaktifkan apa pun', () => {
    const res = resolveTradingMode(
      reader({ LIVE_TRADING_CONFIRMED: LIVE_CONFIRMATION_PHRASE }),
    );
    expect(res.mode).toBe('SIMULATION');
    expect(res.requested).toBe('SIMULATION');
  });
});
