import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { Mutex } from '../common/mutex';
import { RateLimiter, withRetry, isTransientError } from '../common/rate-limiter';

/**
 * Klien Indodax Trade API v2 (TAPIv2).
 *
 * Indodax punya DUA private API yang tidak saling menerima kunci:
 *
 *   TAPI lama : POST https://indodax.com/tapi
 *               HMAC-SHA512, header Key + Sign, parameter `method=`
 *   TAPIv2    : https://api.indodax.com/api/v2/*
 *               HMAC-SHA256, header X-APIKEY + Sign, jalur REST
 *
 * Dokumentasi resmi menyatakan "TAPIv2 can only be accessed with a dedicated
 * TAPIv2 API key" — kunci yang dibuat untuk satu versi DITOLAK oleh versi lain,
 * dengan galat `-2015` yang berbunyi "Access denied". Pesan itu tidak menyebut
 * versi sama sekali, sehingga sangat mudah disalahartikan sebagai masalah izin
 * atau IP whitelist. Itulah yang terjadi pada 6-7 Oktober 2026: izin sudah
 * benar, IP sudah didaftarkan, tetapi botnya berbicara protokol yang salah.
 */

export interface V2Balance {
  idr: number;
  [asset: string]: number;
}

export interface V2AccountInfo {
  canTrade: boolean;
  canWithdraw: boolean;
  accountType: string;
  available: V2Balance;
  /** Dana yang tertahan di open order. */
  locked: V2Balance;
}

export type V2OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface V2Order {
  symbol: string;
  orderId: string;
  clientOrderId?: string;
  side: 'BUY' | 'SELL';
  type: string;
  price: number;
  origQty: number;
  executedQty: number;
  status: V2OrderStatus;
  time?: number;
  raw?: any;
}

/** Galat yang dikembalikan Indodax beserta kodenya, agar bisa dibedakan pemanggil. */
export class IndodaxV2Error extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'IndodaxV2Error';
  }

  /** Kunci ini bukan kunci TAPIv2 (atau izin/IP ditolak). */
  get isAccessDenied(): boolean {
    return this.code === -2015;
  }

  /**
   * IP pemanggil tidak ada di whitelist.
   *
   * Indodax memakai -2015 untuk dua hal yang obatnya sangat berbeda: kunci
   * salah dan IP tidak terdaftar. Hanya teks pesannya yang membedakan, jadi
   * pembedaan itu dilakukan di sini sekali — bukan di tiap pemanggil.
   */
  get isUnauthorizedIp(): boolean {
    return this.code === -2015 && /unauthorized ip/i.test(this.message);
  }

  /** Jam lokal terlalu jauh dari jam server. */
  get isTimestampError(): boolean {
    return this.code === -1021;
  }

  get isOrderNotFound(): boolean {
    return this.code === -2013;
  }
}

@Injectable()
export class IndodaxV2Client {
  private readonly logger = new Logger(IndodaxV2Client.name);
  private readonly baseUrl = 'https://api.indodax.com';

  private readonly limiter = new RateLimiter(20, 1); // ~60 req/menit
  /** Pengambilan offset jam diserialkan agar tidak ada dua probe bersamaan. */
  private readonly clockMutex = new Mutex();

  /**
   * Selisih (ms) jam server Indodax terhadap jam mesin ini.
   *
   * TAPIv2 menolak permintaan yang timestamp-nya di luar `recvWindow`
   * (default 5 detik). Mesin dengan jam meleset beberapa menit — hal yang
   * biasa pada Windows tanpa sinkronisasi waktu — akan ditolak terus-menerus
   * dengan galat `-1021` yang terdengar seperti masalah kode, padahal cuma jam.
   * Daripada menuntut operator membetulkan jamnya, offset dihitung sendiri.
   */
  private clockOffsetMs = 0;
  private clockSyncedAt = 0;

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('INDODAX_API_KEY', '');
  }

  private get secret(): string {
    return this.config.get<string>('INDODAX_SECRET_KEY', '');
  }

  private get recvWindow(): number {
    return Number(this.config.get<string>('INDODAX_RECV_WINDOW', '10000'));
  }

  hasCredentials(): boolean {
    const k = this.apiKey;
    const s = this.secret;
    return !!(k && s && !k.startsWith('your_') && !s.startsWith('your_'));
  }

  // ─── Sinkronisasi jam ─────────────────────────────────────────────────────

  /** Selisih jam terakhir yang terukur, untuk ditampilkan di health check. */
  getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  /** Ambil waktu server dan hitung ulang offset. Di-cache 15 menit. */
  async syncClock(force = false): Promise<number> {
    return this.clockMutex.runExclusive(async () => {
      if (!force && Date.now() - this.clockSyncedAt < 15 * 60_000) {
        return this.clockOffsetMs;
      }

      const before = Date.now();
      const res = await axios.get(`${this.baseUrl}/api/v2/time`, { timeout: 10000 }).catch(() =>
        // Endpoint waktu v2 belum tentu ada di semua wilayah; sumber lama
        // mengembalikan nilai yang sama dan selalu tersedia.
        axios.get('https://indodax.com/api/server_time', { timeout: 10000 }),
      );
      const after = Date.now();

      const raw = Number(res.data?.serverTime ?? res.data?.server_time ?? res.data?.timestamp);
      if (!Number.isFinite(raw)) {
        this.logger.warn('Waktu server tidak terbaca; offset jam dibiarkan apa adanya');
        return this.clockOffsetMs;
      }

      // Tentukan satuan dari besarnya angka — jangan diasumsikan detik atau ms.
      const serverMs = raw > 1e12 ? raw : raw * 1000;
      // Titik tengah antara sebelum dan sesudah permintaan meredam latensi jaringan.
      const localMs = (before + after) / 2;

      const previous = this.clockOffsetMs;
      this.clockOffsetMs = Math.round(serverMs - localMs);
      this.clockSyncedAt = Date.now();

      const skewSeconds = Math.abs(this.clockOffsetMs) / 1000;
      if (skewSeconds > 30 && Math.abs(this.clockOffsetMs - previous) > 5000) {
        this.logger.warn(
          `Jam mesin ini meleset ${skewSeconds.toFixed(0)} detik dari server Indodax ` +
            `(${this.clockOffsetMs > 0 ? 'tertinggal' : 'mendahului'}). Permintaan tetap ` +
            `dikoreksi otomatis, tetapi sebaiknya aktifkan sinkronisasi waktu di sistem — ` +
            `selisih sebesar ini juga membuat stempel waktu di log tidak bisa dipercaya.`,
        );
      }

      return this.clockOffsetMs;
    });
  }

  private async timestamp(): Promise<number> {
    await this.syncClock();
    return Date.now() + this.clockOffsetMs;
  }

  // ─── Permintaan bertanda tangan ───────────────────────────────────────────

  /**
   * TAPIv2 menandatangani string parameter yang SAMA PERSIS dengan yang
   * dikirim. Membangun query string dua kali (sekali untuk ditandatangani,
   * sekali untuk dikirim) berisiko menghasilkan urutan atau encoding berbeda
   * dan membuat tanda tangan ditolak — jadi string itu dibuat sekali lalu
   * dipakai untuk keduanya.
   */
  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number> = {},
    retries = 2,
  ): Promise<T> {
    if (!this.hasCredentials()) {
      throw new IndodaxV2Error('API key Indodax belum dikonfigurasi', -2014);
    }

    const attempt = async (): Promise<T> => {
      await this.limiter.acquire();

      const full: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') full[k] = String(v);
      }
      full.timestamp = String(await this.timestamp());
      full.recvWindow = String(this.recvWindow);

      const payload = new URLSearchParams(full).toString();
      const signature = this.sign(payload);

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-APIKEY': this.apiKey,
        Sign: signature,
      };

      try {
        if (method === 'POST') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          const res = await axios.post(`${this.baseUrl}${path}`, payload, {
            headers,
            timeout: 20000,
          });
          return res.data as T;
        }

        const res = await axios.request({
          method,
          url: `${this.baseUrl}${path}?${payload}`,
          headers,
          timeout: 20000,
        });
        return res.data as T;
      } catch (err: any) {
        const data = err?.response?.data;
        if (data && typeof data.code === 'number') {
          const e = new IndodaxV2Error(
            data.msg || `Indodax v2 error ${data.code}`,
            data.code,
            err.response.status,
          );

          // Jam yang meleset bisa diperbaiki sendiri; paksa sinkronisasi ulang
          // agar percobaan berikutnya memakai offset terbaru.
          if (e.isTimestampError) {
            this.logger.warn('Timestamp ditolak server — menyinkronkan ulang jam');
            await this.syncClock(true);
          }
          throw e;
        }
        throw err;
      }
    };

    return withRetry(attempt, {
      retries,
      // Galat timestamp layak diulang karena jam baru saja disinkronkan ulang.
      retryable: (e) => isTransientError(e) || (e instanceof IndodaxV2Error && e.isTimestampError),
      onRetry: (a, e) => this.logger.warn(`Retry ${method} ${path} #${a}: ${e.message}`),
    });
  }

  // ─── Akun ─────────────────────────────────────────────────────────────────

  async getAccount(): Promise<V2AccountInfo> {
    const data = await this.request<any>('GET', '/api/v2/account');

    const available: V2Balance = { idr: 0 };
    const locked: V2Balance = { idr: 0 };

    for (const b of data.balances ?? []) {
      const asset = String(b.asset).toLowerCase();
      available[asset] = parseFloat(b.free ?? '0') || 0;
      locked[asset] = parseFloat(b.locked ?? '0') || 0;
    }

    return {
      canTrade: !!data.canTrade,
      canWithdraw: !!data.canWithdraw,
      accountType: String(data.accountType ?? 'unknown'),
      available,
      locked,
    };
  }

  // ─── Order ────────────────────────────────────────────────────────────────

  /**
   * Pasang limit order.
   *
   * Berbeda dengan TAPI lama yang menerima nilai IDR untuk pembelian, TAPIv2
   * selalu meminta `quantity` dalam aset dasar. Konversi dilakukan pemanggil
   * agar pembulatan ke presisi pair terjadi satu kali, di tempat yang memang
   * mengetahui aturan pair tersebut.
   */
  async placeLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    price: string,
    quantity: string,
    clientOrderId?: string,
  ): Promise<V2Order> {
    const params: Record<string, string> = {
      symbol: symbol.toUpperCase(),
      side,
      type: 'LIMIT',
      price,
      quantity,
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;

    // retries 0: penempatan order TIDAK idempoten. Mengulangnya setelah
    // timeout berisiko membuat dua posisi untuk satu sinyal.
    const data = await this.request<any>('POST', '/api/v2/order', params, 0);
    return this.toOrder(data, side);
  }

  async getOrder(symbol: string, orderId: string): Promise<V2Order> {
    const data = await this.request<any>('GET', '/api/v2/order', {
      symbol: symbol.toUpperCase(),
      orderId,
    });
    return this.toOrder(data);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<V2Order | null> {
    try {
      const data = await this.request<any>(
        'DELETE',
        '/api/v2/order',
        { symbol: symbol.toUpperCase(), orderId },
        0,
      );
      return this.toOrder(data);
    } catch (err) {
      // Order yang sudah terisi penuh atau sudah hilang tidak bisa dibatalkan —
      // itu bukan kegagalan yang perlu dieskalasi.
      if (err instanceof IndodaxV2Error && err.isOrderNotFound) {
        this.logger.warn(`Cancel ${orderId} diabaikan: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  async getOpenOrders(symbol?: string): Promise<V2Order[]> {
    const data = await this.request<any>(
      'GET',
      '/api/v2/openOrders',
      symbol ? { symbol: symbol.toUpperCase() } : {},
    );
    const rows = Array.isArray(data) ? data : (data?.orders ?? []);
    return rows.map((r: any) => this.toOrder(r));
  }

  async getMyTrades(symbol: string, limit = 100): Promise<any[]> {
    const data = await this.request<any>('GET', '/api/v2/myTrades', {
      symbol: symbol.toUpperCase(),
      limit,
    });
    return Array.isArray(data) ? data : (data?.trades ?? []);
  }

  private toOrder(raw: any, fallbackSide?: 'BUY' | 'SELL'): V2Order {
    return {
      symbol: String(raw.symbol ?? ''),
      orderId: String(raw.orderId ?? raw.order_id ?? ''),
      clientOrderId: raw.clientOrderId,
      side: (raw.side ?? fallbackSide ?? 'BUY') as 'BUY' | 'SELL',
      type: String(raw.type ?? 'LIMIT'),
      price: parseFloat(raw.price ?? '0') || 0,
      origQty: parseFloat(raw.origQty ?? '0') || 0,
      executedQty: parseFloat(raw.executedQty ?? '0') || 0,
      // Order yang baru dibuat belum membawa status; NEW adalah keadaannya.
      status: (raw.status ?? 'NEW') as V2OrderStatus,
      time: raw.time,
      raw,
    };
  }

  /**
   * Periksa apakah kunci yang terpasang benar-benar kunci TAPIv2.
   * Dipakai saat startup untuk memilih protokol secara otomatis.
   */
  async probe(): Promise<{ ok: boolean; reason?: string; code?: number; ipRejected?: boolean }> {
    try {
      const acct = await this.getAccount();
      return acct.canTrade
        ? { ok: true }
        : { ok: true, reason: 'Kunci valid tetapi izin Spot Trading belum aktif' };
    } catch (err) {
      if (err instanceof IndodaxV2Error) {
        return {
          ok: false,
          reason: err.message,
          code: err.code,
          ipRejected: err.isUnauthorizedIp,
        };
      }
      return { ok: false, reason: (err as Error).message };
    }
  }
}
