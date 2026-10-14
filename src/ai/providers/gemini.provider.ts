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
 * Google Gemini lewat AI Studio.
 *
 * Dipilih sebagai bawaan karena tier gratisnya tidak memerlukan kartu kredit.
 * Sejak April 2026 tier gratis HANYA model Flash — model Pro menuntut billing
 * aktif. Karena itu bawaannya Flash, dan nama modelnya dapat dikonfigurasi:
 * Google mengganti nama model beberapa kali setahun dan nama yang ditanam di
 * kode akan membusuk.
 */
@Injectable()
export class GeminiProvider implements AiProvider {
  readonly name: AiProviderName = 'gemini';
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('GEMINI_API_KEY', '').trim();
    this.model = this.config.get<string>('GEMINI_MODEL', 'gemini-3.6-flash').trim();
    this.http = axios.create({
      // Dapat ditimpa untuk proxy, endpoint regional, dan pengujian
      // end-to-end tanpa kunci sungguhan.
      baseURL: this.config.get<string>(
        'GEMINI_BASE_URL',
        'https://generativelanguage.googleapis.com',
      ),
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiUnavailableError('GEMINI_API_KEY belum diisi', this.name);
    }

    const started = Date.now();

    try {
      const res = await this.http.post(
        `/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          // systemInstruction dipisah dari contents: itu yang membuat teks
          // berita berada di posisi DATA, bukan posisi instruksi.
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens,
            // Klasifikasi tidak perlu keragaman; ini membuat hasilnya stabil.
            topP: 1,
            // Penalaran internal memakai kuota maxOutputTokens yang sama dan
            // terjadi lebih dulu — lihat catatan di AiCompletionRequest.
            ...(req.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        },
        { params: { key: this.apiKey } },
      );

      const candidate = res.data?.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .map((p: { text?: string }) => p?.text ?? '')
        .join('')
        .trim();

      if (!text) {
        // Balasan kosong biasanya berarti safety filter memblokir, atau
        // maxOutputTokens terlalu kecil. Keduanya harus terlihat, bukan
        // dilewatkan sebagai "tidak ada sentimen".
        const reason = candidate?.finishReason ?? 'tidak diketahui';
        throw new AiUnavailableError(`Gemini tidak mengembalikan teks (finishReason=${reason})`, this.name);
      }

      const usage = res.data?.usageMetadata;

      // Terpotong karena kuota: teksnya ada tetapi belum selesai. Untuk tugas
      // berformat, parser pemanggil akan menolaknya — tetapi sebabnya harus
      // terlihat, bukan tampak seperti model yang menjawab buruk.
      if (candidate?.finishReason === 'MAX_TOKENS') {
        this.logger.warn(
          `Balasan Gemini terpotong di batas ${req.maxOutputTokens} token` +
            (usage?.thoughtsTokenCount
              ? ` — ${usage.thoughtsTokenCount} di antaranya terpakai untuk penalaran internal. ` +
                'Naikkan maxOutputTokens atau setel disableThinking.'
              : '. Naikkan maxOutputTokens.'),
        );
      }

      return {
        text,
        provider: this.name,
        model: this.model,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;

      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const detail = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message
        : (err as Error).message;

      // 429 = batas laju, 503 = model sibuk. Keduanya layak dicoba lagi nanti;
      // 400/403 berarti kunci atau nama model salah dan tidak akan membaik.
      throw new AiUnavailableError(
        `Gemini gagal${status ? ` (HTTP ${status})` : ''}: ${detail}`,
        this.name,
        status === 429 || status === 503,
        status === 401 || status === 403,
      );
    }
  }
}
