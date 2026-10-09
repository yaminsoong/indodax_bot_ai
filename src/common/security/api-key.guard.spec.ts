import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/** ConfigService palsu dengan nilai yang bisa diatur per test. */
function fakeConfig(values: Record<string, string> = {}): any {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  };
}

/** ExecutionContext palsu yang membungkus satu request. */
function contextOf(request: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

function localRequest(extra: any = {}): any {
  return {
    headers: {},
    query: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...extra,
  };
}

describe('ApiKeyGuard', () => {
  describe('dengan DASHBOARD_API_KEY terpasang', () => {
    const config = fakeConfig({ DASHBOARD_API_KEY: 'kunci-rahasia-panjang' });

    it('menerima kunci yang benar lewat header x-api-key', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ headers: { 'x-api-key': 'kunci-rahasia-panjang' } });
      expect(guard.canActivate(contextOf(req))).toBe(true);
    });

    it('menerima kunci lewat header Authorization: Bearer', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ headers: { authorization: 'Bearer kunci-rahasia-panjang' } });
      expect(guard.canActivate(contextOf(req))).toBe(true);
    });

    it('menolak kunci yang salah', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ headers: { 'x-api-key': 'kunci-salah' } });
      expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
    });

    it('menolak kunci yang panjangnya berbeda tanpa memicu galat kriptografi', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ headers: { 'x-api-key': 'pendek' } });
      expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
    });

    it('menolak permintaan tanpa kunci meski datang dari localhost', () => {
      const guard = new ApiKeyGuard(config);
      expect(() => guard.canActivate(contextOf(localRequest()))).toThrow(UnauthorizedException);
    });
  });

  describe('tanpa DASHBOARD_API_KEY (mode simulasi)', () => {
    const config = fakeConfig({ TRADING_MODE: 'SIMULATION' });

    it('menerima permintaan langsung dari localhost', () => {
      const guard = new ApiKeyGuard(config);
      expect(guard.canActivate(contextOf(localRequest()))).toBe(true);
    });

    it('menerima alamat IPv6 loopback', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ ip: '::1', socket: { remoteAddress: '::1' } });
      expect(guard.canActivate(contextOf(req))).toBe(true);
    });

    it('menolak permintaan dari alamat non-lokal', () => {
      const guard = new ApiKeyGuard(config);
      const req = localRequest({ ip: '203.0.113.5', socket: { remoteAddress: '203.0.113.5' } });
      expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
    });

    describe('bypass lewat reverse proxy', () => {
      it('MENOLAK permintaan yang membawa X-Forwarded-For walau soketnya localhost', () => {
        const guard = new ApiKeyGuard(config);
        const req = localRequest({ headers: { 'x-forwarded-for': '203.0.113.9' } });
        expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
      });

      it('MENOLAK permintaan yang membawa X-Real-IP', () => {
        const guard = new ApiKeyGuard(config);
        const req = localRequest({ headers: { 'x-real-ip': '203.0.113.9' } });
        expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
      });

      it('MENOLAK permintaan yang membawa header Forwarded standar', () => {
        const guard = new ApiKeyGuard(config);
        const req = localRequest({ headers: { forwarded: 'for=203.0.113.9' } });
        expect(() => guard.canActivate(contextOf(req))).toThrow(UnauthorizedException);
      });

      it('menerima permintaan berproxy bila TRUST_PROXY dinyatakan eksplisit', () => {
        const guard = new ApiKeyGuard(
          fakeConfig({ TRADING_MODE: 'SIMULATION', TRUST_PROXY: 'true' }),
        );
        const req = localRequest({ headers: { 'x-forwarded-for': '127.0.0.1' } });
        expect(guard.canActivate(contextOf(req))).toBe(true);
      });
    });
  });

  describe('mode LIVE', () => {
    it('menolak jalur localhost tanpa kunci - uang sungguhan menuntut autentikasi nyata', () => {
      const guard = new ApiKeyGuard(
        fakeConfig({ TRADING_MODE: 'LIVE', LIVE_TRADING_CONFIRMED: 'I_UNDERSTAND_REAL_MONEY' }),
      );
      expect(() => guard.canActivate(contextOf(localRequest()))).toThrow(UnauthorizedException);
    });

    it('tetap menerima kunci yang benar', () => {
      const guard = new ApiKeyGuard(
        fakeConfig({ TRADING_MODE: 'LIVE', DASHBOARD_API_KEY: 'kunci-live-yang-panjang' }),
      );
      const req = localRequest({ headers: { 'x-api-key': 'kunci-live-yang-panjang' } });
      expect(guard.canActivate(contextOf(req))).toBe(true);
    });
  });

  it('memperlakukan kunci contoh (your_...) sebagai belum diisi', () => {
    const guard = new ApiKeyGuard(fakeConfig({ DASHBOARD_API_KEY: 'your_dashboard_key_here' }));
    // Jatuh ke jalur localhost, bukan menerima string contoh itu sebagai kunci sah.
    expect(guard.canActivate(contextOf(localRequest()))).toBe(true);
    const req = localRequest({ headers: { 'x-api-key': 'your_dashboard_key_here' } });
    expect(guard.canActivate(contextOf(req))).toBe(true);
  });
});
