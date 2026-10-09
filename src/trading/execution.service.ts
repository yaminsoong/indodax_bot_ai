import { Injectable, Logger } from '@nestjs/common';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { BotConfigService } from '../config/bot-config.service';
import { AuditService } from '../database/audit.service';
import { sleep } from '../common/rate-limiter';
import { clamp } from '../common/num';

/**
 * MAKER = pasang limit pasif di sisi kita sendiri; fee lebih murah, tapi order
 *         bisa tidak terisi bila harga tidak datang menghampiri.
 * TAKER = seberangi spread; pasti terisi, fee dua kali lipat.
 */
export type ExecutionStyle = 'MAKER' | 'TAKER';

export interface ExecutionRequest {
  pair: string;
  side: 'buy' | 'sell';
  /** Untuk beli: nilai IDR. Untuk jual: jumlah koin. */
  amount: number;
  /** Harga referensi (harga sinyal / harga pasar terakhir). */
  referencePrice: number;
  /** Order darurat (stop loss) memakai harga lebih agresif agar pasti terisi. */
  urgent?: boolean;
  /** Default TAKER. Stop loss selalu dipaksa TAKER apa pun nilainya. */
  style?: ExecutionStyle;
}

export interface ExecutionOutcome {
  success: boolean;
  orderId?: string;
  /** Kuantitas koin yang benar-benar tereksekusi. */
  filledCoin: number;
  /** Nilai IDR yang benar-benar tereksekusi (bruto, sebelum fee). */
  filledIdr: number;
  avgPrice: number;
  feeIdr: number;
  /** True bila order hanya terisi sebagian dan sisanya dibatalkan. */
  partial: boolean;
  error?: string;
  /** Selisih harga eksekusi terhadap harga referensi, dalam persen. */
  slippagePercent: number;
  /** Gaya yang benar-benar dipakai — menentukan tarif fee yang dibebankan. */
  style: ExecutionStyle;
  /** True bila order maker kedaluwarsa tanpa terisi (bukan kegagalan, sekadar dilewat). */
  missed?: boolean;
}

/**
 * Penempatan order beserta konfirmasi fill.
 *
 * Versi lama menganggap setiap limit order langsung terisi penuh pada harga
 * sinyal, lalu mencatatnya sebagai posisi terbuka. Padahal order bisa tidak
 * terisi sama sekali, terisi sebagian, atau terisi pada harga berbeda —
 * membuat isi database menyimpang dari kepemilikan sesungguhnya di exchange.
 *
 * Di sini setiap order di-poll sampai terisi; sisa yang tidak terisi dalam
 * batas waktu akan dibatalkan, dan yang dilaporkan hanyalah bagian yang nyata.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly indodax: IndodaxService,
    private readonly pairs: PairRegistryService,
    private readonly config: BotConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Harga limit yang dipakai untuk mengirim order.
   *
   * TAKER: beli memakai best ask dan jual memakai best bid — sisi berlawanan
   * dari buku order — supaya order langsung bertemu likuiditas. Versi lama
   * memakai harga penutupan candle untuk keduanya, sehingga order stop loss
   * sering menggantung persis saat harga sedang jatuh cepat.
   *
   * MAKER: beli dipasang DI BAWAH best bid dan jual DI ATAS best ask, sehingga
   * order tidak menyeberangi spread dan dikenai tarif maker (0,1% alih-alih
   * 0,2% di Indodax). Imbalannya: order hanya terisi bila harga datang
   * menghampiri, jadi sebagian peluang akan terlewat.
   */
  private async resolveLimitPrice(
    pair: string,
    side: 'buy' | 'sell',
    referencePrice: number,
    urgent: boolean,
    style: ExecutionStyle,
  ): Promise<{ price: number; bestBid: number; bestAsk: number }> {
    const params = this.config.params();
    let bestBid = 0;
    let bestAsk = 0;

    try {
      const ticker = await this.indodax.getTicker(pair);
      bestBid = ticker.buy;
      bestAsk = ticker.sell;
    } catch (err) {
      this.logger.warn(`Order book ${pair} tidak terbaca, memakai harga referensi: ${err.message}`);
    }

    if (style === 'MAKER') {
      const offset = params.makerOffsetPercent / 100;
      const price =
        side === 'buy'
          ? (bestBid > 0 ? bestBid : referencePrice) * (1 - offset)
          : (bestAsk > 0 ? bestAsk : referencePrice) * (1 + offset);
      return { price, bestBid, bestAsk };
    }

    // Bantalan harga: order darurat dibayar lebih mahal demi kepastian eksekusi.
    const bufferPercent = urgent
      ? params.slippageTolerancePercent
      : params.slippageTolerancePercent / 2;

    const price =
      side === 'buy'
        ? (bestAsk > 0 ? bestAsk : referencePrice) * (1 + bufferPercent / 100)
        : (bestBid > 0 ? bestBid : referencePrice) * (1 - bufferPercent / 100);

    return { price, bestBid, bestAsk };
  }

  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    const started = Date.now();
    const { pair, side, amount, referencePrice, urgent = false } = req;

    // Order darurat (stop loss) tidak pernah dipasang pasif: kepastian eksekusi
    // jauh lebih berharga daripada selisih 0,1% fee.
    const style: ExecutionStyle = urgent ? 'TAKER' : (req.style ?? 'TAKER');

    const fail = (error: string, missed = false): ExecutionOutcome => ({
      success: false,
      filledCoin: 0,
      filledIdr: 0,
      avgPrice: 0,
      feeIdr: 0,
      partial: false,
      slippagePercent: 0,
      style,
      missed,
      error,
    });

    let limitPrice: number;
    let bestBid = 0;
    let bestAsk = 0;
    try {
      const resolved = await this.resolveLimitPrice(pair, side, referencePrice, urgent, style);
      limitPrice = resolved.price;
      bestBid = resolved.bestBid;
      bestAsk = resolved.bestAsk;
    } catch (err) {
      return fail(`Gagal menentukan harga limit: ${err.message}`);
    }

    // Lindungi dari harga referensi yang sudah basi.
    const deviation = Math.abs((limitPrice - referencePrice) / referencePrice) * 100;
    const maxDeviation = Math.max(this.config.params().slippageTolerancePercent * 3, 2);
    if (deviation > maxDeviation) {
      return fail(
        `Harga bergerak ${deviation.toFixed(2)}% dari referensi (batas ${maxDeviation.toFixed(2)}%) - order dibatalkan`,
      );
    }

    // ── Kirim order ──────────────────────────────────────────────────────
    const placement =
      side === 'buy'
        ? await this.indodax.placeBuyOrder(pair, amount, limitPrice)
        : await this.indodax.placeSellOrder(pair, amount, limitPrice);

    if (!placement.success || !placement.orderId) {
      await this.audit.log({
        category: 'ORDER',
        event: `${side.toUpperCase()}_PLACE_FAILED`,
        pair,
        message: placement.error,
        data: { amount, limitPrice, referencePrice },
        durationMs: Date.now() - started,
        isError: true,
      });
      return fail(placement.error || 'Order ditolak exchange');
    }

    const orderId = placement.orderId;

    await this.audit.log({
      category: 'ORDER',
      event: `${side.toUpperCase()}_PLACED`,
      pair,
      message: `Order ${orderId} dikirim (${style})`,
      data: { amount, limitPrice, referencePrice, bestBid, bestAsk, style },
      durationMs: Date.now() - started,
    });

    // ── Mode simulasi: modelkan fill secara realistis ────────────────────
    if (!this.config.isLive) {
      return this.simulateFill(pair, side, amount, limitPrice, referencePrice, orderId, style);
    }

    // ── Tunggu & konfirmasi fill ────────────────────────────────────────
    const outcome = await this.waitForFill(pair, orderId, side, referencePrice, style);

    await this.audit.log({
      category: 'ORDER',
      event: `${side.toUpperCase()}_${outcome.success ? (outcome.partial ? 'PARTIAL' : 'FILLED') : outcome.missed ? 'MISSED' : 'UNFILLED'}`,
      pair,
      message: outcome.error,
      data: {
        orderId,
        style,
        filledCoin: outcome.filledCoin,
        filledIdr: outcome.filledIdr,
        avgPrice: outcome.avgPrice,
        slippagePercent: outcome.slippagePercent,
      },
      durationMs: Date.now() - started,
      // Order maker yang tidak terisi adalah hasil normal, bukan error.
      isError: !outcome.success && !outcome.missed,
    });

    return outcome;
  }

  /**
   * Poll status order sampai terisi atau melewati batas waktu.
   * Sisa yang belum terisi dibatalkan agar dana tidak tertahan.
   */
  private async waitForFill(
    pair: string,
    orderId: string,
    side: 'buy' | 'sell',
    referencePrice: number,
    style: ExecutionStyle,
  ): Promise<ExecutionOutcome> {
    const params = this.config.params();
    // Order maker diberi waktu lebih panjang: ia memang menunggu harga datang.
    const timeoutSeconds =
      style === 'MAKER' ? params.makerFillTimeoutSeconds : params.orderFillTimeoutSeconds;
    const timeoutMs = timeoutSeconds * 1000;
    const deadline = Date.now() + timeoutMs;
    let pollInterval = 1500;
    let lastFill: Awaited<ReturnType<IndodaxService['getOrderFill']>> | null = null;

    while (Date.now() < deadline) {
      await sleep(pollInterval);
      // Renggangkan interval secara bertahap agar tidak menghabiskan rate limit.
      pollInterval = Math.min(pollInterval * 1.4, 8000);

      try {
        lastFill = await this.indodax.getOrderFill(pair, orderId, side);
      } catch (err) {
        this.logger.warn(`Cek status order ${orderId} gagal: ${err.message}`);
        continue;
      }

      if (lastFill.status === 'filled') {
        return this.toOutcome(pair, orderId, lastFill, referencePrice, false, style);
      }
      if (lastFill.status === 'cancelled') {
        const partial = lastFill.filledCoin > 0;
        return partial
          ? this.toOutcome(pair, orderId, lastFill, referencePrice, true, style)
          : {
              success: false,
              orderId,
              filledCoin: 0,
              filledIdr: 0,
              avgPrice: 0,
              feeIdr: 0,
              partial: false,
              slippagePercent: 0,
              style,
              error: 'Order dibatalkan sebelum terisi',
            };
      }
    }

    // Batas waktu tercapai — batalkan sisa dan pakai bagian yang sudah terisi.
    this.logger.warn(`Order ${orderId} (${pair}) belum penuh setelah timeout, membatalkan sisa`);
    await this.indodax.cancelOrder(pair, orderId, side);

    // Baca ulang setelah cancel: sebagian bisa terisi tepat sebelum pembatalan.
    try {
      lastFill = await this.indodax.getOrderFill(pair, orderId, side);
    } catch (err) {
      this.logger.error(`Gagal membaca fill akhir order ${orderId}: ${err.message}`);
    }

    if (lastFill && lastFill.filledCoin > 0) {
      return this.toOutcome(pair, orderId, lastFill, referencePrice, true, style);
    }

    return {
      success: false,
      orderId,
      filledCoin: 0,
      filledIdr: 0,
      avgPrice: 0,
      feeIdr: 0,
      partial: false,
      slippagePercent: 0,
      style,
      // Order maker yang lewat batas waktu bukan kegagalan: harga tidak datang,
      // peluang dilewatkan, dan tidak ada biaya yang timbul.
      missed: style === 'MAKER',
      error:
        style === 'MAKER'
          ? `Order maker tidak terisi dalam ${timeoutSeconds} detik - peluang dilewat`
          : `Order tidak terisi dalam ${timeoutSeconds} detik`,
    };
  }

  private toOutcome(
    pair: string,
    orderId: string,
    fill: Awaited<ReturnType<IndodaxService['getOrderFill']>>,
    referencePrice: number,
    partial: boolean,
    style: ExecutionStyle,
  ): ExecutionOutcome {
    // getOrderFill mengestimasi fee dengan tarif taker; koreksi bila order ini
    // sebenarnya terisi sebagai maker (tarifnya separuh).
    const feeIdr =
      style === 'MAKER' ? fill.filledIdr * this.pairs.makerFeeRate(pair) : fill.feeIdr;

    return {
      success: fill.filledCoin > 0,
      orderId,
      filledCoin: fill.filledCoin,
      filledIdr: fill.filledIdr,
      avgPrice: fill.avgPrice,
      feeIdr,
      partial,
      style,
      slippagePercent:
        referencePrice > 0 && fill.avgPrice > 0
          ? ((fill.avgPrice - referencePrice) / referencePrice) * 100
          : 0,
    };
  }

  /**
   * Fill simulasi yang memodelkan biaya nyata.
   *
   * Simulasi lama mengisi order sempurna pada harga sinyal tanpa fee maupun
   * spread, sehingga hasil paper trading selalu jauh lebih baik daripada hasil
   * sesungguhnya. Di sini fee dan slippage ikut dibebankan.
   *
   * Order MAKER dimodelkan berbeda dan lebih keras: ia hanya terisi bila harga
   * benar-benar datang ke level kita. Mengasumsikan order pasif selalu terisi
   * adalah kesalahan paling umum saat menghitung untung dari fee maker — ia
   * memberi diskon fee sekaligus eksekusi sempurna, dua hal yang di dunia nyata
   * saling meniadakan.
   */
  private async simulateFill(
    pair: string,
    side: 'buy' | 'sell',
    amount: number,
    limitPrice: number,
    referencePrice: number,
    orderId: string,
    style: ExecutionStyle,
  ): Promise<ExecutionOutcome> {
    const feeRate = this.pairs.feeRate(pair, style === 'MAKER');

    let spreadPercent = 0.1;
    try {
      const ticker = await this.indodax.getTicker(pair);
      spreadPercent = clamp(ticker.spreadPercent, 0, 2);
    } catch {
      /* pakai default */
    }

    if (style === 'MAKER') {
      // Peluang order pasif tersentuh dalam satu batas waktu. Nilai konservatif:
      // makin jauh order dipasang dari harga pasar, makin kecil kemungkinannya.
      const offsetPercent = this.config.params().makerOffsetPercent;
      const fillProbability = clamp(0.65 - offsetPercent * 2, 0.15, 0.85);

      if (Math.random() > fillProbability) {
        return {
          success: false,
          orderId,
          filledCoin: 0,
          filledIdr: 0,
          avgPrice: 0,
          feeIdr: 0,
          partial: false,
          slippagePercent: 0,
          style,
          missed: true,
          error: '[SIMULASI] Order maker tidak tersentuh harga - peluang dilewat',
        };
      }

      // Bila terisi, terisi tepat di harga limit kita — tanpa slippage.
      const filledCoin = side === 'buy' ? amount / limitPrice : amount;
      const filledIdr = filledCoin * limitPrice;
      return {
        success: true,
        orderId,
        filledCoin,
        filledIdr,
        avgPrice: limitPrice,
        feeIdr: filledIdr * feeRate,
        partial: false,
        slippagePercent:
          referencePrice > 0 ? ((limitPrice - referencePrice) / referencePrice) * 100 : 0,
        style,
      };
    }

    // TAKER: pasti terisi, tetapi membayar separuh spread ditambah sedikit derau.
    const slipPercent = spreadPercent / 2 + Math.random() * 0.05;
    const execPrice =
      side === 'buy' ? limitPrice * (1 + slipPercent / 100) : limitPrice * (1 - slipPercent / 100);

    const filledCoin = side === 'buy' ? amount / execPrice : amount;
    const filledIdr = filledCoin * execPrice;

    return {
      success: true,
      orderId,
      filledCoin,
      filledIdr,
      avgPrice: execPrice,
      feeIdr: filledIdr * feeRate,
      partial: false,
      slippagePercent:
        referencePrice > 0 ? ((execPrice - referencePrice) / referencePrice) * 100 : 0,
      style,
    };
  }
}
