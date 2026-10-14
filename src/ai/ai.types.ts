/**
 * Lapisan AI yang netral terhadap penyedia.
 *
 * Mengapa ada abstraksi dan bukan satu klien langsung: harga dan batas gratis
 * penyedia AI berubah cepat — Gemini memotong batas free tier-nya 50-80% pada
 * April 2026, tier Basic X ditutup untuk pendaftar baru pada Februari 2026.
 * Mengikat kode ke satu penyedia berarti ikut terseret setiap perubahan itu.
 *
 * Dengan antarmuka ini, berganti penyedia hanya mengubah satu nilai di `.env`.
 */

export type AiProviderName = 'gemini' | 'groq' | 'anthropic' | 'none';

export interface AiCompletionRequest {
  /** Instruksi tetap. Dipisah agar bisa di-cache oleh penyedia yang mendukung. */
  system: string;
  /** Data yang diklasifikasi. SELALU diperlakukan sebagai data, bukan instruksi. */
  user: string;
  maxOutputTokens: number;
  /** 0 untuk klasifikasi — hasil yang sama untuk masukan yang sama. */
  temperature: number;
  /**
   * Matikan penalaran internal model.
   *
   * WAJIB true untuk tugas berformat pendek. Model thinking seperti
   * gemini-3.6-flash memakai kuota `maxOutputTokens` yang SAMA untuk berpikir,
   * dan berpikir terjadi lebih dulu. Diukur langsung: dengan kuota 64, model
   * menghabiskan 57 token untuk berpikir, menyisakan 3 token — hasilnya
   * `finishReason: MAX_TOKENS` dan teks terpotong "market context (" tanpa satu
   * skor pun. Dengan penalaran dimatikan, tugas yang sama selesai dalam 14
   * token.
   *
   * Penyedia yang tidak mengenal konsep ini mengabaikannya.
   */
  disableThinking?: boolean;
}

export interface AiCompletionResult {
  text: string;
  provider: AiProviderName;
  model: string;
  /** Token yang dilaporkan penyedia, bila ada. Untuk memantau biaya. */
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Satu penyedia AI.
 *
 * Implementasi WAJIB melempar bila gagal — jangan pernah mengembalikan teks
 * kosong atau nilai pengganti. Pemanggil yang memutuskan apa yang terjadi saat
 * AI tidak tersedia, dan keputusan itu selalu sama: kembali ke kamus kata,
 * bukan menebak.
 */
export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /** False bila kunci API belum diisi. */
  isConfigured(): boolean;
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly provider: AiProviderName,
    /** True bila kegagalannya karena batas laju dan layak dicoba lagi nanti. */
    readonly rateLimited = false,
    /**
     * True bila penyedia MENOLAK kuncinya (HTTP 401/403).
     *
     * Dipisahkan dari kegagalan lain karena ini tidak akan membaik dengan
     * sendirinya: mencoba lagi hanya membuang permintaan, dan status "aktif"
     * menyembunyikan satu-satunya hal yang perlu diperbaiki operator.
     */
    readonly credentialRejected = false,
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/**
 * Batas aman per penyedia pada tier gratisnya.
 *
 * Angka ini SENGAJA dipasang di bawah batas yang diiklankan. Tier gratis
 * berubah tanpa pemberitahuan, dan tertabrak batas laju di tengah siklus
 * trading jauh lebih merugikan daripada menilai beberapa judul lebih sedikit.
 */
export const PROVIDER_RATE_LIMITS: Record<Exclude<AiProviderName, 'none'>, { rpm: number }> = {
  // Free tier Gemini: 10 RPM untuk Flash (April 2026). Dipakai 6.
  gemini: { rpm: 6 },
  // Groq free forever: 30 RPM. Dipakai 20.
  groq: { rpm: 20 },
  // Anthropic kredit gratis: 5 RPM. Dipakai 3.
  anthropic: { rpm: 3 },
};
