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
  /**
   * Tahap tempat prosesnya benar-benar berhenti.
   *
   * Tanpa ini setiap kegagalan menandai tiga langkah pertama sebagai tercapai,
   * termasuk "Mengirim ke Indodax" - padahal penolakan aturan terjadi sebelum
   * ada order yang dikirim. Kartu yang mengaku sudah mengirim membuat operator
   * mencari masalah di bursa untuk order yang tidak pernah ada di sana.
   */
  failedAtPhase?: OrderPhase;
}

/** Urutan tahap yang ditampilkan sebagai jejak langkah. */
const STEPS: Array<{ phase: OrderPhase; label: string }> = [
  { phase: 'MEMERIKSA_RISIKO', label: 'Memeriksa aman atau tidak' },
  { phase: 'MENGHITUNG_UKURAN', label: 'Menghitung mau beli berapa' },
  { phase: 'MENGIRIM_ORDER', label: 'Mengirim pesanan ke Indodax' },
  { phase: 'MENUNGGU_TERISI', label: 'Menunggu pesanan dieksekusi' },
  { phase: 'TERISI', label: 'Sudah kebeli' },
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
        /**
         * Gagal di tengah: tandai TEPAT di tahap tempat prosesnya berhenti.
         *
         * `failedAtPhase` berasal dari pemanggil, yang tahu apakah ordernya
         * sudah dikirim. Bila tidak diberikan, titik gagal diletakkan di
         * "Menunggu terisi" seperti perilaku lama - tetapi pemanggil pada
         * jalur order selalu memberikannya.
         */
        const failIndex =
          state.failedAtPhase !== undefined
            ? STEPS.findIndex((x) => x.phase === state.failedAtPhase)
            : 3;
        const titik = failIndex >= 0 ? failIndex : 3;
        icon = i < titik ? '●' : i === titik ? '✕' : '○';
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
        return `✅ *${p} — SUDAH KEBELI*`;
      case 'TERISI_SEBAGIAN':
        return `◐ *${p} — KEBELI SEBAGIAN*`;
      case 'TIDAK_TERISI':
        return `⏳ *${p} — TIDAK KEBELI*`;
      case 'DIBATALKAN':
        return `⏹ *${p} — DIBATALKAN*`;
      case 'DITOLAK':
        return `❌ *${p} — TIDAK DIBELI*`;
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

    /**
     * Label menyebut maksudnya, bukan nama bakunya.
     *
     * "Stop loss" dan "Risiko" benar secara istilah tetapi tidak menjawab
     * pertanyaan yang sebenarnya ada di kepala operator: dijual kapan, dan
     * paling banyak kehilangan berapa.
     */
    if (state.referencePrice !== undefined) {
      rows.push(`  Harga saat ini     Rp ${fmtPrice(state.referencePrice)}`);
    }
    if (state.positionSizeIdr !== undefined) {
      rows.push(`  Mau dibelikan      ${idr(state.positionSizeIdr)}`);
    }
    if (state.stopLossPrice !== undefined) {
      rows.push(`  Dijual kalau rugi  Rp ${fmtPrice(state.stopLossPrice)}`);
    }
    for (const tp of state.takeProfits ?? []) {
      rows.push(
        `  Dijual kalau untung Rp ${fmtPrice(tp.price)} (${tp.closePercent}%)`,
      );
    }
    if (state.riskIdr !== undefined) {
      rows.push(`  Paling banyak rugi ${idr(state.riskIdr)}`);
    }
    if (state.filledFraction !== undefined && state.filledFraction > 0) {
      rows.push(`  Sudah kebeli       ${(state.filledFraction * 100).toFixed(0)}%`);
    }
    if (state.avgFillPrice !== undefined) {
      rows.push(`  Kebeli di harga    Rp ${fmtPrice(state.avgFillPrice)}`);
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
          '_Pesanan sudah masuk ke Indodax. Uangnya ditahan_',
          '_sementara, belum benar-benar terpakai._',
          '_Pesan ini berubah sendiri kalau ada perkembangan._',
        ];
      case 'TERISI':
        return [
          '_Batas rugi dan target untung sudah dicatat._',
          '_Bot memeriksa harga koin ini setiap menit._',
        ];
      case 'TERISI_SEBAGIAN':
        return [
          '_Sebagian sudah kebeli dan sudah dijaga batas ruginya._',
          '_Sisanya dibatalkan, uangnya kembali bisa dipakai._',
        ];
      case 'TIDAK_TERISI':
        return [
          '_Tidak ada uang yang terpakai. Pesanan sudah dibatalkan._',
          '_Harganya tidak turun sampai ke harga yang Anda pasang,_',
          '_jadi kesempatannya lewat. Bukan kerusakan._',
        ];
      case 'DITOLAK':
        return state.detail
          ? [`*Kenapa:* ${state.detail}`, '', '_Tidak ada uang yang terpakai._']
          : ['_Tidak ada uang yang terpakai._'];
      case 'DIBATALKAN':
        return ['_Pesanan dibatalkan. Uangnya kembali bisa dipakai._'];
      default:
        return state.detail ? [`_${state.detail}_`] : [];
    }
  }
}
