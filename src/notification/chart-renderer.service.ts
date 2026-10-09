import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { Candle } from '../indodax/indodax.types';
import { fmtPrice } from '../common/num';

/** Satu level horizontal yang digambar di chart. */
export interface ChartLevel {
  price: number;
  label: string;
  color: string;
  /** Band atas-bawah bila level ini sebenarnya sebuah zona, bukan garis. */
  bandLow?: number;
  bandHigh?: number;
  dashed?: boolean;
}

export interface ChartRequest {
  pair: string;
  timeframeMinutes: number;
  candles: Candle[];
  /** Garis EMA yang ikut digambar; kunci jadi label. */
  emas?: Record<string, number[]>;
  levels?: ChartLevel[];
  /** Teks tambahan di bawah judul (mis. skor, regime, alasan sinyal). */
  subtitle?: string;
  /** Maksimum candle yang digambar; sisanya dipotong dari kiri. */
  maxCandles?: number;
}

const THEME = {
  bg: '#0f1219',
  panel: '#171b25',
  grid: '#232838',
  text: '#e6e9ef',
  muted: '#8b93a7',
  up: '#22c55e',
  down: '#ef4444',
  volUp: 'rgba(34,197,94,0.35)',
  volDown: 'rgba(239,68,68,0.35)',
};

const EMA_COLORS = ['#3b82f6', '#f59e0b', '#a855f7', '#06b6d4'];

/**
 * Penggambar chart untuk Telegram.
 *
 * Alasan keberadaannya: notifikasi berupa deretan angka memaksa operator
 * membuka aplikasi lain untuk tahu apakah angka itu masuk akal. Satu gambar
 * dengan garis support/resistance menjawabnya seketika — dan level-levelnya
 * memang sudah dihitung Market Intelligence, hanya belum pernah terlihat.
 *
 * Memakai @napi-rs/canvas, bukan `canvas` biasa: yang pertama memaketkan
 * binary siap pakai sehingga tidak butuh node-gyp — penting di Windows, tempat
 * kompilasi native paling sering gagal.
 */
@Injectable()
export class ChartRendererService {
  private readonly logger = new Logger(ChartRendererService.name);

  private readonly W = 1200;
  private readonly H = 760;
  private readonly PAD = { top: 74, right: 132, bottom: 34, left: 14 };
  /** Tinggi strip volume di bawah panel harga. */
  private readonly VOL_H = 110;

  render(req: ChartRequest): Buffer {
    const max = req.maxCandles ?? 120;
    const candles = req.candles.slice(-max);

    const canvas = createCanvas(this.W, this.H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, this.W, this.H);

    if (candles.length < 2) {
      this.centeredText(ctx, 'Data candle tidak cukup untuk digambar');
      return canvas.toBuffer('image/png');
    }

    const plot = {
      x: this.PAD.left,
      y: this.PAD.top,
      w: this.W - this.PAD.left - this.PAD.right,
      h: this.H - this.PAD.top - this.PAD.bottom - this.VOL_H,
    };

    // Skala harga memperhitungkan level yang digambar, supaya garis support
    // di bawah layar tidak membuat operator mengira level itu tidak ada.
    const prices: number[] = [];
    for (const c of candles) prices.push(c.high, c.low);
    for (const l of req.levels ?? []) {
      // Level yang sangat jauh diabaikan: satu zona di 3x harga akan memampatkan
      // seluruh candle menjadi garis datar dan menghapus informasi utamanya.
      const near = Math.abs(l.price - candles[candles.length - 1].close) / candles[candles.length - 1].close;
      if (near <= 0.25) prices.push(l.bandLow ?? l.price, l.bandHigh ?? l.price);
    }

    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const pad = (rawMax - rawMin) * 0.06 || rawMax * 0.01 || 1;
    const lo = rawMin - pad;
    const hi = rawMax + pad;

    const yOf = (p: number) => plot.y + ((hi - p) / (hi - lo)) * plot.h;
    const slot = plot.w / candles.length;
    const xOf = (i: number) => plot.x + i * slot + slot / 2;

    this.drawGrid(ctx, plot, lo, hi, yOf);
    this.drawLevels(ctx, plot, req.levels ?? [], yOf, lo, hi);
    this.drawCandles(ctx, candles, xOf, yOf, slot);
    this.drawEmas(ctx, req.emas ?? {}, candles.length, xOf, yOf);
    this.drawVolume(ctx, candles, plot, xOf, slot);
    this.drawHeader(ctx, req, candles);
    this.drawTimeAxis(ctx, candles, plot, xOf);
    this.drawLegend(ctx, req.emas ?? {});

    return canvas.toBuffer('image/png');
  }

  // ─── Bagian-bagian ────────────────────────────────────────────────────────

  private drawGrid(
    ctx: SKRSContext2D,
    plot: { x: number; y: number; w: number; h: number },
    lo: number,
    hi: number,
    yOf: (p: number) => number,
  ): void {
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = THEME.muted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';

    const STEPS = 6;
    for (let i = 0; i <= STEPS; i++) {
      const price = lo + ((hi - lo) * i) / STEPS;
      const y = Math.round(yOf(price)) + 0.5;

      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();

      ctx.fillText(fmtPrice(price), plot.x + plot.w + 8, y + 4);
    }
  }

  /** Zona digambar sebagai pita; level tunggal sebagai garis. */
  private drawLevels(
    ctx: SKRSContext2D,
    plot: { x: number; y: number; w: number; h: number },
    levels: ChartLevel[],
    yOf: (p: number) => number,
    lo: number,
    hi: number,
  ): void {
    const visible = levels.filter((l) => l.price >= lo && l.price <= hi);

    // Pita dan garis digambar lebih dulu, semuanya, supaya label tidak pernah
    // tertimpa garis yang digambar sesudahnya.
    for (const l of visible) {
      if (l.bandLow !== undefined && l.bandHigh !== undefined && l.bandHigh > l.bandLow) {
        const yTop = yOf(Math.min(l.bandHigh, hi));
        const yBot = yOf(Math.max(l.bandLow, lo));
        ctx.fillStyle = this.alpha(l.color, 0.13);
        ctx.fillRect(plot.x, yTop, plot.w, Math.max(yBot - yTop, 2));
      }

      const y = Math.round(yOf(l.price)) + 0.5;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(l.dashed ? [7, 5] : []);
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /**
     * Label digeser agar tidak saling menimpa.
     *
     * Dua level yang harganya berdekatan menghasilkan label di piksel yang
     * hampir sama, dan yang digambar belakangan menutupi yang lebih dulu —
     * tepat pada kasus paling penting, yaitu saat ENTRY berada persis di dekat
     * sebuah support. Label digeser ke bawah secukupnya; garisnya sendiri tetap
     * di harga yang benar, dan penunjuk kecil menghubungkan keduanya.
     */
    const LABEL_H = 18;
    const placed = visible
      .map((l) => ({ level: l, yLine: yOf(l.price), yLabel: yOf(l.price) }))
      .sort((a, b) => a.yLine - b.yLine);

    for (let i = 1; i < placed.length; i++) {
      const minY = placed[i - 1].yLabel + LABEL_H + 2;
      if (placed[i].yLabel < minY) placed[i].yLabel = minY;
    }

    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';

    for (const { level, yLine, yLabel } of placed) {
      const tw = ctx.measureText(level.label).width;
      const boxX = plot.x + plot.w + 4;

      // Penunjuk ke garis aslinya, hanya bila labelnya memang bergeser.
      if (Math.abs(yLabel - yLine) > 2) {
        ctx.strokeStyle = this.alpha(level.color, 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.x + plot.w, yLine);
        ctx.lineTo(boxX, yLabel);
        ctx.stroke();
      }

      ctx.fillStyle = level.color;
      ctx.fillRect(boxX, yLabel - 9, tw + 10, LABEL_H);
      ctx.fillStyle = '#0b0e14';
      ctx.fillText(level.label, boxX + 5, yLabel + 4);
    }
  }

  private drawCandles(
    ctx: SKRSContext2D,
    candles: Candle[],
    xOf: (i: number) => number,
    yOf: (p: number) => number,
    slot: number,
  ): void {
    const bodyW = Math.max(Math.min(slot * 0.62, 14), 1.5);

    candles.forEach((c, i) => {
      const up = c.close >= c.open;
      const color = up ? THEME.up : THEME.down;
      const x = xOf(i);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yOf(c.high));
      ctx.lineTo(Math.round(x) + 0.5, yOf(c.low));
      ctx.stroke();

      const yO = yOf(c.open);
      const yC = yOf(c.close);
      ctx.fillStyle = color;
      // Candle doji tetap terlihat sebagai garis tipis, bukan hilang sama sekali.
      ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(Math.abs(yC - yO), 1));
    });
  }

  private drawEmas(
    ctx: SKRSContext2D,
    emas: Record<string, number[]>,
    candleCount: number,
    xOf: (i: number) => number,
    yOf: (p: number) => number,
  ): void {
    Object.values(emas).forEach((series, idx) => {
      if (!series?.length) return;
      ctx.strokeStyle = EMA_COLORS[idx % EMA_COLORS.length];
      ctx.lineWidth = 1.6;
      ctx.beginPath();

      // Seri EMA lebih pendek dari candle (butuh periode awal); ratakan ke kanan
      // agar nilai terakhir EMA sejajar dengan candle terakhir.
      const offset = candleCount - series.length;
      let started = false;
      series.forEach((v, i) => {
        const x = xOf(i + offset);
        if (i + offset < 0) return;
        if (!started) {
          ctx.moveTo(x, yOf(v));
          started = true;
        } else ctx.lineTo(x, yOf(v));
      });
      ctx.stroke();
    });
  }

  private drawVolume(
    ctx: SKRSContext2D,
    candles: Candle[],
    plot: { x: number; y: number; w: number; h: number },
    xOf: (i: number) => number,
    slot: number,
  ): void {
    const top = plot.y + plot.h + 16;
    const h = this.VOL_H - 26;
    const maxVol = Math.max(...candles.map((c) => c.volume), 1);
    const bodyW = Math.max(Math.min(slot * 0.62, 14), 1.5);

    ctx.fillStyle = THEME.muted;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Volume', plot.x + 2, top - 4);

    candles.forEach((c, i) => {
      const bh = (c.volume / maxVol) * h;
      ctx.fillStyle = c.close >= c.open ? THEME.volUp : THEME.volDown;
      ctx.fillRect(xOf(i) - bodyW / 2, top + h - bh, bodyW, bh);
    });
  }

  private drawHeader(ctx: SKRSContext2D, req: ChartRequest, candles: Candle[]): void {
    const last = candles[candles.length - 1];
    const first = candles[0];
    const changePct = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;

    ctx.textAlign = 'left';

    /**
     * Lebar teks HARUS diukur selagi font yang menggambarnya masih aktif.
     * Mengukur setelah berganti ke font yang lebih kecil menghasilkan lebar
     * yang terlalu pendek, dan teks berikutnya menimpa teks sebelumnya.
     */
    const measured = (text: string, font: string): number => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };

    const pairText = req.pair.toUpperCase();
    const pairW = measured(pairText, 'bold 22px sans-serif');
    ctx.fillStyle = THEME.text;
    ctx.fillText(pairText, this.PAD.left + 2, 32);

    ctx.font = '13px sans-serif';
    ctx.fillStyle = THEME.muted;
    ctx.fillText(this.timeframeLabel(req.timeframeMinutes), this.PAD.left + 14 + pairW, 32);

    const priceText = fmtPrice(last.close);
    const priceW = measured(priceText, 'bold 20px sans-serif');
    ctx.fillStyle = THEME.text;
    ctx.fillText(priceText, this.PAD.left + 2, 58);

    ctx.font = '13px sans-serif';
    ctx.fillStyle = changePct >= 0 ? THEME.up : THEME.down;
    ctx.fillText(
      `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% (${candles.length} candle)`,
      this.PAD.left + 14 + priceW,
      58,
    );

    if (req.subtitle) {
      ctx.textAlign = 'right';
      ctx.fillStyle = THEME.muted;
      ctx.font = '13px sans-serif';
      ctx.fillText(req.subtitle, this.W - this.PAD.right + 118, 32);
    }
  }

  private drawTimeAxis(
    ctx: SKRSContext2D,
    candles: Candle[],
    plot: { x: number; y: number; w: number; h: number },
    xOf: (i: number) => number,
  ): void {
    ctx.fillStyle = THEME.muted;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';

    const y = this.H - 10;
    const step = Math.max(1, Math.floor(candles.length / 6));
    for (let i = 0; i < candles.length; i += step) {
      const d = new Date(candles[i].time * 1000);
      const label = d.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      ctx.fillText(label, xOf(i), y);
    }
  }

  private drawLegend(ctx: SKRSContext2D, emas: Record<string, number[]>): void {
    const names = Object.keys(emas).filter((k) => emas[k]?.length);
    if (!names.length) return;

    let x = this.PAD.left + 2;
    // Diletakkan DI DALAM panel harga, bukan di celah antara panel dan strip
    // volume — celah itu sudah dipakai label "Volume".
    const y = this.PAD.top + 18;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';

    names.forEach((name, idx) => {
      ctx.fillStyle = EMA_COLORS[idx % EMA_COLORS.length];
      ctx.fillRect(x, y - 8, 14, 3);
      ctx.fillStyle = THEME.muted;
      ctx.fillText(name, x + 19, y);
      x += 19 + ctx.measureText(name).width + 16;
    });
  }

  // ─── Utilitas ─────────────────────────────────────────────────────────────

  private timeframeLabel(minutes: number): string {
    if (minutes >= 1440) return `${minutes / 1440}D`;
    if (minutes >= 60) return `${minutes / 60}H`;
    return `${minutes}m`;
  }

  /** Ubah warna hex menjadi rgba dengan transparansi tertentu. */
  private alpha(hex: string, a: number): string {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  private centeredText(ctx: SKRSContext2D, text: string): void {
    ctx.fillStyle = THEME.muted;
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, this.W / 2, this.H / 2);
  }
}
