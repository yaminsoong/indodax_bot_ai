import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { Mutex } from '../common/mutex';
import { RateLimiter, withRetry, isTransientError } from '../common/rate-limiter';
import { PairRegistryService, PairInfo } from './pair-registry.service';
import { IndodaxV2Client, IndodaxV2Error } from './indodax-v2.client';
import { resolveTradingMode } from '../common/live-mode';
import {
  Balance,
  Candle,
  MarketSummaryRow,
  OrderBook,
  OrderFill,
  OrderResult,
  Ticker,
} from './indodax.types';

export * from './indodax.types';

@Injectable()
export class IndodaxService {
  private readonly logger = new Logger(IndodaxService.name);
  private readonly publicClient: AxiosInstance;
  private readonly privateBaseUrl = 'https://indodax.com/tapi';
  private readonly chartBaseUrl = 'https://indodax.com/tradingview/history_v2';

  /**
   * Timeframe (menit) yang diterima endpoint chart Indodax, terverifikasi
   * langsung terhadap API. Perhatikan bahwa 360 dan 720 DITOLAK meskipun
   * terlihat wajar — memakainya membuat data candle kosong tanpa penyebab
   * yang tampak.
   */
  static readonly VALID_TIMEFRAMES = [1, 5, 15, 30, 60, 240] as const;

  /** Batas candle per respons yang diamati dari endpoint chart Indodax. */
  private static readonly CANDLES_PER_PAGE = 160;

  /**
   * Batas halaman per permintaan.
   *
   * 40 halaman x 160 candle = 6.400 candle, cukup untuk backtest terpanjang
   * yang didukung (5.000 bar). Batas ini mencegah satu pair bermasalah
   * menghabiskan jatah rate limit lewat perulangan tak berujung.
   */
  private static readonly MAX_CANDLE_PAGES = 40;

  static isValidTimeframe(minutes: number): boolean {
    return (IndodaxService.VALID_TIMEFRAMES as readonly number[]).includes(minutes);
  }

  /**
   * Indodax mewajibkan nonce yang naik ketat per API key. Dua panggilan dalam
   * milidetik yang sama menghasilkan nonce identik dan ditolak, jadi seluruh
   * private API diserialkan lewat mutex + counter monotonik.
   */
  private readonly privateMutex = new Mutex();
  private lastNonce = 0;

  private readonly publicLimiter = new RateLimiter(60, 2); // ~120 req/menit
  private readonly privateLimiter = new RateLimiter(20, 0.8); // ~48 req/menit

  /** Cache /api/summaries agar tidak dipanggil berulang per pair. */
  private summariesCache: {
    at: number;
    prices24h: Record<string, number>;
    tickers: Record<string, any>;
  } = { at: 0, prices24h: {}, tickers: {} };

  /**
   * Protokol private API yang dipakai.
   *
   * 'auto' memeriksa sendiri saat panggilan private pertama: kunci TAPIv2 dan
   * kunci TAPI lama saling ditolak, dan galatnya (-2015 "Access denied") tidak
   * menyebut versi sama sekali — sangat mudah disalahartikan sebagai masalah
   * izin atau IP whitelist. Mendeteksinya sendiri jauh lebih murah daripada
   * membiarkan operator menebak.
   */
  private apiVersion: 'v1' | 'v2' | 'unknown' = 'unknown';
  private versionProbe: Promise<'v1' | 'v2'> | null = null;
  /** >0 bila versi yang dipakai baru dugaan, bukan hasil probe yang berhasil. */
  private versionTentativeSince = 0;
  private static readonly VERSION_REPROBE_MS = 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly pairs: PairRegistryService,
    private readonly v2: IndodaxV2Client,
  ) {
    this.publicClient = axios.create({
      baseURL: 'https://indodax.com/api',
      timeout: 15000,
    });
  }

  /**
   * Apakah order benar-benar dikirim ke exchange.
   *
   * Memakai `resolveTradingMode` yang sama dengan BotConfigService, sehingga
   * mustahil terjadi keadaan di mana satu lapisan mengira dirinya simulasi
   * sementara lapisan lain mengirim order sungguhan. LIVE menuntut
   * TRADING_MODE=LIVE DAN LIVE_TRADING_CONFIRMED yang benar.
   */
  private get isLive(): boolean {
    return resolveTradingMode((key) => this.config.get<string>(key)).mode === 'LIVE';
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  private async publicGet<T>(url: string, params?: any): Promise<T> {
    await this.publicLimiter.acquire();
    const res = await withRetry(() => this.publicClient.get(url, { params }), {
      retries: 3,
      onRetry: (a, e) => this.logger.warn(`Retry GET ${url} #${a}: ${e.message}`),
    });
    return res.data as T;
  }

  async getTicker(pair: string): Promise<Ticker> {
    const key = pair.toLowerCase();
    const data = await this.publicGet<any>(`/ticker/${key}`);
    const t = data.ticker;
    if (!t) throw new Error(`Ticker kosong untuk ${pair}`);

    const info = this.pairs.get(key);
    const coin = info?.tradedCurrency ?? key.replace(/idr$|usdt$/, '');

    const last = parseFloat(t.last);
    const buy = parseFloat(t.buy);
    const sell = parseFloat(t.sell);

    return {
      high: parseFloat(t.high),
      low: parseFloat(t.low),
      last,
      buy,
      sell,
      volume_idr: parseFloat(t.vol_idr ?? t.vol_usdt ?? 0),
      volume_coin: parseFloat(t[`vol_${coin}`] ?? 0),
      // Ticker Indodax tidak memuat percent_change_24h — diambil dari summaries.
      percent_change_24h: await this.getChange24h(key, last),
      spreadPercent: buy > 0 && sell > 0 ? ((sell - buy) / buy) * 100 : 0,
    };
  }

  /** Muat /api/summaries (cache 60 detik) — sumber harga 24 jam lalu. */
  private async loadSummaries(): Promise<void> {
    if (Date.now() - this.summariesCache.at < 60_000) return;
    const data = await this.publicGet<any>('/summaries');
    const prices: Record<string, number> = {};
    for (const [k, v] of Object.entries(data.prices_24h || {})) {
      prices[k.toLowerCase()] = parseFloat(v as string);
    }
    this.summariesCache = { at: Date.now(), prices24h: prices, tickers: data.tickers || {} };
  }

  /**
   * Perubahan harga 24 jam, dihitung dari prices_24h.
   * Implementasi lama membaca field `percent_change_24h` yang tidak pernah ada
   * pada respons Indodax, sehingga nilainya selalu 0.
   */
  async getChange24h(pair: string, lastPrice?: number): Promise<number> {
    try {
      await this.loadSummaries();
      const key = pair.toLowerCase();
      const past = this.summariesCache.prices24h[key];
      if (!past || past <= 0) return 0;

      let current = lastPrice;
      if (current === undefined) {
        const tickerId = key.replace(/idr$/, '_idr').replace(/usdt$/, '_usdt');
        const t = this.summariesCache.tickers[tickerId];
        current = t ? parseFloat(t.last) : undefined;
      }
      if (!current || !Number.isFinite(current)) return 0;

      return ((current - past) / past) * 100;
    } catch (err) {
      this.logger.warn(`Gagal menghitung change 24h untuk ${pair}: ${err.message}`);
      return 0;
    }
  }

  async getAllTickers(): Promise<Record<string, any>> {
    await this.loadSummaries();
    return this.summariesCache.tickers;
  }

  /** Ringkasan seluruh pair IDR dengan change 24h yang benar. */
  async getMarketSummary(): Promise<MarketSummaryRow[]> {
    await this.loadSummaries();
    const out: MarketSummaryRow[] = [];

    for (const [tickerId, t] of Object.entries<any>(this.summariesCache.tickers)) {
      const pair = tickerId.replace('_', '');
      if (!pair.endsWith('idr')) continue;

      const last = parseFloat(t.last);
      if (!Number.isFinite(last) || last <= 0) continue;

      // Bid dan ask IKUT dikembalikan. `/api/summaries` sudah memuatnya untuk
      // SELURUH pair dalam satu respons — membuangnya di sini membuat
      // penyaringan spread tampak mahal (satu panggilan ticker per pair)
      // padahal datanya sudah ada di tangan tanpa biaya tambahan.
      const bid = parseFloat(t.buy);
      const ask = parseFloat(t.sell);
      const spreadPercent =
        Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 100 : null;

      const past = this.summariesCache.prices24h[pair];
      out.push({
        pair,
        last,
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        spreadPercent,
        volumeIdr: parseFloat(t.vol_idr ?? 0),
        change24h: past > 0 ? ((last - past) / past) * 100 : 0,
      });
    }
    return out;
  }

  /**
   * Spread terakhir sebuah pair dari cache ringkasan pasar, atau null.
   *
   * TIDAK memicu permintaan jaringan: ia hanya membaca cache yang sudah diisi
   * `loadSummaries()`. Itu membuatnya aman dipanggil dari jalur evaluasi risiko
   * yang berjalan pada setiap sinyal.
   *
   * Mengembalikan null bila cache belum terisi atau pair tidak ada — dan null
   * HARUS diperlakukan sebagai "tidak diketahui", bukan sebagai spread nol.
   */
  getCachedSpreadPercent(pair: string): number | null {
    const t = this.summariesCache?.tickers?.[pair.replace(/^([a-z0-9]+)(idr)$/, '$1_$2')];
    if (!t) return null;

    const bid = parseFloat(t.buy);
    const ask = parseFloat(t.sell);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) return null;

    return ((ask - bid) / bid) * 100;
  }

  /**
   * Ambil candle OHLCV.
   *
   * Memakai endpoint chart Indodax yang aktif saat ini:
   *   /tradingview/history_v2?symbol=BTCIDR&tf=<menit>&from=<epoch>&to=<epoch>
   * yang mengembalikan array objek berkunci kapital (Time/Open/High/Low/Close/Volume).
   *
   * Endpoint lama `/tradingview/history` dengan parameter `resolution` kini
   * hanya membalas teks "OK" tanpa data sama sekali. Itu sebabnya bot versi
   * sebelumnya tidak pernah menghasilkan satu sinyal pun — setiap siklus
   * berakhir dengan "insufficient candles" tanpa ada yang menyadari penyebabnya.
   *
   * @param includeForming bila false (default) candle terakhir yang belum tutup
   * dibuang. Menghitung sinyal pada candle berjalan menyebabkan repainting:
   * crossover bisa muncul lalu hilang sebelum candle benar-benar ditutup.
   */
  /**
   * Ambil satu halaman candle mentah dari endpoint chart.
   *
   * Indodax membatasi SETIAP respons pada sekitar 169 candle, berapa pun
   * rentang waktu yang diminta. Meminta setahun sekaligus hanya mengembalikan
   * seminggu terakhir — tanpa galat, tanpa penanda terpotong. Itulah jebakan
   * yang membuat backtest panjang diam-diam berjalan pada data seminggu.
   */
  private async fetchCandlePage(
    pair: string,
    resolution: number,
    from: number,
    to: number,
  ): Promise<Candle[]> {
    await this.publicLimiter.acquire();
    const res = await withRetry(
      () =>
        axios.get(this.chartBaseUrl, {
          params: { symbol: pair.toUpperCase(), tf: resolution, from, to },
          timeout: 25000,
        }),
      {
        retries: 3,
        onRetry: (a, e) => this.logger.warn(`Retry candles ${pair} #${a}: ${e.message}`),
      },
    );

    const rows = res.data;
    if (!Array.isArray(rows)) return [];

    return rows
      .map((r: any) => ({
        time: Number(r.Time ?? r.time),
        open: parseFloat(r.Open ?? r.open),
        high: parseFloat(r.High ?? r.high),
        low: parseFloat(r.Low ?? r.low),
        close: parseFloat(r.Close ?? r.close),
        volume: parseFloat(r.Volume ?? r.volume ?? 0),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.close > 0,
      );
  }

  /**
   * Ambil candle OHLCV, merangkai beberapa halaman bila perlu.
   *
   * Endpoint chart Indodax memotong setiap respons pada ~169 candle. Untuk
   * mendapat riwayat lebih panjang, jendela digeser mundur berulang kali dan
   * hasilnya disatukan. Penggeseran berhenti sendiri ketika API tidak lagi
   * memberi candle yang lebih tua — itu batas riwayat sesungguhnya untuk pair
   * tersebut, dan memaksa lebih jauh hanya membuang panggilan.
   *
   * @param includeForming bila false (default) candle terakhir yang belum
   * tutup dibuang. Menghitung sinyal pada candle berjalan menyebabkan
   * repainting: crossover bisa muncul lalu hilang sebelum candle ditutup.
   */
  async getCandles(
    pair: string,
    resolution: number,
    limit: number,
    includeForming = false,
  ): Promise<Candle[]> {
    if (!IndodaxService.isValidTimeframe(resolution)) {
      throw new Error(
        `Timeframe ${resolution} menit tidak didukung Indodax. ` +
          `Pilihan yang valid: ${IndodaxService.VALID_TIMEFRAMES.join(', ')} (menit). ` +
          `Nilai lain (mis. 360 atau 720) ditolak API dan membuat data candle kosong ` +
          `tanpa penyebab yang jelas.`,
      );
    }

    const bucketSec = resolution * 60;
    // +5 candle sebagai bantalan agar tetap cukup setelah candle berjalan dibuang.
    const needed = limit + 5;

    const byTime = new Map<number, Candle>();
    let to = Math.floor(Date.now() / 1000);
    let pages = 0;

    while (byTime.size < needed && pages < IndodaxService.MAX_CANDLE_PAGES) {
      pages++;
      const from = to - bucketSec * IndodaxService.CANDLES_PER_PAGE;

      const page = await this.fetchCandlePage(pair, resolution, from, to);
      if (!page.length) break;

      const before = byTime.size;
      for (const c of page) byTime.set(c.time, c);

      // Tidak ada candle baru: riwayat pair ini sudah habis. Berhenti di sini
      // alih-alih memanggil terus sampai batas halaman.
      if (byTime.size === before) break;

      const oldest = Math.min(...page.map((c) => c.time));
      // Geser tepat ke sebelum candle tertua agar halaman tidak saling tumpang
      // tindih sepenuhnya dan penggeseran selalu maju.
      to = oldest - bucketSec;
    }

    if (!byTime.size) {
      this.logger.warn(`Tidak ada data candle untuk ${pair} (tf=${resolution})`);
      return [];
    }

    let candles = [...byTime.values()].sort((a, b) => a.time - b.time);

    if (!includeForming) {
      const currentBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
      candles = candles.filter((c) => c.time < currentBucket);
    }

    if (candles.length < limit && pages > 1) {
      this.logger.debug(
        `${pair} tf=${resolution}: riwayat tersedia hanya ${candles.length} candle ` +
          `dari ${limit} yang diminta (${pages} halaman diambil)`,
      );
    }

    return candles.slice(-limit);
  }

  async getOrderBook(pair: string): Promise<OrderBook> {
    const data = await this.publicGet<any>(`/depth/${pair.toLowerCase()}`);
    const parse = (rows: any[]): number[][] =>
      (rows || []).map((r) => [parseFloat(r[0]), parseFloat(r[1])]);
    return { buy: parse(data.buy), sell: parse(data.sell) };
  }

  // ─── Private API ─────────────────────────────────────────────────────────

  private buildSignature(postData: string): string {
    const secret = this.config.get<string>('INDODAX_SECRET_KEY', '');
    return crypto.createHmac('sha512', secret).update(postData).digest('hex');
  }

  /** Nonce monotonik — tidak pernah mengulang nilai walau dipanggil beruntun. */
  private nextNonce(): string {
    const now = Date.now();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return String(this.lastNonce);
  }

  hasCredentials(): boolean {
    const key = this.config.get<string>('INDODAX_API_KEY', '');
    const secret = this.config.get<string>('INDODAX_SECRET_KEY', '');
    return !!(key && secret && !key.startsWith('your_') && !secret.startsWith('your_'));
  }

  /**
   * Panggil private API. Semua panggilan diserialkan (nonce) dan dibatasi rate.
   *
   * `retries` default 0 karena penempatan order TIDAK idempoten — mengulangnya
   * berisiko membuat order ganda. Hanya panggilan baca yang boleh di-retry.
   */
  private async callLegacyApi(
    method: string,
    params: Record<string, any> = {},
    retries = 0,
  ): Promise<any> {
    if (!this.hasCredentials()) {
      throw new Error('API key Indodax belum dikonfigurasi');
    }

    const apiKey = this.config.get<string>('INDODAX_API_KEY');

    return this.privateMutex.runExclusive(async () => {
      const attempt = async () => {
        await this.privateLimiter.acquire();
        const nonce = this.nextNonce();
        const postData = new URLSearchParams({
          method,
          nonce,
          timestamp: nonce,
          recvWindow: '5000',
          ...params,
        }).toString();

        const res = await axios.post(this.privateBaseUrl, postData, {
          headers: {
            Key: apiKey,
            Sign: this.buildSignature(postData),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 20000,
        });

        if (res.data?.success !== 1) {
          const err: any = new Error(res.data?.error || `Indodax API error (${method})`);
          err.indodaxCode = res.data?.error_code;
          throw err;
        }
        return res.data.return;
      };

      return retries > 0
        ? withRetry(attempt, {
            retries,
            retryable: isTransientError,
            onRetry: (a, e) => this.logger.warn(`Retry ${method} #${a}: ${e.message}`),
          })
        : attempt();
    });
  }

  // ─── Pemilihan versi API ─────────────────────────────────────────────────

  /**
   * Tentukan protokol private API yang berlaku untuk kunci yang terpasang.
   *
   * Probe-nya dijalankan di bawah satu promise bersama sehingga beberapa
   * panggilan private yang datang bersamaan saat startup tidak memicu beberapa
   * probe sekaligus.
   *
   * Hasil yang pasti diingat selamanya. Hasil yang hanya dugaan — karena IP
   * pemanggil ditolak, sehingga kedua protokol tidak bisa diuji sama sekali —
   * dicoba ulang setelah masa tenang. Tanpa itu, satu probe sial saat startup
   * akan mengunci diagnosis yang salah selama proses hidup.
   */
  private async resolveApiVersion(): Promise<'v1' | 'v2'> {
    if (this.apiVersion !== 'unknown') {
      const stale =
        this.versionTentativeSince > 0 &&
        Date.now() - this.versionTentativeSince > IndodaxService.VERSION_REPROBE_MS;
      if (!stale) return this.apiVersion;
    }

    const configured = this.config.get<string>('INDODAX_API_VERSION', 'auto').toLowerCase();
    if (configured === 'v1' || configured === 'v2') {
      this.apiVersion = configured;
      this.versionTentativeSince = 0;
      this.logger.log(`Protokol private API dipaksa ke ${configured.toUpperCase()} lewat konfigurasi`);
      return this.apiVersion;
    }

    if (this.versionProbe) return this.versionProbe;

    this.versionProbe = (async () => {
      try {
        const probe = await this.v2.probe();
        if (probe.ok) {
          const recovered = this.versionTentativeSince > 0;
          this.apiVersion = 'v2';
          this.versionTentativeSince = 0;
          this.logger.log(
            `Private API: TAPIv2 (api.indodax.com/api/v2)` +
              (recovered ? ' — IP sudah diterima' : '') +
              (probe.reason ? ` — ${probe.reason}` : ''),
          );
          return 'v2' as const;
        }

        // IP ditolak berarti kuncinya belum diuji sama sekali. Mencoba TAPI
        // lama tidak ada gunanya: ia keluar dari IP yang sama dan akan ditolak
        // dengan sebab yang sama, lalu melaporkan dua galat yang menutupi satu
        // penyebab tunggal.
        if (probe.ipRejected) {
          this.apiVersion = 'v2';
          this.versionTentativeSince = Date.now();
          this.logger.error(
            `IP mesin ini tidak ada di whitelist API Indodax — kunci TIDAK ditolak, ` +
              `jadi tidak perlu diganti.
` +
              `Buka indodax.com/account/settings/api dan sesuaikan IP Permission, ` +
              `atau kosongkan agar menerima IP mana pun.
` +
              `Bila IP publik Anda berpindah-pindah (ISP memakai beberapa jalur keluar), ` +
              `whitelist satu IP akan berhasil-gagal bergantian — daftarkan semuanya ` +
              `atau jalankan bot di server dengan IP tetap.
` +
              `Protokol sementara dipakai: TAPIv2; deteksi diulang otomatis setelah ` +
              `${IndodaxService.VERSION_REPROBE_MS / 1000} detik.`,
          );
          return 'v2' as const;
        }

        // Kunci ditolak v2 dengan sebab lain. Bila memang beda versi, TAPI lama
        // mestinya menerimanya; bila bukan, galat aslinya dilaporkan apa adanya.
        this.logger.warn(
          `TAPIv2 menolak kunci ini (${probe.code ?? '?'}: ${probe.reason}) — mencoba TAPI lama`,
        );
        try {
          await this.callLegacyApi('getInfo', {}, 1);
          this.apiVersion = 'v1';
          this.versionTentativeSince = 0;
          this.logger.log('Private API: TAPI lama (indodax.com/tapi)');
          return 'v1' as const;
        } catch (legacyErr) {
          this.logger.error(
            `Kedua protokol menolak kunci ini.
` +
              `  TAPIv2     : ${probe.reason}
` +
              `  TAPI lama  : ${legacyErr.message}
` +
              `Periksa di indodax.com/account/settings/api: izin View + Spot Trading aktif, ` +
              `IP whitelist cocok dengan IP publik mesin ini, dan tombol "Active Trade API" sudah ditekan.`,
          );
          // Tetap pilih v2 sebagai default: itu protokol yang berlaku sekarang,
          // sehingga pesan galat berikutnya datang dari API yang relevan.
          this.apiVersion = 'v2';
          this.versionTentativeSince = 0;
          return 'v2' as const;
        }
      } finally {
        this.versionProbe = null;
      }
    })();

    return this.versionProbe;
  }

  /** Versi protokol yang sedang dipakai; untuk health check dan dashboard. */
  getApiVersion(): string {
    return this.apiVersion;
  }

  getClockOffsetMs(): number {
    return this.v2.getClockOffsetMs();
  }

  async getBalance(): Promise<Balance> {
    if ((await this.resolveApiVersion()) === 'v2') {
      const acct = await this.v2.getAccount();
      return acct.available as Balance;
    }
    const data = await this.callLegacyApi('getInfo', {}, 2);
    return this.parseBalance(data.balance);
  }

  /** Saldo tersedia beserta dana yang tertahan di open order. */
  async getBalanceWithHold(): Promise<{ available: Balance; hold: Balance }> {
    if ((await this.resolveApiVersion()) === 'v2') {
      const acct = await this.v2.getAccount();
      return { available: acct.available as Balance, hold: acct.locked as Balance };
    }
    const data = await this.callLegacyApi('getInfo', {}, 2);
    return {
      available: this.parseBalance(data.balance),
      hold: this.parseBalance(data.balance_hold),
    };
  }

  private parseBalance(src: any): Balance {
    const out: Balance = { idr: parseFloat(src?.idr || '0') };
    for (const [coin, val] of Object.entries(src || {})) {
      if (coin !== 'idr') out[coin] = parseFloat(val as string);
    }
    return out;
  }

  // ─── Order Placement ─────────────────────────────────────────────────────

  /**
   * Pasang order BELI senilai `idrAmount` pada harga `price`.
   * Harga dibulatkan ke tick pair dan divalidasi terhadap minimum exchange
   * sebelum dikirim.
   */
  async placeBuyOrder(pair: string, idrAmount: number, price: number): Promise<OrderResult> {
    const key = pair.toLowerCase();

    let normPrice: number;
    let normQty: number;
    let effectiveIdr: number;
    try {
      normPrice = this.pairs.normalizePrice(key, price);

      /**
       * Kuantitas dibulatkan LEBIH DULU, lalu divalidasi.
       *
       * Urutan ini penting dan sebelumnya terbalik: validasi berjalan pada
       * kuantitas mentah, baru setelah lolos kuantitasnya dipotong ke presisi
       * pair. Pemotongan itu bisa menjatuhkan nilainya di bawah minimum, dan
       * order yang sudah dinyatakan sah lalu ditolak exchange.
       *
       * MUBARAKIDR (presisi 0, harga 1372, minimum Rp10.000):
       *   anggaran Rp10.100 -> qty 7,3615 -> dipotong jadi 7 -> Rp9.604
       *   validasi lama: LOLOS. Indodax: DITOLAK.
       *
       * Nilai IDR yang divalidasi juga diturunkan dari kuantitas yang sudah
       * dibulatkan, bukan dari anggaran asli — itulah nilai order sebenarnya.
       */
      normQty = this.pairs.normalizeCoinAmount(key, idrAmount / normPrice);
      effectiveIdr = normQty * normPrice;

      const check = this.pairs.validateOrder(key, 'buy', normPrice, effectiveIdr, normQty);
      if (!check.ok) return { success: false, error: check.reason };
    } catch (err) {
      return { success: false, error: err.message };
    }

    if (!this.isLive) {
      this.logger.log(
        `[SIMULASI] BUY ${key} @ ${normPrice} — ${Math.round(effectiveIdr)} IDR (${normQty})`,
      );
      return { success: true, orderId: `SIM-${Date.now()}`, data: { simulated: true } };
    }

    try {
      if ((await this.resolveApiVersion()) === 'v2') {
        // TAPIv2 selalu meminta kuantitas aset dasar, bukan nilai IDR.
        // Kuantitas sudah dibulatkan dan divalidasi di atas; dipakai apa adanya.
        const order = await this.v2.placeLimitOrder(
          key,
          'BUY',
          this.pairs.formatPrice(key, normPrice),
          this.pairs.formatCoinAmount(key, normQty),
        );
        return { success: true, orderId: order.orderId, data: order.raw };
      }

      const data = await this.callLegacyApi('trade', {
        pair: key,
        type: 'buy',
        price: this.pairs.formatPrice(key, normPrice),
        // Diturunkan dari kuantitas yang sudah dibulatkan agar jalur lama dan
        // v2 memesan jumlah yang sama.
        idr: String(Math.floor(effectiveIdr)),
      });
      return { success: true, orderId: String(data.order_id), data };
    } catch (err) {
      this.logger.error(`Order BUY gagal (${key}): ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Pasang order JUAL sebanyak `coinAmount` koin pada harga `price`. */
  async placeSellOrder(pair: string, coinAmount: number, price: number): Promise<OrderResult> {
    const key = pair.toLowerCase();

    let info: PairInfo;
    let normPrice: number;
    let normCoin: number;
    try {
      info = this.pairs.require(key);
      normPrice = this.pairs.normalizePrice(key, price);
      normCoin = this.pairs.normalizeCoinAmount(key, coinAmount);
      const check = this.pairs.validateOrder(key, 'sell', normPrice, normCoin * normPrice, normCoin);
      if (!check.ok) return { success: false, error: check.reason };
    } catch (err) {
      return { success: false, error: err.message };
    }

    if (!this.isLive) {
      this.logger.log(`[SIMULASI] SELL ${key} @ ${normPrice} — ${normCoin} ${info.tradedCurrency}`);
      return { success: true, orderId: `SIM-${Date.now()}`, data: { simulated: true } };
    }

    try {
      if ((await this.resolveApiVersion()) === 'v2') {
        const order = await this.v2.placeLimitOrder(
          key,
          'SELL',
          this.pairs.formatPrice(key, normPrice),
          this.pairs.formatCoinAmount(key, normCoin),
        );
        return { success: true, orderId: order.orderId, data: order.raw };
      }

      const data = await this.callLegacyApi('trade', {
        pair: key,
        type: 'sell',
        price: this.pairs.formatPrice(key, normPrice),
        [info.tradedCurrency]: this.pairs.formatCoinAmount(key, normCoin),
      });
      return { success: true, orderId: String(data.order_id), data };
    } catch (err) {
      this.logger.error(`Order SELL gagal (${key}): ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async cancelOrder(pair: string, orderId: string, type: 'buy' | 'sell'): Promise<boolean> {
    if (!this.isLive || orderId.startsWith('SIM-')) return true;
    try {
      if ((await this.resolveApiVersion()) === 'v2') {
        await this.v2.cancelOrder(pair, orderId);
        return true;
      }
      await this.callLegacyApi('cancelOrder', { pair: pair.toLowerCase(), order_id: orderId, type });
      return true;
    } catch (err) {
      // Order yang sudah terisi penuh tidak bisa dibatalkan — itu bukan kegagalan.
      if (/not found|already|invalid order/i.test(err.message)) {
        this.logger.warn(`Cancel ${orderId} diabaikan: ${err.message}`);
        return true;
      }
      this.logger.error(`Cancel order gagal: ${err.message}`);
      return false;
    }
  }

  // ─── Rekonsiliasi Fill ───────────────────────────────────────────────────

  /**
   * Baca status order sesungguhnya dari exchange.
   *
   * Ini sumber kebenaran untuk harga entry dan kuantitas. Versi lama
   * mengasumsikan setiap limit order langsung terisi penuh pada harga sinyal,
   * padahal order bisa tidak terisi, terisi sebagian, atau terisi di harga lain.
   */
  async getOrderFill(pair: string, orderId: string, side: 'buy' | 'sell'): Promise<OrderFill> {
    const key = pair.toLowerCase();
    const info = this.pairs.require(key);
    const coin = info.tradedCurrency;

    if (!this.isLive || orderId.startsWith('SIM-')) {
      return { orderId, status: 'unknown', filledCoin: 0, filledIdr: 0, avgPrice: 0, feeIdr: 0 };
    }

    if ((await this.resolveApiVersion()) === 'v2') {
      const order = await this.v2.getOrder(key, orderId);

      // TAPIv2 melaporkan executedQty dalam aset dasar; nilai IDR-nya dihitung
      // dari harga limit order. Untuk limit order harga itu memang harga
      // eksekusinya, jadi tidak ada taksiran yang disembunyikan di sini.
      const filledCoin = order.executedQty;
      const filledIdr = filledCoin * order.price;

      let status: OrderFill['status'];
      if (order.status === 'FILLED') status = 'filled';
      else if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') status = 'open';
      else if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(order.status)) status = 'cancelled';
      else status = 'unknown';

      return {
        orderId,
        status,
        filledCoin,
        filledIdr,
        avgPrice: filledCoin > 0 ? order.price : 0,
        feeIdr: filledIdr * (info.takerFeePercent / 100),
        raw: order.raw,
      };
    }

    const data = await this.callLegacyApi('getOrder', { pair: key, order_id: orderId }, 2);
    const o = data.order || data;

    const price = parseFloat(o.price || '0');
    const rawStatus = String(o.status ?? '').toLowerCase();

    // Indodax: order_* = nilai order awal, remain_* = sisa yang belum terisi.
    let filledIdr: number;
    let filledCoin: number;

    if (side === 'buy') {
      const orderIdr = parseFloat(o.order_idr ?? '0');
      const remainIdr = parseFloat(o.remain_idr ?? '0');
      filledIdr = Math.max(0, orderIdr - remainIdr);
      filledCoin = price > 0 ? filledIdr / price : 0;
    } else {
      const orderCoin = parseFloat(o[`order_${coin}`] ?? '0');
      const remainCoin = parseFloat(o[`remain_${coin}`] ?? '0');
      filledCoin = Math.max(0, orderCoin - remainCoin);
      filledIdr = filledCoin * price;
    }

    let status: OrderFill['status'];
    if (rawStatus === 'cancelled' || rawStatus === 'canceled') status = 'cancelled';
    else if (rawStatus === 'filled' || rawStatus === '1') status = 'filled';
    else if (rawStatus === 'open' || rawStatus === '0') status = 'open';
    else status = 'unknown';

    return {
      orderId,
      status,
      filledCoin,
      filledIdr,
      avgPrice: filledCoin > 0 ? filledIdr / filledCoin : 0,
      // Indodax memotong fee dari sisi yang diterima; getOrder tidak
      // memaparkannya, jadi diestimasi dari tarif taker pair.
      feeIdr: filledIdr * (info.takerFeePercent / 100),
      raw: o,
    };
  }

  async getOpenOrders(pair?: string): Promise<any[]> {
    if ((await this.resolveApiVersion()) === 'v2') {
      const orders = await this.v2.getOpenOrders(pair);
      return orders.map((o) => ({
        order_id: o.orderId,
        pair: o.symbol.toLowerCase(),
        type: o.side.toLowerCase(),
        price: o.price,
        status: o.status,
        raw: o.raw,
      }));
    }

    const params = pair ? { pair: pair.toLowerCase() } : {};
    const data = await this.callLegacyApi('openOrders', params, 2);
    if (Array.isArray(data.orders)) return data.orders;
    // Tanpa parameter pair, Indodax mengembalikan objek ter-key per pair.
    return Object.values(data.orders || {}).flat() as any[];
  }

  async getOrderHistory(pair: string): Promise<any[]> {
    const data = await this.callLegacyApi('orderHistory', { pair: pair.toLowerCase() }, 2);
    return data.orders || [];
  }

  async getTradeHistory(pair: string): Promise<any[]> {
    const data = await this.callLegacyApi('tradeHistory', { pair: pair.toLowerCase() }, 2);
    return data.trades || [];
  }
}
