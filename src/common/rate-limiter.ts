/**
 * Token-bucket rate limiter sederhana.
 * Indodax membatasi request per menit; melebihinya menghasilkan 429 dan
 * (untuk private API) bisa membuat key diblokir sementara.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
      await sleep(Math.max(waitMs, 25));
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Kembalikan true bila error layak dicoba ulang. */
  retryable?: (err: any) => boolean;
  onRetry?: (attempt: number, err: any, delayMs: number) => void;
}

/** Error jaringan / server / rate-limit umumnya aman untuk diulang. */
export function isTransientError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const code = err?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return true;
  }
  return false;
}

/**
 * Retry dengan exponential backoff + jitter.
 * PENTING: hanya boleh dipakai untuk operasi idempoten. Penempatan order
 * TIDAK idempoten — jangan bungkus dengan ini tanpa pengecekan duplikat.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const retryable = opts.retryable ?? isTransientError;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !retryable(err)) throw err;
      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.round(backoff * (0.5 + Math.random() * 0.5)); // jitter 50-100%
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
