import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderName,
  AiUnavailableError,
  PROVIDER_RATE_LIMITS,
} from './ai.types';

/** Setelah gagal berturut-turut sebanyak ini, AI diistirahatkan. */
const FAILURES_BEFORE_PAUSE = 3;
/** Lama istirahat sebelum mencoba lagi. */
const PAUSE_MS = 10 * 60_000;
/**
 * Lama istirahat khusus saat kuota habis.
 *
 * Lebih panjang dari jeda biasa: kuota harian tidak pulih dalam sepuluh menit,
 * dan mencoba lagi terlalu cepat hanya membuang permintaan. Tidak dibuat
 * sepanjang 24 jam karena 429 pada tier gratis juga dipakai untuk batas per
 * menit, yang memang pulih cepat.
 */
const QUOTA_PAUSE_MS = 15 * 60_000;

/**
 * Titik masuk tunggal ke AI.
 *
 * Tanggung jawab utamanya BUKAN memanggil model, melainkan memastikan
 * kegagalan AI tidak pernah merembet ke keputusan trading:
 *
 *   - Penyedia yang tidak terkonfigurasi bukan galat, hanya "tidak tersedia".
 *   - Batas laju ditegakkan di sisi kita, bukan ditunggu sampai ditolak.
 *   - Setelah beberapa kegagalan berturut-turut, AI diistirahatkan agar bot
 *     tidak menghabiskan waktu siklus menunggu layanan yang sedang mati.
 *
 * Pemanggil TIDAK perlu menangani galat: `tryComplete` mengembalikan null bila
 * AI tidak bisa dipakai, dan pemanggil memakai jalur non-AI-nya.
 */
/**
 * Keadaan satu penyedia.
 *
 * Dipisah per penyedia, BUKAN per layanan. Ini yang membuat rantai cadangan
 * berguna: kalau istirahat dan batas laju dibagi bersama, Gemini yang kehabisan
 * kuota akan ikut mematikan Groq — dan cadangan yang mati saat dibutuhkan sama
 * saja dengan tidak punya cadangan.
 */
interface ProviderSlot {
  name: AiProviderName;
  provider: AiProvider;
  callTimestamps: number[];
  consecutiveFailures: number;
  pausedUntil: number;
  /**
   * Alasan kunci ditolak, bila penyedia menolaknya.
   *
   * Kunci dibaca sekali saat init, jadi penolakan TIDAK akan sembuh sendiri —
   * operator harus memperbaiki kuncinya lalu memulai ulang proses. Karena itu
   * keadaan ini menempel: mencoba lagi tiap siklus hanya membuang permintaan
   * dan menumpuk peringatan yang sama di log.
   */
  credentialRejected: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);

  /**
   * Rantai penyedia, indeks 0 adalah yang utama.
   *
   * Cadangan bersifat OPT-IN lewat AI_FALLBACK_PROVIDERS. Menambahkan setiap
   * penyedia yang kebetulan punya kunci akan mengirim data ke layanan yang
   * tidak pernah dipilih operator — itu keputusan mereka, bukan bawaan.
   */
  private slots: ProviderSlot[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
    private readonly anthropic: AnthropicProvider,
  ) {}

  onModuleInit(): void {
    const primary = this.normalizeName(this.config.get<string>('AI_PROVIDER', 'none'));

    if (primary === 'none') {
      this.logger.log('AI tidak aktif (AI_PROVIDER=none) — sentimen memakai kamus kata');
      return;
    }

    const fallbacks = (this.config.get<string>('AI_FALLBACK_PROVIDERS', '') ?? '')
      .split(',')
      .map((x) => this.normalizeName(x))
      .filter((x) => x !== 'none' && x !== primary);

    // Urutan dipertahankan, duplikat dibuang.
    for (const name of [primary, ...new Set(fallbacks)]) {
      const slot = this.buildSlot(name, name === primary);
      if (slot) this.slots.push(slot);
    }

    if (!this.slots.length) return;

    const utama = this.slots[0];
    this.logger.log(`AI aktif: ${utama.name} (${utama.provider.model})`);

    if (this.slots.length > 1) {
      this.logger.log(
        'Cadangan AI: ' +
          this.slots
            .slice(1)
            .map((x) => `${x.name} (${x.provider.model})`)
            .join(' -> ') +
          '. Dipakai hanya bila yang utama kehabisan kuota atau sedang mati.',
      );
    }
  }

  private normalizeName(raw: string | undefined): AiProviderName {
    return ((raw ?? '').trim().toLowerCase() || 'none') as AiProviderName;
  }

  /**
   * Siapkan satu penyedia, atau null bila tidak bisa dipakai.
   *
   * `isPrimary` hanya mempengaruhi tingkat log: penyedia utama yang tidak siap
   * adalah masalah yang perlu dilihat operator, sedangkan cadangan yang belum
   * diisi kuncinya adalah keadaan yang wajar.
   */
  private buildSlot(name: AiProviderName, isPrimary: boolean): ProviderSlot | null {
    const candidates: Partial<Record<AiProviderName, AiProvider>> = {
      gemini: this.gemini,
      groq: this.groq,
      anthropic: this.anthropic,
    };

    const chosen = candidates[name];
    if (!chosen) {
      const pesan =
        `Penyedia AI "${name}" tidak dikenal. Pilihan: gemini, groq, anthropic, none.`;
      if (isPrimary) {
        this.logger.warn(`${pesan} AI dimatikan; sentimen memakai kamus kata.`);
      } else {
        this.logger.warn(`${pesan} Dilewati sebagai cadangan.`);
      }
      return null;
    }

    if (!chosen.isConfigured()) {
      if (isPrimary) {
        this.logger.warn(
          `AI_PROVIDER=${name} dipilih tetapi kunci API-nya belum diisi. ` +
            'AI dimatikan; sentimen tetap berjalan memakai kamus kata.',
        );
      } else {
        this.logger.log(`Cadangan ${name} dilewati: kunci API-nya belum diisi.`);
      }
      return null;
    }

    return {
      name: chosen.name,
      provider: chosen,
      callTimestamps: [],
      consecutiveFailures: 0,
      pausedUntil: 0,
      credentialRejected: null,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  isAvailable(): boolean {
    return this.slots.some((x) => this.slotUsable(x));
  }

  /** Penyedia yang akan dipakai permintaan berikutnya, null bila tidak ada. */
  activeProvider(): AiProviderName | null {
    return this.slots.find((x) => this.slotUsable(x))?.name ?? null;
  }

  /**
   * True bila penyedia yang akan dipakai bisa mencari di web.
   *
   * Pemanggil memeriksa ini SEBELUM menyusun prompt, bukan sesudah. Saat
   * beban berpindah ke cadangan yang tidak punya alat pencarian, instruksi
   * "Anda boleh mencari" harus ikut hilang - kalau tidak, model akan
   * mengarang hasil pencarian yang tidak pernah ia lakukan.
   */
  webSearchAvailable(): boolean {
    return this.slots.find((x) => this.slotUsable(x))?.provider.supportsWebSearch === true;
  }

  status(): {
    provider: AiProviderName;
    model: string | null;
    available: boolean;
    /**
     * Mengapa AI tidak tersedia, null bila tersedia.
     *
     * Tanpa ini `available: false` tidak bisa dibedakan antara "belum disetel",
     * "sedang diistirahatkan", dan "kuncinya ditolak" - padahal hanya yang
     * terakhir menuntut tindakan operator.
     */
    reason: string | null;
    pausedForSeconds: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Penyedia yang akan dipakai permintaan berikutnya. */
    activeProvider: AiProviderName | null;
    /** Keadaan tiap penyedia di rantai, berurutan. */
    chain: Array<{
      provider: AiProviderName;
      model: string;
      usable: boolean;
      reason: string | null;
      calls: number;
      pausedForSeconds: number;
    }>;
  } {
    const utama = this.slots[0];

    return {
      // Nama penyedia UTAMA dipertahankan di sini supaya arti field ini tidak
      // berubah bagi pemanggil lama; penyedia yang sedang dipakai ada di
      // `activeProvider`.
      provider: utama?.name ?? 'none',
      model: utama?.provider.model ?? null,
      available: this.isAvailable(),
      reason: this.unavailableReason(),
      pausedForSeconds: utama
        ? Math.max(0, Math.round((utama.pausedUntil - Date.now()) / 1000))
        : 0,
      // Dijumlahkan lintas penyedia: yang dipantau operator adalah biaya
      // seluruh lapisan AI, bukan biaya satu penyedia.
      calls: this.slots.reduce((a, x) => a + x.calls, 0),
      inputTokens: this.slots.reduce((a, x) => a + x.inputTokens, 0),
      outputTokens: this.slots.reduce((a, x) => a + x.outputTokens, 0),
      activeProvider: this.activeProvider(),
      chain: this.slots.map((x) => ({
        provider: x.name,
        model: x.provider.model,
        usable: this.slotUsable(x),
        reason: this.slotReason(x),
        calls: x.calls,
        pausedForSeconds: Math.max(0, Math.round((x.pausedUntil - Date.now()) / 1000)),
      })),
    };
  }

  private unavailableReason(): string | null {
    if (!this.slots.length) return 'AI_PROVIDER belum disetel';
    if (this.isAvailable()) return null;

    // Semua penyedia tidak bisa dipakai: sebutkan sebab masing-masing, karena
    // "AI mati" tanpa sebab tidak memberi operator apa pun untuk diperbaiki.
    return this.slots
      .map((x) => `${x.name}: ${this.slotReason(x) ?? 'tidak diketahui'}`)
      .join('; ');
  }

  private slotReason(slot: ProviderSlot): string | null {
    if (slot.credentialRejected) return `kunci API ditolak: ${slot.credentialRejected}`;
    if (Date.now() < slot.pausedUntil) {
      const detik = Math.round((slot.pausedUntil - Date.now()) / 1000);
      return `sedang diistirahatkan ${detik} detik lagi`;
    }
    if (!this.withinRateLimit(slot)) return 'batas laju tercapai pada sisi kita';
    return null;
  }

  private slotUsable(slot: ProviderSlot): boolean {
    return this.slotReason(slot) === null;
  }

  /**
   * Panggil AI, kembalikan null bila tidak bisa dipakai.
   *
   * SENGAJA tidak melempar. Setiap pemanggil di sistem ini punya jalur non-AI
   * yang berfungsi, dan memaksa mereka menangani galat hanya akan menyebarkan
   * try/catch ke seluruh basis kode untuk sesuatu yang jawabannya selalu sama.
   *
   * Menyusuri rantai: penyedia yang kehabisan kuota atau sedang mati dilewati,
   * dan permintaan diteruskan ke cadangan. SATU percobaan per penyedia -
   * mengulang pada penyedia yang baru saja gagal hanya menunda jawaban, karena
   * sebab kegagalannya belum berubah.
   */
  async tryComplete(req: AiCompletionRequest): Promise<AiCompletionResult | null> {
    if (!this.slots.length) return null;

    for (const slot of this.slots) {
      if (!this.slotUsable(slot)) continue;

      const result = await this.attempt(slot, req);
      if (result) {
        // Dicatat hanya bila cadangan yang menjawab: operator perlu tahu bahwa
        // yang utama sedang tidak terpakai.
        if (slot !== this.slots[0]) {
          this.logger.log(`Dijawab penyedia cadangan ${slot.name} (${slot.provider.model})`);
        }
        return result;
      }
    }

    return null;
  }

  private async attempt(
    slot: ProviderSlot,
    req: AiCompletionRequest,
  ): Promise<AiCompletionResult | null> {
    slot.callTimestamps.push(Date.now());

    try {
      const result = await slot.provider.complete(req);

      slot.consecutiveFailures = 0;
      slot.calls++;
      slot.inputTokens += result.inputTokens ?? 0;
      slot.outputTokens += result.outputTokens ?? 0;

      return result;
    } catch (err) {
      slot.consecutiveFailures++;

      const message = err instanceof AiUnavailableError ? err.message : (err as Error).message;
      const rateLimited = err instanceof AiUnavailableError && err.rateLimited;

      /**
       * Kunci ditolak: berhenti sekarang, jangan tunggu kegagalan kedua.
       *
       * Penolakan kunci bukan gangguan sesaat. Memperlakukannya seperti itu
       * membuat `status()` melaporkan "aktif" sampai ambang jeda tercapai -
       * dan setelah jeda habis, mencoba lagi dengan kunci yang sama.
       */
      if (err instanceof AiUnavailableError && err.credentialRejected) {
        slot.credentialRejected = message;
        slot.consecutiveFailures = 0;
        this.logger.error(
          `Kunci API ${slot.name} DITOLAK: ${message} ` +
            'Penyedia ini dimatikan sampai kuncinya diperbaiki dan proses dimulai ulang. ' +
            'Sentimen memakai kamus kata; keputusan trading tidak terpengaruh.',
        );
        return null;
      }

      /**
       * Kuota habis: istirahatkan penyedia ini SEKARANG, jangan tunggu tiga
       * kegagalan.
       *
       * Kuota yang habis tidak akan pulih dalam hitungan detik, dan dua
       * percobaan berikutnya yang pasti gagal hanya menunda jawaban yang
       * sebenarnya bisa diberikan cadangan. Inilah yang membuat rantai berguna
       * pada praktiknya, bukan hanya pada rancangan.
       */
      if (err instanceof AiUnavailableError && err.quotaExhausted) {
        slot.pausedUntil = Date.now() + QUOTA_PAUSE_MS;
        slot.consecutiveFailures = 0;
        this.logger.warn(
          `Kuota ${slot.name} habis (${message}). ` +
            `Diistirahatkan ${QUOTA_PAUSE_MS / 60_000} menit` +
            (this.slots.length > 1 ? '; permintaan dialihkan ke cadangan.' : '.'),
        );
        return null;
      }

      if (slot.consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
        slot.pausedUntil = Date.now() + PAUSE_MS;
        slot.consecutiveFailures = 0;
        this.logger.warn(
          `AI gagal ${FAILURES_BEFORE_PAUSE}x berturut-turut (${message}). ` +
            `Diistirahatkan ${PAUSE_MS / 60_000} menit; sentimen memakai kamus kata. ` +
            'Keputusan trading tidak terpengaruh.',
        );
      } else {
        this.logger.warn(`AI gagal${rateLimited ? ' (batas laju)' : ''}: ${message}`);
      }

      return null;
    }
  }

  /**
   * Batas laju ditegakkan di sisi kita, per penyedia.
   *
   * Menunggu sampai penyedia menolak dengan 429 berarti membuang satu
   * permintaan dan menambah latensi pada siklus trading. Lebih baik melewatkan
   * penilaian AI daripada menunda siklusnya.
   */
  private withinRateLimit(slot: ProviderSlot): boolean {
    const limit = PROVIDER_RATE_LIMITS[slot.name as Exclude<AiProviderName, 'none'>];
    if (!limit) return false;

    const cutoff = Date.now() - 60_000;
    slot.callTimestamps = slot.callTimestamps.filter((t) => t > cutoff);

    return slot.callTimestamps.length < limit.rpm;
  }
}
