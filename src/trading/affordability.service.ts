import { Injectable, Logger } from '@nestjs/common';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { BotConfigService } from '../config/bot-config.service';

export type AffordabilityStatus = 'MAMPU' | 'DANA_KURANG' | 'DI_BAWAH_MINIMUM' | 'TIDAK_DIKETAHUI';

export interface AffordabilityCheck {
  pair: string;
  status: AffordabilityStatus;
  /** Ukuran posisi yang diminta risk engine, sebelum pembatas apa pun. */
  requestedIdr: number;
  /** Ukuran setelah batas porsi ekuitas diterapkan. */
  cappedIdr: number;
  /** Minimum order exchange untuk pair ini. */
  minOrderIdr: number;
  /** Porsi ekuitas yang akan dipakai posisi ini, persen. */
  equitySharePercent: number;
  /** Jarak stop yang dipakai perhitungan, persen. */
  stopPercent: number;
  /** Risiko rupiah bila stop kena. */
  riskIdr: number;
  /** Ekuitas minimum agar pair ini bisa ditradingkan sama sekali. */
  minEquityNeededIdr: number;
  reason: string;
}

/**
 * Menjawab satu pertanyaan yang sebelumnya hanya bisa dijawab dengan mencoba:
 * **dengan saldo sekarang, pair mana yang benar-benar bisa dibeli?**
 *
 * Risk Engine sudah menolak order di bawah minimum, tetapi penolakannya terjadi
 * SETELAH sinyal muncul dan hanya berupa satu baris alasan. Operator bermodal
 * kecil karena itu tidak pernah tahu apakah bot diam karena tidak ada peluang,
 * atau karena tidak satu pun peluang mampu ia beli.
 *
 * Perbedaan itu menentukan tindakan: yang pertama berarti menunggu, yang kedua
 * berarti menambah modal. Lapisan ini membuat keduanya bisa dibedakan sebelum
 * sinyal datang.
 *
 * Perhitungannya memakai rumus yang SAMA dengan Risk Engine supaya angka yang
 * ditampilkan adalah angka yang benar-benar akan dipakai — bukan taksiran
 * terpisah yang bisa menyimpang.
 */
@Injectable()
export class AffordabilityService {
  private readonly logger = new Logger(AffordabilityService.name);

  constructor(
    private readonly pairs: PairRegistryService,
    private readonly config: BotConfigService,
  ) {}

  /**
   * Periksa kelayakan satu pair.
   *
   * `atrPercent` menentukan jarak stop, dan karena itu menentukan ukuran posisi:
   * posisi = jatah risiko / jarak stop. Pair bergejolak tinggi menuntut stop
   * lebar, posisi kecil, dan justru MODAL LEBIH BESAR agar posisinya tetap di
   * atas minimum exchange — kebalikan dari dugaan yang lazim.
   */
  check(pair: string, equityIdr: number, atrPercent: number | null): AffordabilityCheck {
    const params = this.config.params();

    let minOrderIdr = 10_000;
    try {
      minOrderIdr = this.pairs.require(pair).minOrderIdr;
    } catch {
      // Metadata belum termuat; minimum Indodax yang berlaku umum dipakai.
    }

    const base: AffordabilityCheck = {
      pair,
      status: 'TIDAK_DIKETAHUI',
      requestedIdr: 0,
      cappedIdr: 0,
      minOrderIdr,
      equitySharePercent: 0,
      stopPercent: 0,
      riskIdr: 0,
      minEquityNeededIdr: 0,
      reason: '',
    };

    if (!(equityIdr > 0)) {
      return { ...base, reason: 'Ekuitas nol atau tidak terbaca' };
    }

    // Tanpa ATR, jarak stop tidak diketahui dan ukuran posisi tidak bisa
    // dihitung. Dilaporkan sebagai TIDAK DIKETAHUI, bukan ditebak — menebak di
    // sini akan menampilkan angka yang tidak akan pernah dipakai.
    const stopPercent =
      atrPercent && atrPercent > 0
        ? atrPercent * params.atrStopMultiplier
        : params.minStopPercent;

    if (!(stopPercent > 0)) {
      return { ...base, reason: 'Jarak stop tidak dapat dihitung' };
    }

    const riskBudget = equityIdr * (params.riskPerTradePercent / 100);
    const requestedIdr = riskBudget / (stopPercent / 100);
    const capIdr = equityIdr * (params.maxPositionPercent / 100);
    const cappedIdr = Math.min(requestedIdr, capIdr);

    /**
     * Ekuitas minimum agar pair ini dapat ditradingkan.
     *
     * Dua pembatas berlaku bersamaan dan yang lebih ketat menentukan:
     *   - batas porsi : ekuitas x maxPositionPercent >= minOrder
     *   - jatah risiko: ekuitas x risk / stop        >= minOrder
     */
    const fromCap = minOrderIdr / (params.maxPositionPercent / 100);
    const fromRisk = (minOrderIdr * (stopPercent / 100)) / (params.riskPerTradePercent / 100);
    const minEquityNeededIdr = Math.max(fromCap, fromRisk);

    const result: AffordabilityCheck = {
      ...base,
      requestedIdr,
      cappedIdr,
      equitySharePercent: (cappedIdr / equityIdr) * 100,
      stopPercent,
      riskIdr: cappedIdr * (stopPercent / 100),
      minEquityNeededIdr,
    };

    if (cappedIdr < minOrderIdr) {
      return {
        ...result,
        status: 'DI_BAWAH_MINIMUM',
        reason:
          `Posisi yang dihitung Rp${Math.round(cappedIdr).toLocaleString('id-ID')} ` +
          `di bawah minimum Rp${minOrderIdr.toLocaleString('id-ID')}. ` +
          `Butuh ekuitas minimal Rp${Math.round(minEquityNeededIdr).toLocaleString('id-ID')}.`,
      };
    }

    // Fee entry harus ikut tersedia, kalau tidak ordernya ditolak di ujung.
    let feeRate = 0.002;
    try {
      feeRate = this.pairs.takerFeeRate(pair);
    } catch {
      // Pakai fee taker Indodax yang berlaku umum.
    }
    const totalCost = cappedIdr * (1 + feeRate);

    if (totalCost > equityIdr) {
      return {
        ...result,
        status: 'DANA_KURANG',
        reason:
          `Butuh Rp${Math.round(totalCost).toLocaleString('id-ID')} termasuk fee, ` +
          `tersedia Rp${Math.round(equityIdr).toLocaleString('id-ID')}`,
      };
    }

    return {
      ...result,
      status: 'MAMPU',
      reason:
        `Posisi Rp${Math.round(cappedIdr).toLocaleString('id-ID')} ` +
        `(${((cappedIdr / equityIdr) * 100).toFixed(0)}% ekuitas), ` +
        `risiko Rp${Math.round(result.riskIdr).toLocaleString('id-ID')}`,
    };
  }

  /** Periksa beberapa pair sekaligus; yang MAMPU didahulukan. */
  checkMany(
    entries: Array<{ pair: string; atrPercent: number | null }>,
    equityIdr: number,
  ): AffordabilityCheck[] {
    const order: Record<AffordabilityStatus, number> = {
      MAMPU: 0,
      DI_BAWAH_MINIMUM: 1,
      DANA_KURANG: 2,
      TIDAK_DIKETAHUI: 3,
    };

    return entries
      .map((e) => this.check(e.pair, equityIdr, e.atrPercent))
      .sort((a, b) => order[a.status] - order[b.status] || a.minEquityNeededIdr - b.minEquityNeededIdr);
  }
}
