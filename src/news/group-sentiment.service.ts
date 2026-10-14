import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SentimentService } from './sentiment.service';

/** Satu pesan grup yang sudah dinilai. */
interface GroupMessage {
  chatId: string;
  chatTitle: string;
  text: string;
  score: number;
  at: number;
}

export interface GroupSentimentResult {
  /** Jumlah grup yang benar-benar mengirim pesan dalam jendela waktu. */
  activeGroups: number;
  messageCount: number;
  positiveCount: number;
  negativeCount: number;
  /** Rata-rata skor pesan yang berarah, 0 bila tidak ada. */
  averageScore: number;
  /**
   * Koin yang paling banyak disebut, beserta jumlah sebutannya.
   *
   * Lonjakan sebutan mendadak adalah tanda FOMO, bukan tanda peluang — dan
   * itulah satu-satunya hal yang layak diambil dari grup.
   */
  mentions: Array<{ coin: string; count: number }>;
  /** Alasan sinyal ini TIDAK boleh dipercaya sebagai dasar beli. */
  caveat: string;
  /** True bila datanya terlalu sedikit untuk disimpulkan. */
  inconclusive: boolean;
}

/** Berapa lama pesan grup dianggap masih relevan. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/** Batas pesan yang disimpan, agar memori tidak tumbuh tanpa batas. */
const MAX_MESSAGES = 500;

/**
 * Jumlah sebutan minimum sebelum sebuah koin dilaporkan.
 *
 * Satu orang menyebut sebuah koin bukan sentimen; itu satu orang.
 */
const MIN_MENTIONS = 3;

/**
 * Sentimen dari grup Telegram yang bot ikuti.
 *
 * TIGA SIFAT YANG MENENTUKAN, dan tidak boleh dilanggar:
 *
 * 1. **Hanya menolak.** Isi grup TIDAK PERNAH boleh memicu atau memperkuat
 *    keputusan beli. Grup sinyal kripto adalah tempat pump-and-dump bekerja:
 *    orang yang sudah memegang koin meneriakkannya supaya orang lain membeli
 *    dari mereka. Memakai itu sebagai alasan masuk berarti menjadi pihak yang
 *    membeli di puncak.
 *
 * 2. **Grup yang diamati tidak bisa memerintah bot.** Gerbang perintah di
 *    NotificationService tetap hanya menerima chat yang dikonfigurasi. Layanan
 *    ini hanya MEMBACA, dan tidak punya jalur apa pun ke eksekusi order.
 *
 * 3. **Isinya data, bukan instruksi.** Pesan grup ditulis oleh orang asing
 *    yang tidak dikenal. Bila teksnya dikirim ke model bahasa, ia harus
 *    dinyatakan sebagai bahan yang dinilai — bukan sebagai perintah.
 *
 * Nilai sebenarnya dari lapisan ini bukan "apa yang direkomendasikan grup",
 * melainkan "seberapa ramai sebuah koin dibicarakan" — karena keramaian
 * mendadak menandakan harga sudah bergerak sebelum kita, bukan akan bergerak.
 */
@Injectable()
export class GroupSentimentService {
  private readonly logger = new Logger(GroupSentimentService.name);
  private messages: GroupMessage[] = [];
  private warnedUnwatched = new Set<string>();

  constructor(
    private readonly lexicon: SentimentService,
    private readonly config: ConfigService,
  ) {}

  /** Daftar chat id grup yang diamati, dari TELEGRAM_WATCH_GROUPS. */
  watchedGroups(): string[] {
    return (this.config.get<string>('TELEGRAM_WATCH_GROUPS', '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  isEnabled(): boolean {
    return this.watchedGroups().length > 0;
  }

  isWatched(chatId: string): boolean {
    return this.watchedGroups().includes(String(chatId));
  }

  /**
   * Catat satu pesan grup.
   *
   * Dipanggil dari jalur polling Telegram untuk chat yang diamati SAJA.
   * Mengembalikan false bila pesan diabaikan, agar pemanggil tidak perlu
   * mengulang pemeriksaan yang sama.
   */
  observe(chatId: string, chatTitle: string, text: string): boolean {
    const id = String(chatId);
    if (!this.isWatched(id)) {
      // Dicatat sekali per chat: tanpa ini, satu grup ramai akan membanjiri
      // log dengan peringatan yang sama.
      if (!this.warnedUnwatched.has(id)) {
        this.warnedUnwatched.add(id);
        this.logger.debug(`Pesan dari grup tidak diamati diabaikan: ${id}`);
      }
      return false;
    }

    const clean = (text ?? '').trim();
    if (!clean || clean.startsWith('/')) return false;

    const { score } = this.lexicon.analyze(clean);

    this.messages.push({
      chatId: id,
      chatTitle: chatTitle || id,
      text: clean.slice(0, 300),
      score,
      at: Date.now(),
    });

    // Buang yang kedaluwarsa dan tahan panjangnya.
    this.prune();
    return true;
  }

  /**
   * Nilai sentimen grup dalam jendela waktu.
   *
   * `universe` adalah daftar simbol koin yang dicari sebutannya, misalnya
   * ['btc', 'doge', 'pepe'].
   */
  assess(universe: string[] = []): GroupSentimentResult {
    this.prune();

    const msgs = this.messages;
    const directed = msgs.filter((m) => m.score !== 0);

    const positiveCount = directed.filter((m) => m.score > 0).length;
    const negativeCount = directed.filter((m) => m.score < 0).length;
    const averageScore = directed.length
      ? Math.round(directed.reduce((a, m) => a + m.score, 0) / directed.length)
      : 0;

    const counts = new Map<string, number>();
    if (universe.length) {
      for (const m of msgs) {
        const lower = m.text.toLowerCase();
        for (const coin of universe) {
          const c = coin.toLowerCase();
          if (!c) continue;
          // Batas kata supaya "sol" tidak cocok dengan "solusi".
          if (new RegExp(`(^|[^a-z0-9])${c}([^a-z0-9]|$)`).test(lower)) {
            counts.set(c, (counts.get(c) ?? 0) + 1);
          }
        }
      }
    }

    const mentions = [...counts.entries()]
      .filter(([, n]) => n >= MIN_MENTIONS)
      .map(([coin, count]) => ({ coin, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return {
      activeGroups: new Set(msgs.map((m) => m.chatId)).size,
      messageCount: msgs.length,
      positiveCount,
      negativeCount,
      averageScore,
      mentions,
      caveat:
        'Isi grup ditulis orang asing yang kepentingannya tidak diketahui. ' +
        'Keramaian menandakan harga sudah bergerak, bukan akan bergerak. ' +
        'Lapisan ini HANYA boleh menurunkan keyakinan, tidak pernah menaikkan.',
      // Di bawah 10 pesan, hitungan positif/negatif tidak berarti apa pun.
      inconclusive: msgs.length < 10,
    };
  }

  /** Pesan terbaru yang berarah, untuk ditampilkan sebagai bahan. */
  recentDirected(limit = 5): Array<{ chatTitle: string; text: string; score: number; hoursAgo: number }> {
    this.prune();
    return this.messages
      .filter((m) => m.score !== 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((m) => ({
        chatTitle: m.chatTitle,
        text: m.text,
        score: m.score,
        hoursAgo: Math.round(((Date.now() - m.at) / 3600_000) * 10) / 10,
      }));
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.messages = this.messages.filter((m) => m.at >= cutoff);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
  }
}
