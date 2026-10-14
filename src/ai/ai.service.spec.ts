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
  // --- Kunci ditolak -------------------------------------------------------
  //
  // Penolakan kunci (HTTP 401/403) berbeda jenis dari gangguan sesaat: kunci
  // dibaca sekali saat init, jadi mencoba lagi dengan kunci yang sama tidak
  // akan pernah berhasil. Yang paling berbahaya bukan panggilan yang terbuang,
  // melainkan `status()` yang melaporkan "aktif" sementara setiap panggilan
  // ditolak -- operator tidak punya petunjuk apa pun untuk diperbaiki.

  const ditolak = () =>
    makeProvider({
      complete: jest
        .fn()
        .mockRejectedValue(
          new AiUnavailableError('Gemini gagal (HTTP 401): kredensial tidak sah', 'gemini', false, true),
        ),
    });

  it('kunci ditolak membuat AI langsung tidak tersedia, tanpa menunggu gagal kedua', async () => {
    const { svc } = build('gemini', ditolak());
    expect(svc.isAvailable()).toBe(true);

    await svc.tryComplete(req);

    expect(svc.isAvailable()).toBe(false);
  });

  it('kunci ditolak dinyatakan di status, bukan tersembunyi sebagai "aktif"', async () => {
    const { svc } = build('gemini', ditolak());
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);

    await svc.tryComplete(req);

    const st = svc.status();
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(/kunci API ditolak/);
    expect(st.reason).toMatch(/HTTP 401/);
  });

  it('setelah kunci ditolak, penyedia TIDAK dipanggil lagi', async () => {
    const { svc, provider } = build('gemini', ditolak());
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);

    await svc.tryComplete(req);
    await svc.tryComplete(req);
    await svc.tryComplete(req);

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('kunci ditolak tetap mengembalikan null, bukan melempar', async () => {
    const { svc } = build('gemini', ditolak());
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await expect(svc.tryComplete(req)).resolves.toBeNull();
  });

  it('kegagalan biasa TIDAK disalahartikan sebagai kunci ditolak', async () => {
    // Satu kegagalan sesaat tidak boleh mematikan AI untuk selamanya.
    const { svc, provider } = build(
      'gemini',
      makeProvider({
        complete: jest
          .fn()
          .mockRejectedValueOnce(new AiUnavailableError('Gemini gagal (HTTP 503): sibuk', 'gemini', true))
          .mockResolvedValue({ text: '1:50', provider: 'gemini', model: 'uji', latencyMs: 5 }),
      }),
    );

    await svc.tryComplete(req);

    expect(svc.isAvailable()).toBe(true);
    expect(svc.status().reason).toBeNull();
    await expect(svc.tryComplete(req)).resolves.not.toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('status membedakan belum disetel dari kunci ditolak', () => {
    expect(build('none').svc.status().reason).toMatch(/AI_PROVIDER belum disetel/);
  });
  // --- Rantai cadangan ----------------------------------------------------
  //
  // Sifat yang menentukan apakah cadangan benar-benar berguna: keadaan
  // istirahat, batas laju, dan penolakan kunci harus TERPISAH per penyedia.
  // Kalau dibagi bersama, Gemini yang kehabisan kuota akan ikut mematikan
  // Groq - dan cadangan yang mati saat dibutuhkan sama saja dengan tidak
  // punya cadangan.

  /** Bangun layanan dengan penyedia utama DAN cadangan yang bisa diatur. */
  const buildChain = (
    primaryOver: Partial<AiProvider> = {},
    backupOver: Partial<AiProvider> = {},
    fallback = 'groq',
  ) => {
    const primary = makeProvider({ name: 'gemini', ...primaryOver });
    const backup = makeProvider({ name: 'groq', model: 'cadangan', ...backupOver });

    const config = {
      get: (k: string, d: string) => {
        if (k === 'AI_PROVIDER') return 'gemini';
        if (k === 'AI_FALLBACK_PROVIDERS') return fallback;
        return d;
      },
    };

    const svc = new AiService(config as any, primary as any, backup as any, makeProvider() as any);
    jest.spyOn(svc['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(svc['logger'], 'debug').mockImplementation(() => undefined);
    svc.onModuleInit();
    return { svc, primary, backup };
  };

  const kuotaHabis = () =>
    new AiUnavailableError('Gemini gagal (HTTP 429): kuota habis', 'gemini', true, false, true);

  it('tanpa AI_FALLBACK_PROVIDERS tidak ada cadangan', () => {
    const { svc } = build('gemini');
    expect(svc.status().chain).toHaveLength(1);
  });

  it('cadangan didaftarkan dan terlihat di status', () => {
    const { svc } = buildChain();
    const chain = svc.status().chain;

    expect(chain).toHaveLength(2);
    expect(chain[0].provider).toBe('gemini');
    expect(chain[1].provider).toBe('groq');
  });

  it('yang utama dipakai selama masih bisa', async () => {
    const { svc, primary, backup } = buildChain();
    await svc.tryComplete(req);

    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).not.toHaveBeenCalled();
  });

  it('kuota utama habis -> cadangan yang menjawab', async () => {
    const { svc, primary, backup } = buildChain({
      complete: jest.fn().mockRejectedValue(kuotaHabis()),
    });

    const r = await svc.tryComplete(req);

    expect(r).not.toBeNull();
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).toHaveBeenCalledTimes(1);
  });

  it('kuota habis mengistirahatkan penyedia itu SEKARANG, tanpa menunggu 3 gagal', async () => {
    // Dua percobaan berikutnya yang pasti gagal hanya menunda jawaban yang
    // sebenarnya bisa diberikan cadangan.
    const { svc, primary } = buildChain({
      complete: jest.fn().mockRejectedValue(kuotaHabis()),
    });

    await svc.tryComplete(req);
    expect(svc.status().chain[0].usable).toBe(false);
    expect(svc.status().chain[0].reason).toMatch(/diistirahatkan/);

    await svc.tryComplete(req);
    // Masih satu kali: yang utama tidak dicoba lagi.
    expect(primary.complete).toHaveBeenCalledTimes(1);
  });

  it('istirahat pada yang utama TIDAK mematikan cadangan', async () => {
    // Inilah sebab keadaan dipisah per penyedia.
    const { svc, backup } = buildChain({
      complete: jest.fn().mockRejectedValue(kuotaHabis()),
    });

    await svc.tryComplete(req);
    await svc.tryComplete(req);
    await svc.tryComplete(req);

    expect(svc.isAvailable()).toBe(true);
    expect(backup.complete).toHaveBeenCalledTimes(3);
  });

  it('kunci utama ditolak tetap menyisakan cadangan', async () => {
    const { svc, backup } = buildChain({
      complete: jest
        .fn()
        .mockRejectedValue(
          new AiUnavailableError('HTTP 401: kredensial tidak sah', 'gemini', false, true),
        ),
    });

    const r = await svc.tryComplete(req);

    expect(r).not.toBeNull();
    expect(backup.complete).toHaveBeenCalledTimes(1);
    expect(svc.status().chain[0].reason).toMatch(/kunci API ditolak/);
    expect(svc.isAvailable()).toBe(true);
  });

  it('batas laju dihitung per penyedia, bukan bersama', async () => {
    const limit = PROVIDER_RATE_LIMITS.gemini.rpm;
    const { svc, primary, backup } = buildChain();

    for (let i = 0; i < limit + 3; i++) await svc.tryComplete(req);

    expect(primary.complete).toHaveBeenCalledTimes(limit);
    // Sisanya dialihkan ke cadangan, bukan dibuang.
    expect(backup.complete).toHaveBeenCalledTimes(3);
  });

  it('seluruh rantai mati menghasilkan null, bukan galat', async () => {
    const gagal = () => ({ complete: jest.fn().mockRejectedValue(kuotaHabis()) });
    const { svc } = buildChain(gagal(), gagal());

    await expect(svc.tryComplete(req)).resolves.toBeNull();
    expect(svc.isAvailable()).toBe(false);
  });

  it('alasan menyebut SETIAP penyedia ketika semua mati', async () => {
    // "AI mati" tanpa sebab tidak memberi operator apa pun untuk diperbaiki.
    const gagal = () => ({ complete: jest.fn().mockRejectedValue(kuotaHabis()) });
    const { svc } = buildChain(gagal(), gagal());

    await svc.tryComplete(req);
    const reason = svc.status().reason ?? '';

    expect(reason).toMatch(/gemini:/);
    expect(reason).toMatch(/groq:/);
  });

  it('activeProvider menunjuk penyedia yang akan dipakai berikutnya', async () => {
    const { svc } = buildChain({ complete: jest.fn().mockRejectedValue(kuotaHabis()) });

    expect(svc.activeProvider()).toBe('gemini');
    await svc.tryComplete(req);
    expect(svc.activeProvider()).toBe('groq');
  });

  it('cadangan tanpa kunci API dilewati, bukan menggagalkan start', () => {
    const { svc } = buildChain({}, { isConfigured: () => false });
    expect(svc.status().chain).toHaveLength(1);
    expect(svc.isAvailable()).toBe(true);
  });

  it('nama cadangan yang tidak dikenal dilewati', () => {
    const { svc } = buildChain({}, {}, 'pisang');
    expect(svc.status().chain).toHaveLength(1);
  });

  it('cadangan yang sama dengan utama tidak didaftarkan dua kali', () => {
    const { svc } = buildChain({}, {}, 'gemini');
    expect(svc.status().chain).toHaveLength(1);
  });

  it('token dijumlahkan lintas penyedia agar biaya lapisan terpantau', async () => {
    const { svc } = buildChain({ complete: jest.fn().mockRejectedValue(kuotaHabis()) });

    await svc.tryComplete(req);
    const st = svc.status();

    // 100/20 berasal dari penyedia cadangan yang menjawab.
    expect(st.calls).toBe(1);
    expect(st.inputTokens).toBe(100);
    expect(st.outputTokens).toBe(20);
  });

  it('503 TIDAK diperlakukan sebagai kuota habis', async () => {
    // Model sibuk pulih dalam hitungan detik; mengistirahatkannya 15 menit
    // akan membuang penyedia utama karena gangguan sesaat.
    const { svc } = buildChain({
      complete: jest
        .fn()
        .mockRejectedValueOnce(new AiUnavailableError('HTTP 503: sibuk', 'gemini', true))
        .mockResolvedValue({ text: 'ok', provider: 'gemini', model: 'uji', latencyMs: 5 }),
    });

    await svc.tryComplete(req);
    expect(svc.status().chain[0].usable).toBe(true);
  });
});
