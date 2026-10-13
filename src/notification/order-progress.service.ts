import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { fmtPrice, idr } from '../common/num';

export type OrderPhase =
  | 'MEMERIKSA_RISIKO'
  | 'MENGHITUNG_UKURAN'
  | 'MENGIRIM_ORDER'
  | 'MENUNGGU_TERISI'
  | 'TERISI_SEBAGIAN'
  | 'TERISI'
  | 'DIBATALKAN'
  | 'TIDAK_TERISI'
  | 'DITOLAK';

export interface OrderProgressState {
  pair: string;
  phase: OrderPhase;
  /** Harga acuan saat tombol ditekan. */
  referencePrice?: number;
  orderId?: string;
  positionSizeIdr?: number;
  riskIdr?: number;
  stopLossPrice?: number;
  takeProfits?: Array<{ level: number; price: number; closePercent: number }>;
  /** Fraksi terisi, 0-1. */
  filledFraction?: number;
  avgFillPrice?: number;
  /** Detik tersisa sebelum timeout order. */
  secondsLeft?: number;
  detail?: string;
}

/** Urutan tahap yang ditampilkan sebagai jejak langkah. */
const STEPS: Array<{ phase: OrderPhase; label: string }> = [
  { phase: 'MEMERIKSA_RISIKO', label: 'Memeriksa risiko' },
  { phase: 'MENGHITUNG_UKURAN', label: 'Menghitung ukuran' },
  { phase: 'MENGIRIM_ORDER', label: 'Mengirim ke Indodax' },
  { phase: 'MENUNGGU_TERISI', label: 'Menunggu terisi' },
  { phase: 'TERISI', label: 'Selesai' },
];

const TERMINAL: OrderPhase[] = ['TERISI', 'DIBATALKAN', 'TIDAK_TERISI', 'DITOLAK'];

/**
 * Laporan hidup satu order: satu pesan Telegram yang terus diperbarui.
 *
 * Sebelum ini, menekan CONFIRM menghasilkan satu pesan di akhir — dan
 * selebihnya diam. Pada order taker diamnya 90 detik, pada maker sampai 5
 * menit. Operator tidak bisa membedakan "sedang menunggu" dari "macet", dan
 * ketika akhirnya muncul pesan gagal, tidak ada jejak apa pun tentang apa yang
 * sudah terjadi.
 *
 * Satu pesan yang BERUBAH dipilih alih-alih beberapa pesan terpisah: progres
 * mengirim teks yang mirip berulang kali, dan lima pesan beruntun akan
 * membanjiri percakapan sampai riwayat yang berguna tergeser.
 */
@Injectable()
export class OrderProgressService {
  private readonly logger = new Logger(OrderProgressService.name);

  constructor(private readonly notification: NotificationService) {}

  /** Mulai laporan; kembalikan id pesan untuk diperbarui, atau null. */
  async start(state: OrderProgressState): Promise<number | null> {
    return this.notification.sendTrackable(this.render(state));
  }

  /** Perbarui laporan yang sudah ada. */
  async update(messageId: number | null, state: OrderProgressState): Promise<void> {
    if (!messageId) return;
    await this.notification.updateMessage(messageId, this.render(state));
  }

  /**
   * Susun teks laporan.
   *
   * Dipisah dari pengiriman agar bisa diuji tanpa jaringan — dan karena inilah
   * bagian yang benar-benar menentukan apakah operator paham keadaannya.
   */
  render(state: OrderProgressState): string {
    const lines = [this.header(state), ''];

    // Jejak langkah: terlihat jelas sudah sampai mana, bukan hanya status akhir.
    const activeIndex = STEPS.findIndex((s) => s.phase === state.phase);
    const done = TERMINAL.includes(state.phase);

    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i];
      let icon = '○';

      if (state.phase === 'TERISI') {
        icon = '●';
      } else if (state.phase === 'TERISI_SEBAGIAN') {
        icon = i < 3 ? '●' : i === 3 ? '◐' : '○';
      } else if (done) {
        // Gagal di tengah: langkah sebelum titik gagal tetap tercapai.
        icon = i < 3 ? '●' : i === 3 ? '✕' : '○';
      } else if (activeIndex >= 0) {
        icon = i < activeIndex ? '●' : i === activeIndex ? '◐' : '○';
      }

      const label =
        i === 3 && state.phase === 'MENUNGGU_TERISI' && state.secondsLeft !== undefined
          ? `${step.label} (${state.secondsLeft}s lagi)`
          : step.label;

      lines.push(`${icon} ${label}`);
    }

    const plan = this.planBlock(state);
    if (plan.length) lines.push('', ...plan);

    const note = this.note(state);
    if (note.length) lines.push('', ...note);

    return lines.join('\n');
  }

  private header(state: OrderProgressState): string {
    const p = state.pair.toUpperCase();
    switch (state.phase) {
      case 'TERISI':
        return `✅ *${p} — POSISI TERBUKA*`;
      case 'TERISI_SEBAGIAN':
        return `◐ *${p} — TERISI SEBAGIAN*`;
      case 'TIDAK_TERISI':
        return `⏳ *${p} — TIDAK TERISI*`;
      case 'DIBATALKAN':
        return `⏹ *${p} — DIBATALKAN*`;
      case 'DITOLAK':
        return `❌ *${p} — DITOLAK*`;
      default:
        return `🔄 *${p} — SEDANG DIPROSES*`;
    }
  }

  /**
   * Blok angka, ditampilkan bila ADA angka yang sudah diketahui.
   *
   * Syaratnya sengaja bukan "ukuran posisi sudah dihitung": fraksi terisi
   * berguna sendiri, dan menyembunyikannya hanya karena ukuran belum tercatat
   * membuat laporan kehilangan justru informasi yang paling ditunggu.
   */
  private planBlock(state: OrderProgressState): string[] {
    const rows: string[] = [];

    if (state.referencePrice !== undefined) {
      rows.push(`  Harga     Rp ${fmtPrice(state.referencePrice)}`);
    }
    if (state.positionSizeIdr !== undefined) {
      rows.push(`  Beli      ${idr(state.positionSizeIdr)}`);
    }
    if (state.stopLossPrice !== undefined) {
      rows.push(`  Stop loss Rp ${fmtPrice(state.stopLossPrice)}`);
    }
    for (const tp of state.takeProfits ?? []) {
      rows.push(`  TP${tp.level}       Rp ${fmtPrice(tp.price)}  jual ${tp.closePercent}%`);
    }
    if (state.riskIdr !== undefined) {
      rows.push(`  Risiko    ${idr(state.riskIdr)}`);
    }
    if (state.filledFraction !== undefined && state.filledFraction > 0) {
      rows.push(`  Terisi    ${(state.filledFraction * 100).toFixed(0)}%`);
    }
    if (state.avgFillPrice !== undefined) {
      rows.push(`  Harga isi Rp ${fmtPrice(state.avgFillPrice)}`);
    }

    // Tidak ada angka sama sekali: lebih baik tidak menampilkan blok kosong
    // daripada menampilkan kerangka berisi nol.
    return rows.length ? ['```', ...rows, '```'] : [];
  }

  /**
   * Keterangan penutup sesuai tahap.
   *
   * Tiap keadaan dijelaskan beserta KONSEKUENSINYA terhadap uang — itu yang
   * sebenarnya ingin diketahui operator, bukan nama tahapnya.
   */
  private note(state: OrderProgressState): string[] {
    switch (state.phase) {
      case 'MENUNGGU_TERISI':
        return [
          '_Order sudah ada di Indodax. Dana ditahan sementara,_',
          '_belum terpakai. Laporan ini diperbarui sendiri._',
        ];
      case 'TERISI':
        return [
          '_Stop loss dan take profit sudah dipasang._',
          '_Bot memantau posisi ini setiap menit._',
        ];
      case 'TERISI_SEBAGIAN':
        return [
          '_Sebagian terisi dan dilindungi stop loss._',
          '_Sisanya dibatalkan; dananya kembali bebas._',
        ];
      case 'TIDAK_TERISI':
        return [
          '_Tidak ada uang terpakai. Order sudah dibatalkan._',
          '_Harga tidak sampai ke level order, jadi peluangnya lewat._',
        ];
      case 'DITOLAK':
        return state.detail
          ? [`*Sebab:* ${state.detail}`, '', '_Tidak ada uang terpakai._']
          : ['_Tidak ada uang terpakai._'];
      case 'DIBATALKAN':
        return ['_Order dibatalkan. Dana kembali bebas._'];
      default:
        return state.detail ? [`_${state.detail}_`] : [];
    }
  }
}
