import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { fmtPrice, idr } from '../common/num';

export interface TradeAlertPayload {
  type: 'BUY' | 'SELL';
  tradeId: number;
  pair: string;
  price: number;
  amount: number;
  quantity: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskIdr?: number;
  profitLoss?: number;
  profitLossPercent?: number;
  rMultiple?: number;
  fee?: number;
  slippagePercent?: number;
  reasons: string[];
  strategy: string;
  mode: string;
}

/** Handler perintah masuk; didaftarkan oleh TelegramCommandService. */
export type CommandHandler = (args: string[], chatId: string) => Promise<string>;

/** Handler tombol inline; mengembalikan teks balasan opsional. */
export type CallbackHandler = (
  arg: string,
  ctx: { chatId: string; messageId?: number },
) => Promise<string | void>;

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private botToken = '';
  private chatId = '';
  private enabled = false;

  /** Polling update Telegram — mengaktifkan kontrol dua arah. */
  private pollingTimer: NodeJS.Timeout | null = null;
  private updateOffset = 0;
  private stopped = false;
  private readonly handlers = new Map<string, { handler: CommandHandler; help: string }>();

  /** Redam pesan identik beruntun agar tidak membanjiri chat. */
  private lastMessage = { text: '', at: 0 };

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.chatId = this.config.get<string>('TELEGRAM_CHAT_ID', '');
    this.enabled = !!(
      this.botToken &&
      this.chatId &&
      !this.botToken.startsWith('your_') &&
      !this.chatId.startsWith('your_')
    );

    if (!this.enabled) {
      this.logger.warn('Notifikasi Telegram nonaktif (token/chat_id belum diisi)');
      return;
    }

    this.logger.log('Notifikasi Telegram aktif');
    this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ─── Pengiriman ───────────────────────────────────────────────────────────

  private async sendMessage(text: string, chatId?: string): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`[Telegram nonaktif] ${text.split('\n')[0]}`);
      return;
    }

    // Redam duplikat dalam 60 detik (mis. alert error yang berulang tiap siklus).
    if (text === this.lastMessage.text && Date.now() - this.lastMessage.at < 60_000) return;
    this.lastMessage = { text, at: Date.now() };

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: chatId ?? this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        },
        { timeout: 15000 },
      );
    } catch (err) {
      // Markdown yang tidak valid membuat Telegram menolak pesan — kirim ulang polos.
      const description = err?.response?.data?.description ?? err.message;
      if (/can't parse entities|parse/i.test(String(description))) {
        try {
          await axios.post(
            `https://api.telegram.org/bot${this.botToken}/sendMessage`,
            { chat_id: chatId ?? this.chatId, text, disable_web_page_preview: true },
            { timeout: 15000 },
          );
          return;
        } catch {
          /* jatuh ke log di bawah */
        }
      }
      this.logger.error(`Gagal mengirim Telegram: ${description}`);
    }
  }

  // ─── Kontrol dua arah ─────────────────────────────────────────────────────

  /**
   * Daftarkan perintah Telegram.
   * Paket `node-telegram-bot-api` sudah terpasang sejak awal tetapi tidak pernah
   * dipakai — notifikasi hanya satu arah. Di sini bot bisa dikendalikan penuh
   * dari ponsel: cek status, tutup posisi, hentikan trading.
   */
  registerCommand(name: string, help: string, handler: CommandHandler): void {
    this.handlers.set(name.toLowerCase(), { handler, help });
  }

  private startPolling(): void {
    const poll = async () => {
      if (this.stopped) return;
      try {
        const res = await axios.get(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
          params: { offset: this.updateOffset, timeout: 30, allowed_updates: JSON.stringify(['message', 'callback_query']) },
          timeout: 40000,
        });

        for (const update of res.data.result ?? []) {
          this.updateOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.stopped) {
          this.logger.warn(`Polling Telegram bermasalah: ${err.message}`);
        }
      }
      if (!this.stopped) this.pollingTimer = setTimeout(poll, 1000);
    };

    this.pollingTimer = setTimeout(poll, 2000);
  }

  private async handleUpdate(update: any): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.text) return;

    const fromChatId = String(message.chat.id);
    // Hanya chat yang dikonfigurasi yang boleh mengendalikan bot.
    if (fromChatId !== this.chatId) {
      this.logger.warn(`Perintah dari chat tidak dikenal ditolak: ${fromChatId}`);
      return;
    }

    const text = message.text.trim();
    if (!text.startsWith('/')) return;

    const [rawCmd, ...args] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase(); // buang @namabot di grup

    if (cmd === 'help' || cmd === 'start') {
      await this.sendMessage(this.buildHelp(), fromChatId);
      return;
    }

    const entry = this.handlers.get(cmd);
    if (!entry) {
      await this.sendMessage(`Perintah /${cmd} tidak dikenal. Ketik /help untuk daftar perintah.`, fromChatId);
      return;
    }

    try {
      const reply = await entry.handler(args, fromChatId);
      if (reply) await this.sendMessage(reply, fromChatId);
    } catch (err) {
      this.logger.error(`Perintah /${cmd} gagal: ${err.message}`);
      await this.sendMessage(`⚠️ Perintah /${cmd} gagal: ${err.message}`, fromChatId);
    }
  }

  /**
   * Handler tombol inline, di-key oleh awalan callback_data.
   *
   * Telegram membatasi callback_data pada 64 byte, jadi datanya dipadatkan
   * menjadi `aksi:argumen` — bukan JSON.
   */
  private readonly callbackHandlers = new Map<string, CallbackHandler>();

  registerCallback(prefix: string, handler: CallbackHandler): void {
    this.callbackHandlers.set(prefix, handler);
  }

  private async handleCallback(query: any): Promise<void> {
    const fromChatId = String(query.message?.chat?.id ?? '');
    if (fromChatId !== this.chatId) {
      this.logger.warn(`Callback dari chat tidak dikenal ditolak: ${fromChatId}`);
      await this.answerCallback(query.id, 'Tidak diizinkan');
      return;
    }

    const data = String(query.data ?? '');
    const [prefix, ...rest] = data.split(':');
    const handler = this.callbackHandlers.get(prefix);

    if (!handler) {
      await this.answerCallback(query.id, 'Tombol ini sudah tidak berlaku');
      return;
    }

    try {
      // Telegram menampilkan spinner pada tombol sampai callback dijawab;
      // menjawab lebih dulu membuat antarmuka tidak terasa menggantung
      // walau pekerjaannya sendiri butuh beberapa detik.
      await this.answerCallback(query.id);
      const reply = await handler(rest.join(':'), {
        chatId: fromChatId,
        messageId: query.message?.message_id,
      });
      if (reply) await this.sendMessage(reply, fromChatId);
    } catch (err) {
      this.logger.error(`Callback ${data} gagal: ${err.message}`);
      await this.sendMessage(`⚠️ Aksi gagal: ${err.message}`, fromChatId);
    }
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`,
        { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
        { timeout: 10000 },
      );
    } catch (err) {
      this.logger.warn(`answerCallbackQuery gagal: ${err.message}`);
    }
  }

  /** Kirim pesan dengan tombol inline. */
  async sendWithButtons(
    text: string,
    buttons: Array<Array<{ label: string; data: string }>>,
    chatId?: string,
  ): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`[Telegram nonaktif] ${text.split('\n')[0]}`);
      return;
    }

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: chatId ?? this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: buttons.map((row) =>
              row.map((b) => ({ text: b.label, callback_data: b.data })),
            ),
          },
        },
        { timeout: 15000 },
      );
    } catch (err) {
      const description = err?.response?.data?.description ?? err.message;
      this.logger.error(`Gagal mengirim tombol: ${description}`);
      // Pesannya tetap dikirim tanpa tombol: isinya lebih penting daripada
      // antarmukanya.
      await this.sendMessage(text, chatId);
    }
  }

  private buildHelp(): string {
    const lines = ['*Perintah yang tersedia*', ''];
    for (const [name, { help }] of [...this.handlers.entries()].sort()) {
      lines.push(`/${name} — ${help}`);
    }
    lines.push('', '/help — tampilkan bantuan ini');
    return lines.join('\n');
  }

  // ─── Pesan siap pakai ─────────────────────────────────────────────────────

  async sendStartup(info: { mode: string; strategy: string; pairs: string[]; equity: number }): Promise<void> {
    const modeTag = info.mode === 'LIVE' ? '🔴 LIVE (uang asli)' : '🔵 SIMULASI';
    await this.sendMessage(
      [
        '🤖 *Bot Trading Indodax Aktif*',
        '',
        `Mode: *${modeTag}*`,
        `Strategi: \`${info.strategy}\``,
        `Pair: ${info.pairs.map((p) => p.toUpperCase()).join(', ')}`,
        `Ekuitas: ${idr(info.equity)}`,
        '',
        'Ketik /help untuk daftar perintah.',
      ].join('\n'),
    );
  }

  /**
   * Kirim notifikasi trade, disertai chart bila tersedia.
   *
   * Gambarnya opsional dengan sengaja: pembuatan chart memanggil exchange dan
   * bisa gagal, sedangkan notifikasi stop loss tidak boleh ikut hilang
   * karenanya.
   */
  /**
   * Kirim teks sebagai keterangan gambar bila ada chart, atau sebagai pesan
   * biasa bila tidak. Satu jalur ini membuat pemanggil tidak perlu
   * mencabangkan sendiri.
   */
  private async deliver(chart: Buffer | null | undefined, text: string, chatId?: string): Promise<void> {
    if (chart && (await this.sendPhoto(chart, text, chatId))) return;
    await this.sendMessage(text, chatId);
  }

  async sendTradeAlert(p: TradeAlertPayload, chart?: Buffer | null): Promise<void> {
    const modeTag = p.mode === 'SIMULATION' ? '🔵 [SIM]' : '🔴 [LIVE]';
    const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    if (p.type === 'BUY') {
      await this.deliver(chart,
        [
          `${modeTag} 📈 *POSISI DIBUKA*  #${p.tradeId}`,
          '',
          `*Pair:* ${p.pair.toUpperCase()}`,
          `*Entry:* Rp ${fmtPrice(p.price)}`,
          `*Nilai:* ${idr(p.amount)}`,
          `*Jumlah:* ${p.quantity.toFixed(8)}`,
          `*Stop Loss:* Rp ${fmtPrice(p.stopLoss ?? 0)}`,
          `*Take Profit:* Rp ${fmtPrice(p.takeProfit ?? 0)}`,
          `*Risiko:* ${idr(p.riskIdr ?? 0)}`,
          `*Fee:* ${idr(p.fee ?? 0)} | *Slippage:* ${(p.slippagePercent ?? 0).toFixed(3)}%`,
          '',
          `*Strategi:* \`${p.strategy}\``,
          '*Alasan:*',
          ...p.reasons.map((r) => `  • ${r}`),
          '',
          `⏰ ${time}`,
        ].join('\n'),
      );
      return;
    }

    const profit = p.profitLoss ?? 0;
    const emoji = profit > 0 ? '✅' : '❌';
    await this.deliver(chart,
      [
        `${modeTag} ${emoji} *POSISI DITUTUP*  #${p.tradeId}`,
        '',
        `*Pair:* ${p.pair.toUpperCase()}`,
        `*Entry → Exit:* Rp ${fmtPrice(p.entryPrice ?? 0)} → Rp ${fmtPrice(p.price)}`,
        `*P&L bersih:* ${idr(profit)} (${(p.profitLossPercent ?? 0).toFixed(2)}%)`,
        `*R-multiple:* ${(p.rMultiple ?? 0) >= 0 ? '+' : ''}${(p.rMultiple ?? 0).toFixed(2)}R`,
        `*Total fee:* ${idr(p.fee ?? 0)}`,
        `*Alasan:* ${p.reasons.join(' — ')}`,
        '',
        `⏰ ${time}`,
      ].join('\n'),
    );
  }

  async sendPartialTakeProfit(p: {
    tradeId: number;
    pair: string;
    /** Tingkat TP yang tercapai (1-3). */
    level?: number;
    /** Kelipatan risiko tempat tingkat itu dipicu. */
    atR?: number;
    quantity: number;
    price: number;
    profit: number;
    remainingQuantity: number;
  }): Promise<void> {
    await this.sendMessage(
      [
        p.level
          ? `💰 *TP${p.level} TERCAPAI* (${p.atR}R)  #${p.tradeId}`
          : `💰 *PROFIT SEBAGIAN DIAMBIL*  #${p.tradeId}`,
        '',
        `*Pair:* ${p.pair.toUpperCase()}`,
        `*Terjual:* ${p.quantity.toFixed(8)} @ Rp ${fmtPrice(p.price)}`,
        `*Profit terkunci:* ${idr(p.profit)}`,
        `*Sisa posisi:* ${p.remainingQuantity.toFixed(8)}`,
        '',
        // Pengamanan ke titik impas hanya terjadi pada tingkat pertama.
        p.level === 1 || p.level === undefined
          ? 'Stop sisa posisi dinaikkan ke titik impas — trade ini tidak bisa lagi rugi.'
          : p.remainingQuantity > 0
            ? 'Sisa posisi dibiarkan berjalan dengan trailing stop.'
            : 'Seluruh tingkat tercapai — posisi ditutup penuh.',
      ].join('\n'),
    );
  }

  async sendKillSwitchAlert(reasons: string[]): Promise<void> {
    await this.sendMessage(
      [
        '🛑 *BOT MENGHENTIKAN ENTRY BARU*',
        '',
        ...reasons.map((r) => `• ${r}`),
        '',
        'Posisi terbuka tetap dimonitor. Gunakan /resume setelah kondisi diperiksa.',
      ].join('\n'),
    );
  }

  async sendDailyReport(stats: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnL: number;
    totalFees: number;
    openTrades: number;
    avgRMultiple: number;
    equity?: number;
    drawdownPercent?: number;
  }): Promise<void> {
    const emoji = stats.totalPnL >= 0 ? '✅' : '❌';
    await this.sendMessage(
      [
        '📈 *LAPORAN HARIAN*',
        `📅 ${new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
        '',
        `Trade selesai: ${stats.totalTrades}`,
        `Menang: ${stats.winTrades} | Kalah: ${stats.lossTrades}`,
        `Win rate: ${stats.winRate.toFixed(1)}%`,
        `Rata-rata: ${stats.avgRMultiple >= 0 ? '+' : ''}${stats.avgRMultiple.toFixed(2)}R`,
        `Posisi aktif: ${stats.openTrades}`,
        '',
        `${emoji} *P&L bersih: ${idr(stats.totalPnL)}*`,
        `Fee dibayar: ${idr(stats.totalFees)}`,
        stats.equity !== undefined ? `Ekuitas: ${idr(stats.equity)}` : '',
        stats.drawdownPercent !== undefined
          ? `Drawdown: ${stats.drawdownPercent.toFixed(2)}%`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  async sendDailyAnalysis(data: {
    date: string;
    marketSentiment: string;
    pairAnalyses: any[];
    topGainers: any[];
    topLosers: any[];
  }): Promise<void> {
    const emoji =
      data.marketSentiment === 'BULLISH' ? '🟢' : data.marketSentiment === 'BEARISH' ? '🔴' : '🟡';

    const pairLines = data.pairAnalyses.map((p) => {
      const t = p.trend === 'BULLISH' ? '📈' : p.trend === 'BEARISH' ? '📉' : '➡️';
      return `  ${t} *${p.pair.toUpperCase()}* ${p.change24h >= 0 ? '+' : ''}${p.change24h.toFixed(2)}% | RSI ${p.rsi.toFixed(0)} | ADX ${p.adx?.toFixed(0) ?? '-'} | ${p.signal}`;
    });

    const gainers = data.topGainers
      .slice(0, 3)
      .map((g) => `  ${g.pair.toUpperCase()} +${Number(g.change).toFixed(2)}%`);
    const losers = data.topLosers
      .slice(0, 3)
      .map((l) => `  ${l.pair.toUpperCase()} ${Number(l.change).toFixed(2)}%`);

    await this.sendMessage(
      [
        `📊 *ANALISIS PASAR — ${data.date}*`,
        '',
        `${emoji} Sentimen: *${data.marketSentiment}*`,
        '',
        '*Pair yang dipantau:*',
        ...pairLines,
        '',
        ...(gainers.length ? ['*Penguat teratas (pasar):*', ...gainers] : []),
        ...(losers.length ? ['', '*Pelemah teratas (pasar):*', ...losers] : []),
      ].join('\n'),
    );
  }

  /**
   * Alert setup berkualitas tinggi dari Market Intelligence (bagian 19).
   *
   * Ini adalah SINYAL, bukan laporan eksekusi. Perbedaannya ditegaskan di baris
   * pertama pesan: operator yang membaca sekilas di ponsel harus langsung tahu
   * apakah uang sudah berpindah atau belum. Tanpa pembedaan itu, notifikasi
   * "BTC/IDR LONG 84/100" mudah disalahartikan sebagai posisi yang sudah dibuka.
   */
  async sendSetupAlert(p: {
    pair: string;
    direction: string;
    score: number;
    decision: string;
    regime: string;
    structure: string;
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    takeProfit3: number;
    riskReward: number;
    reasons: string[];
    risks: string[];
    executable: boolean;
  }): Promise<void> {
    const lines = [
      `🚨 *SINYAL — ${p.decision.replace(/_/g, ' ')}*`,
      `_Analisis saja; belum ada order yang dikirim._`,
      '',
      `*${p.pair.toUpperCase()}*`,
      `Arah: ${p.direction}`,
      `Skor: ${p.score}/100`,
      `Regime: ${p.regime}`,
      `Struktur: ${p.structure}`,
      '',
      `Entry: ${fmtPrice(p.entryLow)} – ${fmtPrice(p.entryHigh)}`,
      `SL: ${fmtPrice(p.stopLoss)}`,
      `TP1: ${fmtPrice(p.takeProfit1)}`,
      `TP2: ${fmtPrice(p.takeProfit2)}`,
      `TP3: ${fmtPrice(p.takeProfit3)}`,
      `R/R: 1:${p.riskReward.toFixed(1)}`,
    ];

    if (p.reasons.length) {
      lines.push('', '*Alasan:*', ...p.reasons.slice(0, 6).map((r) => `✓ ${r}`));
    }
    if (p.risks.length) {
      lines.push('', '*Risiko:*', ...p.risks.slice(0, 4).map((r) => `⚠ ${r}`));
    }
    if (!p.executable) {
      lines.push('', '_Indodax adalah bursa spot — arah ini tidak dapat dieksekusi bot._');
    }

    lines.push(
      '',
      '_Skor adalah nilai kualitas menurut rule engine, BUKAN peluang profit._',
    );

    await this.sendMessage(lines.join('\n'));
  }

  /** Sinyal ditolak Market Intelligence — berguna untuk menilai apakah filter terlalu ketat. */
  async sendNoTradeNotice(p: {
    pair: string;
    score: number;
    reasons: string[];
  }): Promise<void> {
    await this.sendMessage(
      [
        `⛔ *NO TRADE — ${p.pair.toUpperCase()}*`,
        `Skor ${p.score}/100`,
        '',
        '*Ditolak karena:*',
        ...p.reasons.slice(0, 5).map((r) => `• ${r}`),
      ].join('\n'),
    );
  }

  /** Order gagal dikirim atau tidak terisi. */
  async sendOrderFailed(p: {
    pair: string;
    side: string;
    tradeId?: number;
    error: string;
    attempts?: number;
  }): Promise<void> {
    await this.sendMessage(
      [
        `❌ *ORDER GAGAL*`,
        `${p.pair.toUpperCase()} ${p.side.toUpperCase()}${p.tradeId ? ` (#${p.tradeId})` : ''}`,
        p.attempts ? `Percobaan ke-${p.attempts}` : '',
        '',
        p.error,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /** Selisih antara catatan bot dan keadaan di exchange. */
  async sendReconciliationError(p: {
    discrepancies: Array<{ type: string; pair: string; detail: string; severity: string }>;
  }): Promise<void> {
    const critical = p.discrepancies.filter((d) => d.severity === 'CRITICAL');
    await this.sendMessage(
      [
        `🔁 *SELISIH REKONSILIASI*`,
        `${critical.length} kritis dari ${p.discrepancies.length} temuan`,
        '',
        ...p.discrepancies
          .slice(0, 6)
          .map((d) => `• [${d.severity}] ${d.pair.toUpperCase()} — ${d.detail}`),
      ].join('\n'),
    );
  }

  async sendAlert(message: string): Promise<void> {
    await this.sendMessage(`⚠️ *PERINGATAN*\n\n${message}`);
  }

  async sendInfo(message: string): Promise<void> {
    await this.sendMessage(`ℹ️ ${message}`);
  }

  /**
   * Kirim gambar dengan keterangan.
   *
   * Dipakai untuk chart: satu gambar dengan garis support/resistance menjawab
   * "apakah angka ini masuk akal" seketika, sesuatu yang deretan angka tidak
   * pernah bisa lakukan tanpa membuka aplikasi lain.
   *
   * Caption Telegram dibatasi 1024 karakter — lebih dari itu seluruh permintaan
   * ditolak, bukan dipotong, jadi pemotongan dilakukan di sini.
   */
  async sendPhoto(image: Buffer, caption = '', chatId?: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.debug(`[Telegram nonaktif] (gambar) ${caption.split('\n')[0]}`);
      return false;
    }

    try {
      const fields: Record<string, string> = { chat_id: chatId ?? this.chatId };
      if (caption) {
        fields.caption = caption.length > 1024 ? caption.slice(0, 1021) + '…' : caption;
        fields.parse_mode = 'Markdown';
      }

      const { body, boundary } = buildMultipart(fields, {
        name: 'photo',
        filename: 'chart.png',
        contentType: 'image/png',
        data: image,
      });

      await axios.post(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, body, {
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        timeout: 30000,
        maxBodyLength: Infinity,
      });
      return true;
    } catch (err) {
      const description = err?.response?.data?.description ?? err.message;
      this.logger.error(`Gagal mengirim gambar ke Telegram: ${description}`);
      return false;
    }
  }

  /**
   * Kirim chart; bila pengiriman gambar gagal, keterangannya tetap dikirim
   * sebagai teks. Notifikasi trade terlalu penting untuk hilang hanya karena
   * penggambarnya bermasalah.
   */
  async sendChart(image: Buffer | null, caption: string): Promise<void> {
    if (image && (await this.sendPhoto(image, caption))) return;
    await this.sendMessage(caption);
  }

  async sendRaw(message: string): Promise<void> {
    await this.sendMessage(message);
  }
}

/**
 * Susun badan multipart/form-data dari field teks dan satu berkas.
 *
 * Ditulis sendiri, bukan memakai FormData global: tipe DOM `Blob` tidak
 * menerima `Buffer` maupun `Uint8Array` pada konfigurasi TypeScript proyek ini,
 * dan menambahkan dependensi form-data hanya untuk satu panggilan tidak
 * sepadan. Formatnya sederhana dan seluruhnya ada di sini.
 */
function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; filename: string; contentType: string; data: Buffer },
): { body: Buffer; boundary: string } {
  const boundary = `----indodaxbot${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
          `${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
    file.data,
    Buffer.from('\r\n', 'utf8'),
  );

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { body: Buffer.concat(parts), boundary };
}
