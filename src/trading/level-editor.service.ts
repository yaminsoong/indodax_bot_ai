import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Trade } from '../database/entities/trade.entity';
import { AuditService } from '../database/audit.service';
import { IndodaxService } from '../indodax/indodax.service';
import { fmtPrice, idr } from '../common/num';

export interface LevelEditResult {
  ok: boolean;
  message: string;
  /** Terisi hanya bila perubahan benar-benar tersimpan. */
  before?: { stopLoss: number; takeProfit: number; riskIdr: number };
  after?: { stopLoss: number; takeProfit: number; riskIdr: number };
}

/**
 * Ubah stop loss / take profit pada posisi yang SUDAH TERBUKA.
 *
 * Dipisahkan dari TradingService dengan sengaja: pengeditan level adalah satu
 * tindakan operator yang menyentuh uang berisiko, dan ia butuh pagarnya
 * sendiri. Tiga sifat yang menentukan boleh-tidaknya ini ada:
 *
 * 1. **Nilai mustahil ditolak.** Stop LONG di ATAS harga sekarang akan
 *    langsung tereksekusi pada pemeriksaan monitor berikutnya — itu bukan
 *    "stop ketat", itu perintah jual yang menyamar.
 *
 * 2. **Memperlebar risiko harus DINYATAKAN, bukan dilakukan diam-diam.**
 *    Menurunkan stop terasa seperti "memberi ruang", padahal ia menambah
 *    rupiah yang bisa hilang. Angka lama dan baru ditampilkan berdampingan.
 *
 * 3. **Trailing stop yang sudah lebih ketat tidak boleh dibatalkan tanpa
 *    sadar.** Bot memakai `max(stopLossPrice, trailingStopPrice)`, jadi
 *    menurunkan `stopLossPrice` saja TIDAK melonggarkan apa pun — dan
 *    operator yang tidak diberi tahu akan menyangka sudah melonggarkannya.
 *
 * Setiap perubahan dicatat ke audit beserta nilai sebelum dan sesudah,
 * karena perbedaan antara catatan bot dan kenyataan bursa hanya bisa
 * ditelusuri bila jejaknya ada.
 */
@Injectable()
export class LevelEditorService {
  private readonly logger = new Logger(LevelEditorService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly audit: AuditService,
    private readonly indodax: IndodaxService,
  ) {}

  /** Ubah stop loss. `price` dalam rupiah. */
  async setStopLoss(tradeId: number, price: number): Promise<LevelEditResult> {
    return this.edit(tradeId, { stopLoss: price });
  }

  /** Ubah take profit. `price` dalam rupiah. */
  async setTakeProfit(tradeId: number, price: number): Promise<LevelEditResult> {
    return this.edit(tradeId, { takeProfit: price });
  }

  private async edit(
    tradeId: number,
    change: { stopLoss?: number; takeProfit?: number },
  ): Promise<LevelEditResult> {
    const trade = await this.tradeRepo.findOne({ where: { id: tradeId } });
    if (!trade) return { ok: false, message: `Trade #${tradeId} tidak ditemukan.` };

    if (!['OPEN', 'CLOSING'].includes(trade.status)) {
      return { ok: false, message: `Trade #${tradeId} berstatus ${trade.status}, bukan posisi terbuka.` };
    }

    /**
     * Harga HIDUP, bukan harga entry.
     *
     * Kelayakan sebuah stop ditentukan oleh posisinya terhadap harga
     * SEKARANG. Stop di bawah entry tetapi di atas harga sekarang akan
     * langsung tereksekusi, dan memeriksanya terhadap entry akan
     * meloloskannya.
     */
    let harga: number;
    try {
      harga = (await this.indodax.getTicker(trade.pair)).last;
    } catch (err) {
      return {
        ok: false,
        message:
          `Harga ${trade.pair.toUpperCase()} tidak terbaca (${(err as Error).message}). ` +
          'Level TIDAK diubah — mengubahnya tanpa tahu harga sekarang bisa ' +
          'memasang stop yang langsung tereksekusi.',
      };
    }

    const qty = trade.remainingQuantity || trade.quantity;
    const slLama = trade.stopLossPrice;
    const tpLama = trade.takeProfitPrice;
    const slBaru = change.stopLoss ?? slLama;
    const tpBaru = change.takeProfit ?? tpLama;

    const salah = this.validate(slBaru, tpBaru, harga, change);
    if (salah) return { ok: false, message: salah };

    const riskLama = Math.max(0, (trade.entryPrice - slLama) * qty);
    const riskBaru = Math.max(0, (trade.entryPrice - slBaru) * qty);

    const catatan: string[] = [];

    if (change.stopLoss !== undefined && riskBaru > riskLama) {
      catatan.push(
        `⚠️ Risiko DIPERLEBAR: ${idr(riskLama)} -> ${idr(riskBaru)} ` +
          `(+${idr(riskBaru - riskLama)})`,
      );
    }

    /**
     * Trailing stop yang sudah lebih ketat membuat pengeditan tidak
     * berpengaruh. Harus dikatakan, bukan dibiarkan tampak berhasil.
     */
    const trailing = trade.trailingStopPrice || 0;
    if (change.stopLoss !== undefined && trailing > slBaru) {
      catatan.push(
        `ℹ️ Trailing stop ${fmtPrice(trailing)} masih LEBIH KETAT dari stop baru ` +
          `${fmtPrice(slBaru)}. Bot memakai yang lebih ketat, jadi perubahan ini ` +
          'belum berpengaruh sampai harga turun ke bawah trailing.',
      );
    }

    await this.tradeRepo.update(tradeId, {
      stopLossPrice: slBaru,
      takeProfitPrice: tpBaru,
    });

    await this.audit.log({
      category: 'ORDER',
      event: 'LEVEL_EDITED',
      pair: trade.pair,
      tradeId,
      message:
        `Stop ${fmtPrice(slLama)} -> ${fmtPrice(slBaru)}, ` +
        `TP ${fmtPrice(tpLama)} -> ${fmtPrice(tpBaru)} pada harga ${fmtPrice(harga)}`,
      data: {
        before: { stopLoss: slLama, takeProfit: tpLama, riskIdr: Math.round(riskLama) },
        after: { stopLoss: slBaru, takeProfit: tpBaru, riskIdr: Math.round(riskBaru) },
        marketPrice: harga,
        trailingStopPrice: trailing,
      },
    });

    this.logger.log(
      `Level trade #${tradeId} diubah: stop ${fmtPrice(slLama)}->${fmtPrice(slBaru)}, ` +
        `TP ${fmtPrice(tpLama)}->${fmtPrice(tpBaru)}`,
    );

    return {
      ok: true,
      message: [
        `✅ Level trade #${tradeId} ${trade.pair.toUpperCase()} diubah.`,
        '',
        '```',
        `  harga sekarang  ${fmtPrice(harga)}`,
        `  stop   ${fmtPrice(slLama)} -> ${fmtPrice(slBaru)}`,
        `  TP     ${fmtPrice(tpLama)} -> ${fmtPrice(tpBaru)}`,
        `  risiko ${idr(riskLama)} -> ${idr(riskBaru)}`,
        '```',
        ...catatan,
        '',
        '_Stop tetap DIPANTAU BOT, bukan dipasang di Indodax._',
      ].join('\n'),
      before: { stopLoss: slLama, takeProfit: tpLama, riskIdr: Math.round(riskLama) },
      after: { stopLoss: slBaru, takeProfit: tpBaru, riskIdr: Math.round(riskBaru) },
    };
  }

  /**
   * Tolak nilai yang mustahil.
   *
   * Semua posisi di bot ini LONG — tidak ada jalur short — sehingga aturannya
   * tetap: stop di bawah harga, target di atas harga.
   */
  private validate(
    sl: number,
    tp: number,
    harga: number,
    change: { stopLoss?: number; takeProfit?: number },
  ): string | null {
    if (change.stopLoss !== undefined) {
      if (!(sl > 0)) return 'Stop loss harus lebih besar dari nol.';
      if (sl >= harga) {
        return (
          `Stop ${fmtPrice(sl)} berada DI ATAS harga sekarang ${fmtPrice(harga)}. ` +
          'Itu akan langsung tereksekusi pada pemeriksaan berikutnya — ' +
          'bukan stop, melainkan perintah jual. Pakai tombol tutup posisi ' +
          'bila memang ingin menjual sekarang.'
        );
      }
    }

    if (change.takeProfit !== undefined) {
      if (!(tp > 0)) return 'Take profit harus lebih besar dari nol.';
      if (tp <= harga) {
        return (
          `Target ${fmtPrice(tp)} berada DI BAWAH harga sekarang ${fmtPrice(harga)}. ` +
          'Itu akan langsung tereksekusi — pakai tombol tutup posisi bila ' +
          'memang ingin menjual sekarang.'
        );
      }
    }

    if (sl > 0 && tp > 0 && sl >= tp) {
      return `Stop ${fmtPrice(sl)} tidak boleh berada di atas target ${fmtPrice(tp)}.`;
    }

    return null;
  }
}
