import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderName,
  AiUnavailableError,
} from '../ai.types';

/**
 * Groq — inferensi model terbuka di perangkat LPU.
 *
 * CATATAN: daftar model Groq BERUBAH tanpa pemberitahuan. Default sebelumnya
 * `llama-3.3-70b-versatile` sudah dihapus dan membalas HTTP 404 — kegagalan
 * yang justru muncul saat cadangan ini dibutuhkan. Periksa dengan
 * `GET /openai/v1/models` sebelum menyalahkan kuncinya.
 *
 * CATATAN PENTING: Groq BUKAN Grok. Groq adalah penyedia inferensi dengan tier
 * gratis permanen; Grok adalah model milik xAI. Keduanya sering tertukar dan
 * konsekuensinya berbeda jauh — yang satu gratis, yang lain berbayar.
 *
 * API-nya mengikuti bentuk OpenAI, sehingga adapter ini juga bisa dipakai
 * untuk penyedia lain yang kompatibel dengan mengubah `GROQ_BASE_URL`.
 */
@Injectable()
export class GroqProvider implements AiProvider {
  readonly name: AiProviderName = 'groq';
  private readonly logger = new Logger(GroqProvider.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('GROQ_API_KEY', '').trim();
    this.model = this.config
      .get<string>('GROQ_MODEL', 'openai/gpt-oss-120b')
      .trim();
    this.http = axios.create({
      baseURL: this.config.get<string>('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      timeout: 30000,
    });
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiUnavailableError('GROQ_API_KEY belum diisi', this.name);
    }

    const started = Date.now();

    try {
      const res = await this.http.post(
        '/chat/completions',
        {
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens,
        },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );

      const text = String(res.data?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) {
        throw new AiUnavailableError('Groq tidak mengembalikan teks', this.name);
      }

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: res.data?.usage?.prompt_tokens,
        outputTokens: res.data?.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const detail = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message
        : (err as Error).message;

      throw new AiUnavailableError(
        `Groq gagal${status ? ` (HTTP ${status})` : ''}: ${detail}`,
        this.name,
        status === 429 || status === 503,
        status === 401 || status === 403,
        status === 429,
      );
    }
  }
}
