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
 * Anthropic Claude.
 *
 * Bawaannya Haiku: untuk klasifikasi judul berita, model terkecil sudah cukup
 * dan selisih biayanya besar. Memakai model terbesar di sini membayar
 * kemampuan penalaran yang tidak terpakai.
 */
@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name: AiProviderName = 'anthropic';
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY', '').trim();
    this.model = this.config.get<string>('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001').trim();
    this.http = axios.create({
      baseURL: 'https://api.anthropic.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiUnavailableError('ANTHROPIC_API_KEY belum diisi', this.name);
    }

    const started = Date.now();

    try {
      const res = await this.http.post(
        '/v1/messages',
        {
          model: this.model,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          // Instruksi sistem ditandai cacheable: ia tetap sama tiap permintaan
          // dan menyumbang bagian terbesar token masuk.
          system: [
            { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: req.user }],
        },
        { headers: { 'x-api-key': this.apiKey } },
      );

      const text = (res.data?.content ?? [])
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('')
        .trim();

      if (!text) {
        throw new AiUnavailableError('Claude tidak mengembalikan teks', this.name);
      }

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: res.data?.usage?.input_tokens,
        outputTokens: res.data?.usage?.output_tokens,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const detail = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message
        : (err as Error).message;

      throw new AiUnavailableError(
        `Claude gagal${status ? ` (HTTP ${status})` : ''}: ${detail}`,
        this.name,
        status === 429 || status === 529,
        status === 401 || status === 403,
      );
    }
  }
}
