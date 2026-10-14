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
@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private provider: AiProvider | null = null;
  private providerName: AiProviderName = 'none';

  private callTimestamps: number[] = [];
  private consecutiveFailures = 0;
  private pausedUntil = 0;

  /**
   * Alasan kunci ditolak, bila penyedia menolaknya.
   *
   * Kunci dibaca sekali saat init, jadi penolakan TIDAK akan sembuh sendiri —
   * operator harus memperbaiki kuncinya lalu memulai ulang proses. Karena itu
   * keadaan ini menempel: mencoba lagi tiap siklus hanya membuang permintaan
   * dan menumpuk peringatan yang sama di log.
   */
  private credentialRejected: string | null = null;

  private totalCalls = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
    private readonly anthropic: AnthropicProvider,
  ) {}

  onModuleInit(): void {
    const configured = this.config
      .get<string>('AI_PROVIDER', 'none')
      .trim()
      .toLowerCase() as AiProviderName;

    if (configured === 'none' || !configured) {
      this.logger.log('AI tidak aktif (AI_PROVIDER=none) — sentimen memakai kamus kata');
      return;
    }

    const candidates: Record<string, AiProvider> = {
      gemini: this.gemini,
      groq: this.groq,
      anthropic: this.anthropic,
    };

    const chosen = candidates[configured];
    if (!chosen) {
      this.logger.warn(
        `AI_PROVIDER="${configured}" tidak dikenal. Pilihan: gemini, groq, anthropic, none. ` +
          'AI dimatikan; sentimen memakai kamus kata.',
      );
      return;
    }

    if (!chosen.isConfigured()) {
      this.logger.warn(
        `AI_PROVIDER=${configured} dipilih tetapi kunci API-nya belum diisi. ` +
          'AI dimatikan; sentimen tetap berjalan memakai kamus kata.',
      );
      return;
    }

    this.provider = chosen;
    this.providerName = chosen.name;
    this.logger.log(`AI aktif: ${chosen.name} (${chosen.model})`);
  }

  isAvailable(): boolean {
    return this.provider !== null && !this.credentialRejected && Date.now() >= this.pausedUntil;
  }

  status(): {
    provider: AiProviderName;
    model: string | null;
    available: boolean;
    /**
     * Mengapa AI tidak tersedia, null bila tersedia.
     *
     * Tanpa ini `available: false` tidak bisa dibedakan antara "belum disetel",
     * "sedang diistirahatkan", dan "kuncinya ditolak" — padahal hanya yang
     * terakhir menuntut tindakan operator.
     */
    reason: string | null;
    pausedForSeconds: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  } {
    return {
      provider: this.providerName,
      model: this.provider?.model ?? null,
      available: this.isAvailable(),
      reason: this.unavailableReason(),
      pausedForSeconds: Math.max(0, Math.round((this.pausedUntil - Date.now()) / 1000)),
      calls: this.totalCalls,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
    };
  }

  private unavailableReason(): string | null {
    if (!this.provider) {
      return this.providerName === 'none'
        ? 'AI_PROVIDER belum disetel'
        : `penyedia ${this.providerName} tidak siap`;
    }
    if (this.credentialRejected) return `kunci API ditolak: ${this.credentialRejected}`;
    if (Date.now() < this.pausedUntil) return 'sedang diistirahatkan setelah gagal berulang';
    return null;
  }

  /**
   * Panggil AI, kembalikan null bila tidak bisa dipakai.
   *
   * SENGAJA tidak melempar. Setiap pemanggil di sistem ini punya jalur non-AI
   * yang berfungsi, dan memaksa mereka menangani galat hanya akan menyebarkan
   * try/catch ke seluruh basis kode untuk sesuatu yang jawabannya selalu sama.
   */
  async tryComplete(req: AiCompletionRequest): Promise<AiCompletionResult | null> {
    if (!this.provider) return null;
    if (this.credentialRejected) return null;

    if (Date.now() < this.pausedUntil) {
      return null;
    }

    if (!this.withinRateLimit()) {
      this.logger.debug('Batas laju AI tercapai pada sisi kita; permintaan dilewati');
      return null;
    }

    this.callTimestamps.push(Date.now());

    try {
      const result = await this.provider.complete(req);

      this.consecutiveFailures = 0;
      this.totalCalls++;
      this.totalInputTokens += result.inputTokens ?? 0;
      this.totalOutputTokens += result.outputTokens ?? 0;

      return result;
    } catch (err) {
      this.consecutiveFailures++;

      const message = err instanceof AiUnavailableError ? err.message : (err as Error).message;
      const rateLimited = err instanceof AiUnavailableError && err.rateLimited;

      /**
       * Kunci ditolak: berhenti sekarang, jangan tunggu kegagalan kedua.
       *
       * Penolakan kunci bukan gangguan sesaat. Memperlakukannya seperti itu
       * membuat `status()` melaporkan "aktif" sampai ambang jeda tercapai —
       * dan setelah jeda habis, mencoba lagi dengan kunci yang sama.
       */
      if (err instanceof AiUnavailableError && err.credentialRejected) {
        this.credentialRejected = message;
        this.consecutiveFailures = 0;
        this.logger.error(
          `Kunci API ${this.providerName} DITOLAK: ${message} ` +
            'AI dimatikan sampai kuncinya diperbaiki dan proses dimulai ulang. ' +
            'Sentimen memakai kamus kata; keputusan trading tidak terpengaruh.',
        );
        return null;
      }

      if (this.consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
        this.pausedUntil = Date.now() + PAUSE_MS;
        this.consecutiveFailures = 0;
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
   * Batas laju ditegakkan di sisi kita.
   *
   * Menunggu sampai penyedia menolak dengan 429 berarti membuang satu
   * permintaan dan menambah latensi pada siklus trading. Lebih baik melewatkan
   * penilaian AI daripada menunda siklusnya.
   */
  private withinRateLimit(): boolean {
    if (!this.provider || this.providerName === 'none') return false;

    const limit = PROVIDER_RATE_LIMITS[this.providerName as Exclude<AiProviderName, 'none'>];
    if (!limit) return false;

    const cutoff = Date.now() - 60_000;
    this.callTimestamps = this.callTimestamps.filter((t) => t > cutoff);

    return this.callTimestamps.length < limit.rpm;
  }
}
