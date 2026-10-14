import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PortfolioService } from '../trading/portfolio.service';
import { RiskService } from '../trading/risk.service';
import { TradingService } from '../trading/trading.service';
import { BotConfigService } from '../config/bot-config.service';
import { fmtPrice, idr } from '../common/num';

type Button = { label: string; data: string };
type Panel = { text: string; buttons: Button[][] };

/** Susunan tombol menu utama, dua kolom seperti papan tombol. */
const MAIN_GRID: Button[][] = [
  [
    { label: '🎯 Cari Sinyal', data: 'menu:sinyal' },
    { label: '📊 Analisis Market', data: 'menu:market' },
  ],
  [
    { label: '💼 Portfolio', data: 'menu:portfolio' },
    { label: '🛡 Risk Control', data: 'menu:risk' },
  ],
  [
    { label: '🕘 Riwayat Trade', data: 'menu:riwayat' },
    { label: '⚙️ Pengaturan', data: 'menu:pengaturan' },
  ],
];

const BACK: Button[] = [{ label: '← Menu', data: 'menu:utama' }];

/** Usulan penutupan kedaluwarsa setelah ini; harga sudah bergerak terlalu jauh. */
const CLOSE_TTL_MS = 2 * 60 * 1000;

interface PendingClose {
  id: string;
  tradeId: number;
  pair: string;
  createdAt: number;
}

/**
 * Menu bertombol: antarmuka Telegram tanpa perlu menghafal perintah.
 *
 * Menekan tombol MENGGANTI isi pesan yang sama, bukan mengirim pesan baru.
 * Tanpa itu, menjelajah enam panel meninggalkan enam pesan dan riwayat yang
 * berguna — kartu peluang, laporan order — tergeser ke atas sampai hilang.
 *
 * Aksi dipisah menurut AKIBATNYA, bukan menurut kemudahannya:
 *
 *   JEDA / LANJUTKAN  mengubah flag, tidak memindahkan uang  -> satu ketukan
 *   TUTUP POSISI      menjual aset dengan uang sungguhan     -> dua ketukan
 *
 * Membuat keduanya satu ketukan akan membuat penutupan posisi semudah membuka
 * menu, dan itu kesalahan yang tidak bisa dibatalkan.
 */
@Injectable()
export class TelegramMenuService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramMenuService.name);

  /** Usulan penutupan yang menunggu konfirmasi, ber-key tradeId. */
  private readonly pendingClose = new Map<number, PendingClose>();

  constructor(
    private readonly notification: NotificationService,
    private readonly portfolio: PortfolioService,
    private readonly risk: RiskService,
    private readonly trading: TradingService,
    private readonly config: BotConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.notification.isEnabled()) return;

    this.notification.registerCallback('menu', (panel, ctx) => this.render(panel, ctx.messageId));
    this.notification.registerCallback('aksi', (arg, ctx) => this.onAksi(arg, ctx.messageId));
    this.notification.registerCallback('tutup', (arg, ctx) => this.onTutup(arg, ctx.messageId));

    this.logger.log('Menu bertombol Telegram terdaftar');
  }

  /** Kirim menu utama sebagai pesan baru. */
  async send(): Promise<void> {
    const panel = await this.panel('utama');
    await this.notification.sendWithButtons(panel.text, panel.buttons);
  }

  // ─── Navigasi ─────────────────────────────────────────────────────────────

  private async render(name: string, messageId?: number): Promise<void> {
    await this.show(await this.panel(name), messageId);
  }

  /**
   * Tampilkan panel dengan mengganti pesan yang sama bila bisa.
   *
   * `unchanged` berarti panelnya memang sudah terbuka — tidak perlu apa-apa.
   * Hanya kegagalan sungguhan yang memicu pesan baru; menyamakan keduanya
   * membuat menu mengirim duplikat tiap kali tombol yang sama ditekan dua kali.
   */
  private async show(panel: Panel, messageId?: number): Promise<void> {
    if (!messageId) {
      await this.notification.sendWithButtons(panel.text, panel.buttons);
      return;
    }

    const result = await this.notification.updateWithButtons(messageId, panel.text, panel.buttons);
    if (result === 'failed') {
      await this.notification.sendWithButtons(panel.text, panel.buttons);
    }
  }

  private async panel(name: string): Promise<Panel> {
    switch (name) {
      case 'sinyal':
        return this.sinyalPanel();
      case 'market':
        return this.marketPanel();
      case 'portfolio':
        return this.portfolioPanel();
      case 'risk':
        return this.riskPanel();
      case 'riwayat':
        return this.riwayatPanel();
      case 'pengaturan':
        return this.pengaturanPanel();
      default:
        return this.mainPanel();
    }
  }

  // ─── Aksi satu ketukan: jeda / lanjutkan ──────────────────────────────────

  /**
   * Hanya mengubah flag `TRADING_ENABLED`; tidak ada uang yang berpindah.
   *
   * Menjeda bersifat KONSERVATIF — ia menghentikan entry baru sementara posisi
   * terbuka tetap dimonitor dan stop loss tetap aktif. Salah tekan di sini
   * tidak merugikan, jadi tidak perlu konfirmasi.
   */
  private async onAksi(arg: string, messageId?: number): Promise<void> {
    if (arg === 'jeda') {
      await this.config.set('TRADING_ENABLED', 'false', 'Dijeda lewat tombol Telegram');
    } else if (arg === 'lanjut') {
      await this.config.set('TRADING_ENABLED', 'true', 'Diaktifkan lewat tombol Telegram');
    }

    // Panel digambar ulang agar tombolnya langsung mencerminkan keadaan baru.
    await this.render('risk', messageId);
  }

  // ─── Aksi dua ketukan: tutup posisi ───────────────────────────────────────

  /**
   * `tutup:<id>` meminta konfirmasi, `tutup:ok:<id>:<kode>` menutup.
   *
   * Pola kode yang sama dengan kartu BUY: kartu yang sudah digantikan tidak
   * boleh mengeksekusi rencana lain, dan menekan dua kali tidak boleh menjual
   * dua kali.
   */
  private async onTutup(arg: string, messageId?: number): Promise<void> {
    const parts = arg.split(':');

    if (parts[0] === 'ok') {
      await this.eksekusiTutup(Number(parts[1]), parts[2], messageId);
      return;
    }

    if (parts[0] === 'batal') {
      this.pendingClose.delete(Number(parts[1]));
      await this.render('portfolio', messageId);
      return;
    }

    await this.konfirmasiTutup(Number(parts[0]), messageId);
  }

  private async konfirmasiTutup(tradeId: number, messageId?: number): Promise<void> {
    const state = await this.portfolio.getState().catch(() => null);
    const pos = state?.positions?.find((p) => p.tradeId === tradeId);

    if (!pos) {
      await this.show(
        {
          text: `Posisi #${tradeId} sudah tidak terbuka.`,
          buttons: [[{ label: '← Portfolio', data: 'menu:portfolio' }]],
        },
        messageId,
      );
      return;
    }

    const kode = Math.random().toString(36).slice(2, 8);
    this.pendingClose.set(tradeId, { id: kode, tradeId, pair: pos.pair, createdAt: Date.now() });

    const untung = pos.unrealizedPnl >= 0;
    await this.show(
      {
        text: [
          `⚠️ *TUTUP POSISI #${tradeId}*`,
          '',
          `*${pos.pair.toUpperCase()}* · Mode *${this.config.mode}*`,
          '```',
          `  masuk     Rp ${fmtPrice(pos.entryPrice)}`,
          `  sekarang  Rp ${fmtPrice(pos.currentPrice)}`,
          `  nilai     ${idr(pos.valueIdr)}`,
          `  P&L       ${untung ? '+' : ''}${idr(pos.unrealizedPnl)} (${pos.unrealizedPercent >= 0 ? '+' : ''}${pos.unrealizedPercent.toFixed(2)}%)`,
          '```',
          this.config.mode === 'LIVE'
            ? '🔴 Ini akan MENJUAL dengan uang sungguhan.'
            : '🟢 Mode simulasi — tidak ada uang yang berpindah.',
          '',
          '_Usulan ini berlaku 2 menit._',
        ].join('\n'),
        buttons: [
          [
            { label: '✅ Ya, tutup', data: `tutup:ok:${tradeId}:${kode}` },
            { label: '← Batal', data: `tutup:batal:${tradeId}` },
          ],
        ],
      },
      messageId,
    );
  }

  private async eksekusiTutup(tradeId: number, kode: string, messageId?: number): Promise<void> {
    const tolak = (alasan: string) =>
      this.show(
        { text: alasan, buttons: [[{ label: '← Portfolio', data: 'menu:portfolio' }]] },
        messageId,
      );

    const pending = this.pendingClose.get(tradeId);

    if (!pending) {
      await tolak(`Tidak ada usulan penutupan aktif untuk #${tradeId}.`);
      return;
    }

    // Kartu yang sudah digantikan usulan lebih baru tidak boleh mengeksekusi.
    if (pending.id !== kode) {
      await tolak('Kartu ini sudah digantikan. Buka Portfolio lagi untuk usulan terbaru.');
      return;
    }

    if (Date.now() - pending.createdAt > CLOSE_TTL_MS) {
      this.pendingClose.delete(tradeId);
      await tolak(`⏱️ Usulan penutupan #${tradeId} kedaluwarsa. Harga sudah bergerak.`);
      return;
    }

    // Dihapus SEBELUM eksekusi: menekan dua kali tidak boleh menjual dua kali.
    this.pendingClose.delete(tradeId);

    await this.show(
      { text: `🔄 Menutup posisi #${tradeId} (${pending.pair.toUpperCase()})…`, buttons: [] },
      messageId,
    );

    const result = await this.trading.manualCloseTrade(tradeId);

    await this.show(
      {
        text: [
          result.success ? `✅ *POSISI #${tradeId} DITUTUP*` : `❌ *GAGAL MENUTUP #${tradeId}*`,
          '',
          result.message,
        ].join('\n'),
        buttons: [[{ label: '← Portfolio', data: 'menu:portfolio' }]],
      },
      messageId,
    );
  }

  // ─── Panel ────────────────────────────────────────────────────────────────

  /**
   * Kartu ringkasan.
   *
   * Mode ditampilkan APA ADANYA dan menonjol. Menampilkan "PAPER" pada bot
   * yang sebenarnya LIVE adalah kesalahan yang berakhir pada uang sungguhan,
   * jadi labelnya diturunkan dari konfigurasi, tidak pernah ditulis tetap.
   */
  private async mainPanel(): Promise<Panel> {
    const live = this.config.mode === 'LIVE';
    const params = this.config.params();

    let equity = 0;
    let cash = 0;
    let positions = 0;
    let degraded = false;

    try {
      const state = await this.portfolio.getState();
      equity = state.equityIdr;
      cash = state.cashIdr;
      positions = state.openPositions;
      degraded = state.degraded;
    } catch (err) {
      degraded = true;
      this.logger.warn(`Ringkasan portofolio gagal dibaca: ${(err as Error).message}`);
    }

    const lines = [
      '📈 *YAMIN TRADING BOT*',
      live ? '🔴 *MODE LIVE — UANG SUNGGUHAN*' : '🟢 Mode simulasi (uang tidak nyata)',
      '',
      '```',
      `  ${live ? 'Saldo' : 'Modal simulasi'}   ${idr(equity)}`,
      `  Kas bebas       ${idr(cash)}`,
      `  Posisi terbuka  ${positions}`,
      `  Risiko/trade    ${params.riskPerTradePercent}%  = ${idr(equity * (params.riskPerTradePercent / 100))}`,
      '```',
    ];

    if (!params.tradingEnabled) lines.push('⏸️ *Entry baru sedang dijeda.*', '');
    if (degraded) lines.push('⚠️ _Sebagian data portofolio tidak terbaca._', '');

    lines.push('Pilih menu di bawah:');
    return { text: lines.join('\n'), buttons: MAIN_GRID };
  }

  private async sinyalPanel(): Promise<Panel> {
    return {
      text: [
        '🎯 *CARI SINYAL*',
        '',
        'Bot memindai sendiri tiap 15 menit dan mengirim',
        'kartu bertombol bila ada yang lolos.',
        '',
        '```',
        '  /peluang       cari & tawarkan sekarang',
        '  /dashboard     apa yang bisa dibeli',
        '  /scan btcidr   periksa satu pair',
        '```',
        '_Kartu peluang memuat stop loss, TP, ukuran, risiko._',
        '_Order butuh dua ketukan: BUY lalu CONFIRM._',
      ].join('\n'),
      buttons: [BACK],
    };
  }

  private async marketPanel(): Promise<Panel> {
    return {
      text: [
        '📊 *ANALISIS MARKET*',
        '',
        '```',
        '  /market          peringkat pair likuid',
        '  /overview        ringkasan pair aktif',
        '  /analyze btcidr  analisis lengkap',
        '  /chart btcidr 60 grafik + S/R',
        '  /news            sentimen berita',
        '  /global          saham, dolar, emas',
        '  /ask <apa saja>  tanya bebas',
        '```',
        '_Semua hanya membaca; tidak ada yang memesan._',
      ].join('\n'),
      buttons: [BACK],
    };
  }

  /**
   * Portfolio dengan tombol tutup per posisi.
   *
   * Tombolnya memuat nomor posisi DAN pair, bukan hanya "Tutup" — operator
   * harus bisa melihat apa yang akan ditutup tanpa mencocokkannya dengan
   * daftar di atas.
   */
  private async portfolioPanel(): Promise<Panel> {
    const lines = ['💼 *PORTFOLIO*', ''];
    const buttons: Button[][] = [];

    try {
      const state = await this.portfolio.getState();
      lines.push(
        '```',
        `  Ekuitas    ${idr(state.equityIdr)}`,
        `  Kas        ${idr(state.cashIdr)}`,
        `  Di posisi  ${idr(state.positionsValueIdr)}`,
        `  P&L belum  ${idr(state.unrealizedPnl)}`,
        '```',
      );

      if (state.positions?.length) {
        for (const p of state.positions.slice(0, 5)) {
          const naik = p.unrealizedPercent >= 0;
          lines.push(
            `${naik ? '🟢' : '🔴'} *#${p.tradeId} ${p.pair.toUpperCase()}* — ${idr(p.valueIdr)}`,
            `    _${naik ? '+' : ''}${p.unrealizedPercent.toFixed(2)}% · ${idr(p.unrealizedPnl)} · ${p.rMultiple >= 0 ? '+' : ''}${p.rMultiple.toFixed(2)}R_`,
          );
          buttons.push([
            { label: `❌ Tutup #${p.tradeId} ${p.pair.toUpperCase()}`, data: `tutup:${p.tradeId}` },
          ]);
        }
      } else {
        lines.push('_Tidak ada posisi terbuka._');
      }
    } catch (err) {
      lines.push(`⚠️ Gagal membaca portofolio: ${(err as Error).message}`);
    }

    buttons.push([{ label: '🔄 Perbarui', data: 'menu:portfolio' }], BACK);
    return { text: lines.join('\n'), buttons };
  }

  private async riskPanel(): Promise<Panel> {
    const params = this.config.params();
    const lines = ['🛡 *RISK CONTROL*', ''];

    try {
      const kill = await this.risk.checkKillSwitch();
      if (kill.halted) {
        lines.push('🔴 *ENTRY DIHENTIKAN OTOMATIS*', `_${kill.reasons.join('; ')}_`);
      } else if (!params.tradingEnabled) {
        lines.push('⏸️ *ENTRY DIJEDA MANUAL*', '_Posisi terbuka tetap dimonitor._');
      } else {
        lines.push('🟢 *Entry diizinkan*');
      }
      lines.push('');
    } catch (err) {
      lines.push(`⚠️ Kill switch tidak terbaca: ${(err as Error).message}`, '');
    }

    lines.push(
      '```',
      `  Risiko/trade    ${params.riskPerTradePercent}%`,
      `  Maks posisi     ${params.maxPositionPercent}% ekuitas`,
      `  Rugi harian     ${params.maxDailyLossPercent}%`,
      `  Drawdown maks   ${params.maxDrawdownPercent}%`,
      `  Rugi beruntun   ${params.maxConsecutiveLosses}`,
      '```',
      '_Jeda hanya menghentikan entry BARU. Stop loss dan_',
      '_take profit posisi terbuka tetap berjalan._',
    );

    // Satu tombol yang berubah mengikuti keadaan: lebih sulit salah tekan
    // daripada dua tombol berdampingan yang salah satunya tidak berlaku.
    const toggle: Button = params.tradingEnabled
      ? { label: '⏸️ Jeda Entry', data: 'aksi:jeda' }
      : { label: '▶️ Lanjutkan Entry', data: 'aksi:lanjut' };

    return {
      text: lines.join('\n'),
      buttons: [[toggle], [{ label: '🔄 Perbarui', data: 'menu:risk' }], BACK],
    };
  }

  private async riwayatPanel(): Promise<Panel> {
    return {
      text: [
        '🕘 *RIWAYAT TRADE*',
        '',
        '```',
        '  /pnl     performa keseluruhan',
        '  /today   statistik hari ini',
        '  /trades  daftar trade terakhir',
        '```',
        '_Metrik baru berarti setelah sekitar 100 trade._',
        '_Di bawah itu angkanya didominasi kebetulan._',
      ].join('\n'),
      buttons: [BACK],
    };
  }

  private async pengaturanPanel(): Promise<Panel> {
    const params = this.config.params();
    const live = this.config.mode === 'LIVE';

    return {
      text: [
        '⚙️ *PENGATURAN*',
        '',
        '```',
        `  Mode          ${this.config.mode}`,
        `  Strategi      ${this.config.str('ACTIVE_STRATEGY', 'EMA_SCALPING_V2')}`,
        `  Pair          ${params.tradingPairs.slice(0, 3).join(', ')}${params.tradingPairs.length > 3 ? '…' : ''}`,
        `  Timeframe     ${params.candleTimeframe} menit`,
        `  Entry maker   ${params.makerEntry ? 'ya' : 'tidak'}`,
        '```',
        '```',
        '  /config        seluruh parameter',
        '  /set risk 1.5  ubah tanpa restart',
        '  /strategy      lihat / ganti strategi',
        '  /health        kondisi komponen',
        '```',
        live
          ? '🔴 _Mode LIVE: order memakai uang sungguhan._'
          : '🟢 _Mode simulasi: tidak ada yang dipertaruhkan._',
      ].join('\n'),
      buttons: [BACK],
    };
  }
}
