import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PortfolioService } from '../trading/portfolio.service';
import { RiskService } from '../trading/risk.service';
import { BotConfigService } from '../config/bot-config.service';
import { idr } from '../common/num';

type Button = { label: string; data: string };

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

/**
 * Menu bertombol: antarmuka Telegram tanpa perlu menghafal perintah.
 *
 * Menekan tombol MENGGANTI isi pesan yang sama, bukan mengirim pesan baru.
 * Tanpa itu, menjelajah enam panel meninggalkan enam pesan dan riwayat yang
 * berguna — kartu peluang, laporan order — tergeser ke atas sampai hilang.
 *
 * Seluruh panel hanya MEMBACA. Satu-satunya jalur yang mengirim order tetap
 * kartu peluang dengan konfirmasi dua langkah; menu ini tidak pernah memesan
 * apa pun, dan karena itu aman ditekan-tekan.
 */
@Injectable()
export class TelegramMenuService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramMenuService.name);

  constructor(
    private readonly notification: NotificationService,
    private readonly portfolio: PortfolioService,
    private readonly risk: RiskService,
    private readonly config: BotConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.notification.isEnabled()) return;

    this.notification.registerCallback('menu', (panel, ctx) =>
      this.onPanel(panel, ctx.messageId),
    );
    this.logger.log('Menu bertombol Telegram terdaftar');
  }

  /** Kirim menu utama sebagai pesan baru. */
  async send(): Promise<void> {
    await this.notification.sendWithButtons(await this.mainPanel(), MAIN_GRID);
  }

  /** Tangani penekanan tombol dengan mengganti isi pesan yang sama. */
  private async onPanel(panel: string, messageId?: number): Promise<string | void> {
    const { text, buttons } = await this.panel(panel);

    // Tanpa messageId (mis. pesan terlalu lama), kirim sebagai pesan baru
    // supaya tombol tetap berfungsi alih-alih diam.
    if (!messageId) {
      await this.notification.sendWithButtons(text, buttons);
      return;
    }

    await this.notification.updateWithButtons(messageId, text, buttons);
  }

  private async panel(name: string): Promise<{ text: string; buttons: Button[][] }> {
    switch (name) {
      case 'sinyal':
        return { text: await this.sinyalPanel(), buttons: [...this.sinyalActions(), BACK] };
      case 'market':
        return { text: this.marketPanel(), buttons: [...this.marketActions(), BACK] };
      case 'portfolio':
        return { text: await this.portfolioPanel(), buttons: [BACK] };
      case 'risk':
        return { text: await this.riskPanel(), buttons: [BACK] };
      case 'riwayat':
        return { text: this.riwayatPanel(), buttons: [BACK] };
      case 'pengaturan':
        return { text: this.pengaturanPanel(), buttons: [BACK] };
      default:
        return { text: await this.mainPanel(), buttons: MAIN_GRID };
    }
  }

  // ─── Panel utama ──────────────────────────────────────────────────────────

  /**
   * Kartu ringkasan.
   *
   * Mode ditampilkan APA ADANYA dan menonjol. Menampilkan "PAPER" pada bot
   * yang sebenarnya LIVE adalah kesalahan yang berakhir pada uang sungguhan,
   * jadi labelnya diturunkan dari konfigurasi, tidak pernah ditulis tetap.
   */
  private async mainPanel(): Promise<string> {
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

    if (degraded) {
      lines.push('⚠️ _Sebagian data portofolio tidak terbaca._', '');
    }

    lines.push('Pilih menu di bawah:');
    return lines.join('\n');
  }

  // ─── Panel isi ────────────────────────────────────────────────────────────

  private async sinyalPanel(): Promise<string> {
    return [
      '🎯 *CARI SINYAL*',
      '',
      'Bot memindai sendiri tiap 15 menit dan mengirim kartu',
      'bertombol bila ada yang lolos.',
      '',
      'Untuk memeriksa sekarang:',
      '```',
      '  /peluang           cari & kirim tawaran',
      '  /dashboard         apa yang bisa dibeli',
      '  /scan btcidr       periksa satu pair',
      '```',
      '_Kartu peluang memuat stop loss, TP, ukuran, dan risiko._',
      '_Order selalu butuh dua ketukan: BUY lalu CONFIRM._',
    ].join('\n');
  }

  private sinyalActions(): Button[][] {
    return [[{ label: '🔄 Perbarui', data: 'menu:sinyal' }]];
  }

  private marketPanel(): string {
    return [
      '📊 *ANALISIS MARKET*',
      '',
      '```',
      '  /market            peringkat seluruh pair likuid',
      '  /overview          ringkasan pair yang ditradingkan',
      '  /analyze btcidr    analisis lengkap satu pair',
      '  /chart btcidr 60   grafik + support/resistance',
      '  /news              sentimen berita',
      '  /global            saham, dolar, emas, minyak',
      '  /ask kenapa BTC turun?',
      '```',
      '_Semua hanya membaca; tidak ada yang memesan._',
    ].join('\n');
  }

  private marketActions(): Button[][] {
    return [[{ label: '🔄 Perbarui', data: 'menu:market' }]];
  }

  private async portfolioPanel(): Promise<string> {
    const lines = ['💼 *PORTFOLIO*', ''];

    try {
      const state = await this.portfolio.getState();
      lines.push(
        '```',
        `  Ekuitas    ${idr(state.equityIdr)}`,
        `  Kas        ${idr(state.cashIdr)}`,
        `  Di posisi  ${idr(state.positionsValueIdr)}`,
        `  Terbuka    ${state.openPositions}`,
        `  P&L belum  ${idr(state.unrealizedPnl)}`,
        '```',
      );

      if (state.positions?.length) {
        lines.push('*Posisi:*');
        for (const p of state.positions.slice(0, 5)) {
          lines.push(
            `• ${p.pair.toUpperCase()} — ${idr(p.valueIdr)} (${p.unrealizedPercent >= 0 ? '+' : ''}${p.unrealizedPercent.toFixed(2)}%)`,
          );
        }
      } else {
        lines.push('_Tidak ada posisi terbuka._');
      }
    } catch (err) {
      lines.push(`⚠️ Gagal membaca portofolio: ${(err as Error).message}`);
    }

    lines.push('', '```', '  /positions   rincian tiap posisi', '  /close 3     tutup posisi', '```');
    return lines.join('\n');
  }

  private async riskPanel(): Promise<string> {
    const params = this.config.params();
    const lines = ['🛡 *RISK CONTROL*', ''];

    try {
      const kill = await this.risk.checkKillSwitch();
      lines.push(
        kill.halted ? '🔴 *ENTRY DIHENTIKAN*' : '🟢 Entry diizinkan',
        kill.halted ? `_${kill.reasons.join('; ')}_` : '',
        '',
      );
    } catch (err) {
      lines.push(`⚠️ Kill switch tidak terbaca: ${(err as Error).message}`, '');
    }

    lines.push(
      '```',
      `  Risiko/trade     ${params.riskPerTradePercent}%`,
      `  Maks posisi      ${params.maxPositionPercent}% ekuitas`,
      `  Rugi harian      ${params.maxDailyLossPercent}%`,
      `  Drawdown maks    ${params.maxDrawdownPercent}%`,
      `  Rugi beruntun    ${params.maxConsecutiveLosses}`,
      '```',
      '```',
      '  /risk        sisa jatah risiko hari ini',
      '  /blockers    kenapa bot tidak masuk posisi',
      '  /pause       hentikan entry baru',
      '  /resume      aktifkan kembali',
      '```',
    );
    return lines.join('\n');
  }

  private riwayatPanel(): string {
    return [
      '🕘 *RIWAYAT TRADE*',
      '',
      '```',
      '  /pnl       performa keseluruhan',
      '  /today     statistik hari ini',
      '  /trades    daftar trade terakhir',
      '```',
      '_Catatan: metrik baru berarti setelah sekitar 100 trade._',
      '_Di bawah itu, angkanya masih didominasi kebetulan._',
    ].join('\n');
  }

  private pengaturanPanel(): string {
    const params = this.config.params();
    const live = this.config.mode === 'LIVE';

    return [
      '⚙️ *PENGATURAN*',
      '',
      '```',
      `  Mode           ${this.config.mode}`,
      `  Strategi       ${this.config.str('ACTIVE_STRATEGY', 'EMA_SCALPING_V2')}`,
      `  Pair           ${params.tradingPairs.slice(0, 4).join(', ')}${params.tradingPairs.length > 4 ? '…' : ''}`,
      `  Timeframe      ${params.candleTimeframe} menit`,
      `  Entry maker    ${params.makerEntry ? 'ya' : 'tidak'}`,
      '```',
      '```',
      '  /config          seluruh parameter',
      '  /set risk 1.5    ubah tanpa restart',
      '  /strategy        lihat / ganti strategi',
      '  /health          kondisi komponen',
      '```',
      live
        ? '🔴 _Mode LIVE: order memakai uang sungguhan._'
        : '🟢 _Mode simulasi: tidak ada uang yang dipertaruhkan._',
    ].join('\n');
  }
}
