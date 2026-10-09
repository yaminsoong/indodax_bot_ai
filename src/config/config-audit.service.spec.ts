import { ConfigAuditService } from './config-audit.service';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit ini ada justru karena kegagalannya sunyi: `.env` yang tertinggal di
 * belakang kode tidak menimbulkan gejala apa pun. Test di sini memakai isi
 * `.env` SUNGGUHAN yang ditemukan pada 2026-10-06 sebagai kasus acuan.
 */
describe('ConfigAuditService', () => {
  let svc: ConfigAuditService;
  let dir: string;

  beforeEach(() => {
    svc = new ConfigAuditService();
    dir = mkdtempSync(join(tmpdir(), 'cfgaudit-'));
  });

  const write = (content: string): string => {
    const p = join(dir, '.env');
    writeFileSync(p, content);
    return p;
  };

  it('mendeteksi keempat parameter mati dari versi lama bot', () => {
    // Isi persis seperti .env yang ditemukan di mesin pengguna.
    const r = svc.audit(
      write(
        [
          'INDODAX_API_KEY=abc123',
          'TRADING_PAIRS=btcidr,ethidr,bnbidr',
          'CANDLE_TIMEFRAME=15',
          'POSITION_SIZE_PERCENT=10',
          'STOP_LOSS_PERCENT=1.5',
          'TAKE_PROFIT_PERCENT=2.5',
          'TRAILING_STOP_TRIGGER_PERCENT=1.0',
          'TRADING_MODE=SIMULATION',
        ].join('\n'),
      ),
    );

    const dead = r.findings.filter((f) => f.kind === 'DEAD_KEY').map((f) => f.key);
    expect(dead).toEqual(
      expect.arrayContaining([
        'POSITION_SIZE_PERCENT',
        'STOP_LOSS_PERCENT',
        'TAKE_PROFIT_PERCENT',
        'TRAILING_STOP_TRIGGER_PERCENT',
      ]),
    );
    expect(dead).toHaveLength(4);
  });

  it('menyebut pengganti untuk tiap parameter mati', () => {
    const r = svc.audit(write('POSITION_SIZE_PERCENT=10'));
    const f = r.findings.find((x) => x.key === 'POSITION_SIZE_PERCENT')!;
    // Peringatan tanpa jalan keluar hanya membuat operator bingung.
    expect(f.detail).toContain('RISK_PER_TRADE_PERCENT');
  });

  it('melaporkan parameter penting yang hilang', () => {
    const r = svc.audit(write('TRADING_MODE=SIMULATION'));
    const missing = r.findings.filter((f) => f.kind === 'MISSING_KEY').map((f) => f.key);
    expect(missing).toContain('RISK_PER_TRADE_PERCENT');
    expect(missing).toContain('MAX_DRAWDOWN_PERCENT');
    expect(missing).toContain('MAKER_ENTRY');
  });

  it('tidak melaporkan apa pun pada konfigurasi lengkap', () => {
    const r = svc.audit(
      write(
        [
          'INDODAX_API_KEY=real',
          'INDODAX_SECRET_KEY=real',
          'TRADING_MODE=SIMULATION',
          'CANDLE_TIMEFRAME=60',
          'RISK_PER_TRADE_PERCENT=1.0',
          'MAX_DRAWDOWN_PERCENT=15',
          'MAX_CONSECUTIVE_LOSSES=4',
          'ATR_STOP_MULTIPLIER=1.5',
          'ATR_TARGET_MULTIPLIER=3.0',
          'MAKER_ENTRY=true',
          'ACTIVE_STRATEGY=EMA_SCALPING_V2',
          'MI_ENABLED=true',
          'MI_ENFORCE=true',
        ].join('\n'),
      ),
    );
    expect(r.findings).toHaveLength(0);
    expect(r.summary).toContain('tidak ada masalah');
  });

  // ─── Placeholder ────────────────────────────────────────────────────────

  it('menandai placeholder Indodax sebagai kritis', () => {
    const r = svc.audit(write('INDODAX_API_KEY=your_api_key_here'));
    const f = r.findings.find((x) => x.kind === 'PLACEHOLDER' && x.key === 'INDODAX_API_KEY')!;
    expect(f.severity).toBe('CRITICAL');
  });

  it('menandai placeholder Telegram hanya sebagai peringatan', () => {
    const r = svc.audit(write('TELEGRAM_BOT_TOKEN=your_telegram_bot_token'));
    const f = r.findings.find((x) => x.kind === 'PLACEHOLDER')!;
    expect(f.severity).toBe('WARNING');
  });

  // ─── Nilai yang terukur bermasalah ──────────────────────────────────────

  it('memperingatkan timeframe kecil yang ATR-nya tidak menutup fee', () => {
    const r = svc.audit(write('CANDLE_TIMEFRAME=15'));
    const f = r.findings.find((x) => x.kind === 'SUSPECT_VALUE')!;
    expect(f).toBeDefined();
    // Arahannya harus menaikkan timeframe, BUKAN menurunkan penjagaan.
    expect(f.detail).toContain('Naikkan timeframe');
  });

  it('tidak memperingatkan timeframe kecil bila ambang ATR memang diturunkan sadar', () => {
    const r = svc.audit(write('CANDLE_TIMEFRAME=15\nMI_MIN_ATR_PERCENT=0.15'));
    expect(r.findings.filter((f) => f.kind === 'SUSPECT_VALUE')).toHaveLength(0);
  });

  it('tidak memperingatkan timeframe besar', () => {
    const r = svc.audit(write('CANDLE_TIMEFRAME=60'));
    expect(r.findings.filter((f) => f.kind === 'SUSPECT_VALUE')).toHaveLength(0);
  });

  it('menandai LIVE tanpa frasa konfirmasi sebagai kritis', () => {
    const r = svc.audit(write('TRADING_MODE=LIVE'));
    const f = r.findings.find((x) => x.key === 'LIVE_TRADING_CONFIRMED')!;
    expect(f.severity).toBe('CRITICAL');
    expect(f.detail).toContain('SIMULATION');
  });

  it('menerima LIVE yang sudah dikonfirmasi', () => {
    const r = svc.audit(
      write('TRADING_MODE=LIVE\nLIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY'),
    );
    expect(r.findings.filter((f) => f.key === 'LIVE_TRADING_CONFIRMED')).toHaveLength(0);
  });

  // ─── Ketahanan parsing ──────────────────────────────────────────────────

  it('mengabaikan komentar dan baris kosong', () => {
    const r = svc.audit(write('# POSITION_SIZE_PERCENT=10\n\n   \nTRADING_MODE=SIMULATION'));
    expect(r.findings.filter((f) => f.kind === 'DEAD_KEY')).toHaveLength(0);
  });

  it('menoleransi spasi di sekitar tanda sama dengan', () => {
    const r = svc.audit(write('  POSITION_SIZE_PERCENT = 10  '));
    expect(r.findings.filter((f) => f.kind === 'DEAD_KEY')).toHaveLength(1);
  });

  it('tidak melempar error bila .env tidak ada', () => {
    const r = svc.audit(join(dir, 'tidak-ada.env'));
    expect(r.keysInFile).toBe(0);
    expect(r.summary).toContain('tidak ada');
  });
});
