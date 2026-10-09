import { IndodaxService } from './indodax.service';
import { IndodaxV2Error } from './indodax-v2.client';

/**
 * Indodax memakai kode -2015 untuk dua sebab yang obatnya sangat berbeda:
 * kunci yang salah dan IP yang tidak terdaftar. Hanya teks pesannya yang
 * membedakan. Salah mengartikannya mengirim operator mengganti kunci yang
 * sebenarnya sudah benar — persis yang terjadi sebelum pembedaan ini ada.
 */
describe('IndodaxV2Error.isUnauthorizedIp', () => {
  it('mengenali penolakan IP dari teks pesannya', () => {
    const err = new IndodaxV2Error('Unauthorized IP address.', -2015);
    expect(err.isUnauthorizedIp).toBe(true);
    expect(err.isAccessDenied).toBe(true);
  });

  it('tidak mengira penolakan kunci sebagai penolakan IP', () => {
    const err = new IndodaxV2Error(
      'Access denied for this API key or invalid TAPI version key.',
      -2015,
    );
    expect(err.isUnauthorizedIp).toBe(false);
    expect(err.isAccessDenied).toBe(true);
  });

  it('tidak terpengaruh huruf besar-kecil', () => {
    expect(new IndodaxV2Error('unauthorized ip address', -2015).isUnauthorizedIp).toBe(true);
  });

  it('menuntut kode -2015, bukan hanya teksnya', () => {
    // Galat lain yang kebetulan menyebut IP bukan penolakan whitelist.
    expect(new IndodaxV2Error('Unauthorized IP address.', -1021).isUnauthorizedIp).toBe(false);
  });
});

/**
 * Deteksi protokol berjalan sekali saat startup. Bila saat itu IP ditolak,
 * kedua protokol tidak terbukti apa pun — dan mengunci hasilnya berarti bot
 * membawa diagnosis salah sepanjang hidupnya.
 */
describe('Deteksi versi API saat IP ditolak', () => {
  let svc: IndodaxService;
  let probe: jest.Mock;
  let legacyCalls: number;

  const makeService = (configured = 'auto') => {
    probe = jest.fn();
    legacyCalls = 0;
    const config = { get: (_k: string, d: string) => configured ?? d };
    const s = new IndodaxService(config as any, {} as any, { probe } as any);
    // TAPI lama tidak boleh ikut dicoba saat sebabnya IP; dihitung di sini.
    (s as any).callLegacyApi = jest.fn(async () => {
      legacyCalls++;
      throw new Error('tidak seharusnya dipanggil');
    });
    return s;
  };

  const resolve = (s: IndodaxService) => (s as any).resolveApiVersion();

  beforeEach(() => {
    svc = makeService();
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
  });

  it('tidak mencoba TAPI lama bila sebabnya IP ditolak', async () => {
    // TAPI lama keluar dari IP yang sama: ia akan ditolak dengan sebab yang
    // sama, lalu melaporkan dua galat yang menutupi satu penyebab tunggal.
    probe.mockResolvedValue({ ok: false, code: -2015, reason: 'Unauthorized IP address.', ipRejected: true });
    await expect(resolve(svc)).resolves.toBe('v2');
    expect(legacyCalls).toBe(0);
  });

  it('tetap mencoba TAPI lama bila kuncinya yang ditolak', async () => {
    probe.mockResolvedValue({ ok: false, code: -2015, reason: 'Access denied', ipRejected: false });
    await resolve(svc);
    expect(legacyCalls).toBe(1);
  });

  it('melaporkan bahwa kunci TIDAK ditolak agar operator tidak menggantinya', async () => {
    probe.mockResolvedValue({ ok: false, code: -2015, reason: 'Unauthorized IP address.', ipRejected: true });
    await resolve(svc);
    const message = (svc['logger'].error as jest.Mock).mock.calls[0][0] as string;
    expect(message).toMatch(/whitelist/i);
    expect(message).toMatch(/kunci TIDAK ditolak/i);
    expect(message).not.toMatch(/Kedua protokol menolak/i);
  });

  it('mengulang deteksi setelah masa tenang karena hasilnya baru dugaan', async () => {
    probe.mockResolvedValue({ ok: false, code: -2015, reason: 'Unauthorized IP address.', ipRejected: true });
    await resolve(svc);
    expect(probe).toHaveBeenCalledTimes(1);

    // Dalam masa tenang: tidak membebani API dengan probe berulang.
    await resolve(svc);
    expect(probe).toHaveBeenCalledTimes(1);

    // Setelah masa tenang: IP bisa sudah berpindah ke jalur yang terdaftar.
    svc['versionTentativeSince'] = Date.now() - 61_000;
    probe.mockResolvedValue({ ok: true });
    await expect(resolve(svc)).resolves.toBe('v2');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('berhenti mengulang begitu probe berhasil', async () => {
    probe.mockResolvedValue({ ok: true });
    await resolve(svc);
    expect(svc['versionTentativeSince']).toBe(0);

    await resolve(svc);
    await resolve(svc);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('hasil pasti tidak pernah diprobe ulang walau waktu berjalan jauh', async () => {
    probe.mockResolvedValue({ ok: true });
    await resolve(svc);
    svc['versionTentativeSince'] = 0;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000);
    await resolve(svc);
    expect(probe).toHaveBeenCalledTimes(1);
    (Date.now as jest.Mock).mockRestore();
  });

  it('konfigurasi eksplisit melewati probe sepenuhnya', async () => {
    const forced = makeService('v2');
    jest.spyOn(forced['logger'], 'log').mockImplementation(() => undefined);
    await expect((forced as any).resolveApiVersion()).resolves.toBe('v2');
    expect(probe).not.toHaveBeenCalled();
  });

  it('probe bersamaan saat startup hanya memicu satu permintaan', async () => {
    let release!: (v: any) => void;
    probe.mockReturnValue(new Promise((r) => (release = r)));
    const all = Promise.all([resolve(svc), resolve(svc), resolve(svc)]);
    release({ ok: true });
    await all;
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
