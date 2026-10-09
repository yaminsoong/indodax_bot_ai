import { AiService } from './ai.service';
import { AiProvider, AiUnavailableError, PROVIDER_RATE_LIMITS } from './ai.types';

/**
 * Satu sifat menentukan apakah lapisan AI boleh ada di jalur trading: kegagalan
 * AI TIDAK BOLEH pernah merembet ke keputusan trading. Penyedia mati, kunci
 * salah, batas laju tertabrak, balasan ngawur — semuanya harus berakhir sebagai
 * "tidak tersedia", bukan sebagai galat yang menggagalkan siklus.
 */
describe('AiService', () => {
  const makeProvider = (over: Partial<AiProvider> = {}): AiProvider & { complete: jest.Mock } =>
    ({
      name: 'gemini',
      model: 'uji',
      isConfigured: () => true,
      complete: jest.fn().mockResolvedValue({
        text: '1:50',
        provider: 'gemini',
        model: 'uji',
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: 5,
      }),
      ...over,
    }) as any;

  const build = (providerValue: string, provider = makeProvider()) => {
    const config = { get: (k: string, d: string) => (k === 'AI_PROVIDER' ? providerValue : d) };
    const svc = new AiService(config as any, provider as any, makeProvider() as any, makeProvider() as any);
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'debug').mockImplementation(() => undefined);
    svc.onModuleInit();
    return { svc, provider };
  };

  const req = { system: 's', user: 'u', maxOutputTokens: 64, temperature: 0 };

  // ─── Pemilihan penyedia ──────────────────────────────────────────────────

  it('AI_PROVIDER=none mematikan AI tanpa galat', async () => {
    const { svc, provider } = build('none');
    expect(svc.isAvailable()).toBe(false);
    await expect(svc.tryComplete(req)).resolves.toBeNull();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('nilai AI_PROVIDER yang tidak dikenal mematikan AI, bukan melempar', () => {
    const { svc } = build('pisang');
    expect(svc.isAvailable()).toBe(false);
    expect(svc.status().provider).toBe('none');
  });

  it('penyedia tanpa kunci API dimatikan dengan peringatan', () => {
    const { svc } = build('gemini', makeProvider({ isConfigured: () => false }));
    expect(svc.isAvailable()).toBe(false);
  });

  it('penyedia terkonfigurasi menjadi aktif', () => {
    const { svc } = build('gemini');
    expect(svc.isAvailable()).toBe(true);
    expect(svc.status().provider).toBe('gemini');
    expect(svc.status().model).toBe('uji');
  });

  it('huruf besar dan spasi pada AI_PROVIDER tetap diterima', () => {
    expect(build('  GEMINI  ').svc.isAvailable()).toBe(true);
  });

  // ─── Kegagalan tidak merembet ────────────────────────────────────────────

  it('penyedia melempar menghasilkan null, bukan galat', async () => {
    const p = makeProvider({ complete: jest.fn().mockRejectedValue(new Error('jaringan mati')) });
    const { svc } = build('gemini', p);
    await expect(svc.tryComplete(req)).resolves.toBeNull();
  });

  it('AiUnavailableError juga berakhir sebagai null', async () => {
    const p = makeProvider({
      complete: jest.fn().mockRejectedValue(new AiUnavailableError('429', 'gemini', true)),
    });
    const { svc } = build('gemini', p);
    await expect(svc.tryComplete(req)).resolves.toBeNull();
  });

  it('istirahat setelah tiga kegagalan berturut-turut', async () => {
    const p = makeProvider({ complete: jest.fn().mockRejectedValue(new Error('mati')) });
    const { svc } = build('gemini', p);

    await svc.tryComplete(req);
    await svc.tryComplete(req);
    expect(svc.isAvailable()).toBe(true); // belum istirahat

    await svc.tryComplete(req);
    expect(svc.isAvailable()).toBe(false); // sudah istirahat
    expect(svc.status().pausedForSeconds).toBeGreaterThan(0);

    // Selama istirahat, penyedia tidak dipanggil lagi sama sekali.
    const before = p.complete.mock.calls.length;
    await svc.tryComplete(req);
    expect(p.complete.mock.calls.length).toBe(before);
  });

  it('keberhasilan mengembalikan hitungan kegagalan ke nol', async () => {
    let gagal = true;
    const p = makeProvider({
      complete: jest.fn().mockImplementation(async () => {
        if (gagal) throw new Error('mati');
        return { text: '1:0', provider: 'gemini', model: 'uji', latencyMs: 1 };
      }),
    });
    const { svc } = build('gemini', p);

    await svc.tryComplete(req);
    await svc.tryComplete(req);
    gagal = false;
    await svc.tryComplete(req); // berhasil — hitungan direset
    gagal = true;
    await svc.tryComplete(req);
    await svc.tryComplete(req);

    // Hanya dua kegagalan sejak reset, jadi belum istirahat.
    expect(svc.isAvailable()).toBe(true);
  });

  // ─── Batas laju ditegakkan di sisi kita ──────────────────────────────────

  it('berhenti memanggil setelah batas laju penyedia tercapai', async () => {
    const { svc, provider } = build('gemini');
    const limit = PROVIDER_RATE_LIMITS.gemini.rpm;

    for (let i = 0; i < limit; i++) {
      await expect(svc.tryComplete(req)).resolves.not.toBeNull();
    }
    // Permintaan berikutnya dilewatkan TANPA menunggu penolakan penyedia:
    // menunggu 429 berarti membuang permintaan dan menambah latensi siklus.
    await expect(svc.tryComplete(req)).resolves.toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(limit);
  });

  it('batas laju dipasang di bawah batas resmi tiap penyedia', () => {
    // Tier gratis berubah tanpa pemberitahuan; tertabrak batas di tengah siklus
    // trading lebih merugikan daripada menilai beberapa judul lebih sedikit.
    expect(PROVIDER_RATE_LIMITS.gemini.rpm).toBeLessThan(10);
    expect(PROVIDER_RATE_LIMITS.groq.rpm).toBeLessThan(30);
    expect(PROVIDER_RATE_LIMITS.anthropic.rpm).toBeLessThan(5);
  });

  it('jendela batas laju bergeser seiring waktu', async () => {
    const { svc } = build('gemini');
    const limit = PROVIDER_RATE_LIMITS.gemini.rpm;
    for (let i = 0; i < limit; i++) await svc.tryComplete(req);
    await expect(svc.tryComplete(req)).resolves.toBeNull();

    // Satu menit berlalu — jatah terisi kembali.
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await expect(svc.tryComplete(req)).resolves.not.toBeNull();
    (Date.now as jest.Mock).mockRestore();
  });

  // ─── Pemantauan pemakaian ────────────────────────────────────────────────

  it('menjumlahkan token agar biaya bisa dipantau', async () => {
    const { svc } = build('gemini');
    await svc.tryComplete(req);
    await svc.tryComplete(req);

    const s = svc.status();
    expect(s.calls).toBe(2);
    expect(s.inputTokens).toBe(200);
    expect(s.outputTokens).toBe(40);
  });

  it('penyedia yang tidak melaporkan token tidak merusak hitungan', async () => {
    const p = makeProvider({
      complete: jest.fn().mockResolvedValue({ text: '1:0', provider: 'gemini', model: 'uji', latencyMs: 1 }),
    });
    const { svc } = build('gemini', p);
    await svc.tryComplete(req);
    expect(svc.status().inputTokens).toBe(0);
    expect(svc.status().calls).toBe(1);
  });
});
