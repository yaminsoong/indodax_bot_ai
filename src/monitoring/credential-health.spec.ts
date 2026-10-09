import { HealthService } from './health.service';

/**
 * Endpoint publik Indodax dan API privat gagal secara terpisah: ticker bisa
 * menjawab normal sementara kunci API ditolak. Sebelum pemeriksaan ini ada,
 * health melaporkan OK untuk seluruh sistem padahal pembacaan saldo gagal —
 * artinya bot tidak akan bisa memasang order, dan tidak ada yang tahu sampai
 * sinyal pertama muncul.
 */
describe('Health check kredensial', () => {
  let indodax: { getBalance: jest.Mock; getApiVersion: jest.Mock };
  let mode: string;

  const build = () => {
    const svc = Object.create(HealthService.prototype) as HealthService;
    Object.assign(svc, {
      indodax,
      config: {
        get mode() {
          return mode;
        },
      },
    });
    return svc;
  };

  const run = (svc: HealthService) => (svc as any).checkCredentials();

  beforeEach(() => {
    mode = 'SIMULATION';
    indodax = {
      getBalance: jest.fn().mockResolvedValue({ idr: 1000 }),
      getApiVersion: jest.fn().mockReturnValue('v2'),
    };
  });

  it('OK bila API privat menjawab, menyebut protokolnya', async () => {
    const c = await run(build());
    expect(c.status).toBe('OK');
    expect(c.label).toBe('DITERIMA');
    expect(c.detail).toContain('V2');
  });

  it('memanggil endpoint PRIVAT, bukan ticker publik', async () => {
    // Inti pemeriksaan ini: getTicker tidak membuktikan apa pun soal kunci.
    await run(build());
    expect(indodax.getBalance).toHaveBeenCalled();
  });

  it('menamai penolakan IP secara spesifik dan menyatakan kunci tidak salah', async () => {
    indodax.getBalance.mockRejectedValue(new Error('Unauthorized IP address.'));
    const c = await run(build());
    expect(c.label).toBe('IP DITOLAK');
    expect(c.detail).toMatch(/whitelist/i);
    expect(c.detail).toMatch(/kunci tidak ditolak/i);
  });

  it('penolakan lain dilaporkan apa adanya tanpa menebak sebabnya', async () => {
    indodax.getBalance.mockRejectedValue(new Error('Access denied for this API key.'));
    const c = await run(build());
    expect(c.label).toBe('DITOLAK');
    expect(c.detail).toContain('Access denied for this API key.');
    expect(c.detail).not.toMatch(/whitelist/i);
  });

  it('di SIMULASI kegagalan hanya DEGRADED — kredensial belum dipakai', async () => {
    indodax.getBalance.mockRejectedValue(new Error('Unauthorized IP address.'));
    expect((await run(build())).status).toBe('DEGRADED');
  });

  it('di LIVE kegagalan harus ERROR — ini menghalangi eksekusi order', async () => {
    mode = 'LIVE';
    indodax.getBalance.mockRejectedValue(new Error('Unauthorized IP address.'));
    expect((await run(build())).status).toBe('ERROR');
  });

  it('galat tanpa pesan tidak membuat pemeriksaan ikut melempar', async () => {
    indodax.getBalance.mockRejectedValue({});
    const c = await run(build());
    expect(c.status).toBe('DEGRADED');
    expect(typeof c.detail).toBe('string');
  });
});
