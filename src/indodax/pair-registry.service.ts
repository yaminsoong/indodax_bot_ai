import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { withRetry } from '../common/rate-limiter';
import { floorToStep, roundToStep, toPlainString, decimalsOf } from '../common/num';

export interface PairInfo {
  id: string;
  symbol: string;
  baseCurrency: string;      // 'idr'
  tradedCurrency: string;    // 'btc'
  /** Tick harga — harga order wajib kelipatan ini. */
  priceStep: number;
  /** Maksimum desimal harga yang diterima API. */
  priceDecimals: number;
  /** Minimum nilai order dalam IDR. */
  minOrderIdr: number;
  /** Minimum kuantitas koin untuk order jual. */
  minOrderCoin: number;
  takerFeePercent: number;
  makerFeePercent: number;
  isMaintenance: boolean;
  isSuspended: boolean;
}

/** Desimal kuantitas koin yang diterima Indodax. */
const COIN_DECIMALS = 8;

/**
 * Menyimpan metadata per pair dari GET /api/pairs.
 *
 * Tanpa ini bot mengirim harga yang tidak valid (pair murah dibulatkan jadi 0),
 * kuantitas dengan presisi berlebih, dan order di bawah minimum — semuanya
 * ditolak exchange, atau lebih buruk: diterima dengan harga yang salah.
 */
@Injectable()
export class PairRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PairRegistryService.name);
  private pairs = new Map<string, PairInfo>();
  private lastRefresh = 0;

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.logger.error(`Gagal memuat metadata pair saat startup: ${err.message}`);
    }
  }

  async refresh(): Promise<void> {
    const res = await withRetry(
      () => axios.get('https://indodax.com/api/pairs', { timeout: 15000 }),
      { retries: 3, onRetry: (a, e) => this.logger.warn(`Retry /api/pairs #${a}: ${e.message}`) },
    );

    const next = new Map<string, PairInfo>();
    for (const p of res.data as any[]) {
      const priceStep = Number(p.pricescale) > 0 ? Number(p.pricescale) : 1;
      next.set(String(p.id).toLowerCase(), {
        id: String(p.id).toLowerCase(),
        symbol: String(p.symbol || p.id).toUpperCase(),
        baseCurrency: String(p.base_currency || 'idr').toLowerCase(),
        tradedCurrency: String(p.traded_currency || '').toLowerCase(),
        priceStep,
        priceDecimals: Number.isFinite(Number(p.price_round))
          ? Number(p.price_round)
          : decimalsOf(priceStep),
        minOrderIdr: Number(p.trade_min_base_currency) || 10000,
        minOrderCoin: Number(p.trade_min_traded_currency) || 0,
        takerFeePercent: Number(p.trade_fee_percent_taker ?? p.trade_fee_percent ?? 0.2),
        makerFeePercent: Number(p.trade_fee_percent_maker ?? p.trade_fee_percent ?? 0.2),
        isMaintenance: Number(p.is_maintenance) === 1,
        isSuspended: Number(p.is_market_suspended) === 1,
      });
    }

    this.pairs = next;
    this.lastRefresh = Date.now();
    this.logger.log(`Metadata pair dimuat: ${next.size} pair`);
  }

  /** Segarkan bila cache lebih tua dari `maxAgeMs` (default 6 jam). */
  async refreshIfStale(maxAgeMs = 6 * 60 * 60 * 1000): Promise<void> {
    if (Date.now() - this.lastRefresh > maxAgeMs) {
      await this.refresh().catch((e) => this.logger.warn(`Refresh pair gagal: ${e.message}`));
    }
  }

  get(pair: string): PairInfo | undefined {
    return this.pairs.get(pair.toLowerCase());
  }

  /** Ambil info pair atau lempar error — dipakai di jalur eksekusi order. */
  require(pair: string): PairInfo {
    const info = this.get(pair);
    if (!info) {
      throw new Error(`Pair '${pair}' tidak dikenal di Indodax (cek ejaan di TRADING_PAIRS)`);
    }
    return info;
  }

  has(pair: string): boolean {
    return this.pairs.has(pair.toLowerCase());
  }

  all(): PairInfo[] {
    return [...this.pairs.values()];
  }

  /** Pair layak ditradingkan bila tidak sedang maintenance / suspend. */
  isTradable(pair: string): { ok: boolean; reason?: string } {
    const info = this.get(pair);
    if (!info) return { ok: false, reason: `Pair '${pair}' tidak ada di Indodax` };
    if (info.isMaintenance) return { ok: false, reason: `${pair} sedang maintenance` };
    if (info.isSuspended) return { ok: false, reason: `${pair} sedang di-suspend` };
    return { ok: true };
  }

  // ─── Normalisasi nilai order ───────────────────────────────────────────

  /** Bulatkan harga ke tick pair. */
  normalizePrice(pair: string, price: number): number {
    const info = this.require(pair);
    return roundToStep(price, info.priceStep);
  }

  /** Harga siap kirim ke API sebagai string desimal biasa (bukan notasi eksponen). */
  formatPrice(pair: string, price: number): string {
    const info = this.require(pair);
    return toPlainString(roundToStep(price, info.priceStep), info.priceDecimals);
  }

  /** Kuantitas koin dipotong ke bawah agar tidak pernah melebihi saldo. */
  normalizeCoinAmount(_pair: string, amount: number): number {
    return floorToStep(amount, 10 ** -COIN_DECIMALS);
  }

  formatCoinAmount(pair: string, amount: number): string {
    return toPlainString(this.normalizeCoinAmount(pair, amount), COIN_DECIMALS);
  }

  /** Fee taker dalam pecahan (0.002 = 0.2%) — untuk order yang menyeberangi spread. */
  takerFeeRate(pair: string): number {
    return this.require(pair).takerFeePercent / 100;
  }

  /** Fee maker dalam pecahan (0.001 = 0.1%) — untuk limit pasif yang menunggu terisi. */
  makerFeeRate(pair: string): number {
    return this.require(pair).makerFeePercent / 100;
  }

  /** Fee sesuai gaya eksekusi. */
  feeRate(pair: string, maker: boolean): number {
    return maker ? this.makerFeeRate(pair) : this.takerFeeRate(pair);
  }

  /**
   * Validasi order sebelum dikirim. Mengembalikan alasan penolakan bila tidak valid.
   */
  validateOrder(
    pair: string,
    side: 'buy' | 'sell',
    price: number,
    idrAmount: number,
    coinAmount: number,
  ): { ok: boolean; reason?: string } {
    const info = this.require(pair);

    const tradable = this.isTradable(pair);
    if (!tradable.ok) return tradable;

    const normPrice = this.normalizePrice(pair, price);
    if (!(normPrice > 0)) {
      return { ok: false, reason: `Harga ${price} membulat ke 0 pada tick ${info.priceStep}` };
    }

    if (side === 'buy') {
      if (idrAmount < info.minOrderIdr) {
        return {
          ok: false,
          reason: `Order ${Math.round(idrAmount)} IDR di bawah minimum ${info.minOrderIdr} IDR`,
        };
      }
    } else {
      const normCoin = this.normalizeCoinAmount(pair, coinAmount);
      if (normCoin <= 0) {
        return { ok: false, reason: `Kuantitas ${coinAmount} membulat ke 0 pada ${COIN_DECIMALS} desimal` };
      }
      if (info.minOrderCoin > 0 && normCoin < info.minOrderCoin) {
        return {
          ok: false,
          reason: `Kuantitas ${normCoin} di bawah minimum ${info.minOrderCoin} ${info.tradedCurrency.toUpperCase()}`,
        };
      }
      if (normCoin * normPrice < info.minOrderIdr) {
        return {
          ok: false,
          reason: `Nilai jual ${Math.round(normCoin * normPrice)} IDR di bawah minimum ${info.minOrderIdr} IDR`,
        };
      }
    }

    return { ok: true };
  }
}
