/**
 * Tipe untuk lapisan News Intelligence (LEVEL 5 roadmap).
 *
 * BATAS YANG HARUS DIPAHAMI SEBELUM MEMPERCAYAI LAPISAN INI:
 *
 * Sentimen di sini dihitung dari JUDUL berita memakai kamus kata, bukan model
 * bahasa. Itu pilihan sadar — hasilnya deterministik, bisa diuji, gratis, dan
 * tidak pernah mengarang. Tetapi ia juga kasar: sarkasme, bantahan, dan konteks
 * ("BTC gagal menembus resistance" vs "BTC gagal jatuh") sering salah dibaca.
 *
 * Karena itu skor berita dipakai untuk MENAHAN entry saat beritanya jelas
 * buruk, bukan untuk membeli saat beritanya terlihat bagus. Dua hal ini tidak
 * simetris: berita buruk cenderung langsung menggerakkan harga, berita baik
 * sering sudah tercermin di harga sebelum kita membacanya.
 */

export type NewsSentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
export type NewsImpact = 'HIGH' | 'MEDIUM' | 'LOW';

/** Kategori untuk memisahkan berita makro dari berita satu koin. */
export type NewsCategory = 'MACRO' | 'CRYPTO' | 'COIN' | 'REGULATION' | 'SECURITY';

export interface NewsSource {
  id: string;
  label: string;
  url: string;
  category: NewsCategory;
  /**
   * Tingkat kepercayaan sumber, 1 (tertinggi) sampai 3.
   *
   * Dipakai dalam penilaian dampak: kabar dari rilis resmi bergerak di pasar
   * dengan cara yang berbeda dari rangkuman blog. Ini penilaian editorial,
   * bukan hasil pengukuran.
   */
  tier: 1 | 2 | 3;
  enabled: boolean;
}

/** Satu berita setelah diproses. */
export interface NewsItem {
  /** Hash stabil dari judul — dipakai untuk membuang duplikat antar sumber. */
  id: string;
  title: string;
  link: string;
  /** Nama penerbit sebenarnya, bukan nama feed. */
  publisher: string;
  sourceId: string;
  publishedAt: string;
  /** Umur berita dalam jam saat diproses. */
  ageHours: number;
  category: NewsCategory;
  sentiment: NewsSentiment;
  /** -100 sampai +100. */
  sentimentScore: number;
  /** Kata yang memicu penilaian, agar hasilnya bisa diperiksa manusia. */
  matchedTerms: string[];
  impact: NewsImpact;
  /** Simbol koin yang disebut, huruf kecil (mis. "btc"). */
  affectedCoins: string[];
  /** True bila judulnya menyangkut seluruh pasar, bukan satu koin. */
  marketWide: boolean;
}

/** Ringkasan berita untuk satu koin atau untuk pasar secara keseluruhan. */
export interface NewsAssessment {
  /** Koin yang dinilai, atau null untuk penilaian pasar. */
  coin: string | null;
  /**
   * 0-100, di mana 50 berarti netral.
   *
   * Dipusatkan di 50 — bukan 0 — agar sejalan dengan skor lain di sistem ini
   * dan agar "tidak ada berita" tidak terbaca sebagai "berita buruk".
   */
  score: number;
  sentiment: NewsSentiment;
  impact: NewsImpact;
  items: NewsItem[];
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  /**
   * True bila tidak ada berita yang cukup baru untuk dinilai.
   *
   * Harus dibedakan dari "berita netral": tidak tahu bukan sama dengan aman.
   */
  inconclusive: boolean;
  caveat: string;
  assessedAt: string;
}

export const NEWS_CAVEAT =
  'Sentimen dihitung dari judul memakai kamus kata, bukan model bahasa — ' +
  'sarkasme dan bantahan bisa salah dibaca. Dipakai untuk menahan entry, ' +
  'bukan untuk alasan membeli.';

/**
 * Sumber berita bawaan.
 *
 * Diverifikasi hidup pada 2026-10-07. Reuters RSS SUDAH DIMATIKAN oleh Reuters
 * (membalas 0 item) dan karena itu tidak dimasukkan — mendaftarkannya hanya
 * akan membuat lapisan ini tampak punya sumber yang sebenarnya tidak ada.
 *
 * Google News dipakai sebagai mesin pencari, bukan sekadar feed: kuerinya bisa
 * disesuaikan per koin sehingga satu sumber melayani seluruh pair tanpa perlu
 * feed khusus untuk masing-masing.
 */
export const DEFAULT_NEWS_SOURCES: NewsSource[] = [
  {
    id: 'coindesk',
    label: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'CRYPTO',
    tier: 1,
    enabled: true,
  },
  {
    id: 'cointelegraph',
    label: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    category: 'CRYPTO',
    tier: 2,
    enabled: true,
  },
  {
    id: 'gnews-macro',
    label: 'Google News — Makro',
    url:
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent('Federal Reserve OR "interest rate" OR inflation OR CPI when:2d') +
      '&hl=en-US&gl=US&ceid=US:en',
    category: 'MACRO',
    tier: 2,
    enabled: true,
  },
  {
    id: 'gnews-regulation',
    label: 'Google News — Regulasi',
    url:
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent('crypto regulation OR SEC crypto OR OJK kripto when:3d') +
      '&hl=en-US&gl=US&ceid=US:en',
    category: 'REGULATION',
    tier: 2,
    enabled: true,
  },
  {
    id: 'theblock',
    label: 'The Block',
    url: 'https://www.theblock.co/rss.xml',
    category: 'CRYPTO',
    tier: 1,
    enabled: true,
  },
  {
    id: 'blockworks',
    label: 'Blockworks',
    url: 'https://blockworks.co/feed',
    category: 'CRYPTO',
    tier: 2,
    enabled: true,
  },
  {
    /**
     * Peristiwa bursa — temuan paling berharga dari pengujian sumber.
     *
     * Kueri ini memakai kata KEJADIAN, bukan nama koin, dan itu yang membuat
     * bedanya: ia mengembalikan "Binance Delisting Knocks 2 Altcoins Down 10%"
     * dan "Binance delisting sends QUICK down 20%" -- peristiwa yang bisa
     * menghabisi posisi memecoin dalam hitungan menit, dan tidak terdeteksi
     * oleh indikator teknikal mana pun sebelum harganya sudah jatuh.
     */
    id: 'gnews-exchange',
    label: 'Google News — Peristiwa Bursa',
    url:
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent(
        '(Binance OR Coinbase OR Indodax) (listing OR delisting OR halt OR suspend OR hack) when:2d',
      ) +
      '&hl=en-US&gl=US&ceid=US:en',
    category: 'CRYPTO',
    tier: 1,
    enabled: true,
  },
  {
    /**
     * Kebijakan kripto Indonesia.
     *
     * Bot ini berdagang di Indodax, dan keputusan Bappebti/OJK nyaris tidak
     * pernah muncul di feed berbahasa Inggris. Kuerinya MEWAJIBKAN frasa
     * "aset kripto": versi yang hanya memakai kata OJK mengembalikan empat
     * berita berturut-turut tentang pencabutan izin perusahaan modal ventura
     * -- cocok katanya, salah topiknya.
     *
     * Sumber ini baru berguna setelah kamus Bahasa Indonesia ditambahkan;
     * sebelumnya seluruh judulnya dinilai netral.
     */
    id: 'gnews-id',
    label: 'Google News — Kripto Indonesia',
    url:
      'https://news.google.com/rss/search?q=' +
      encodeURIComponent('"aset kripto" (aturan OR izin OR pajak OR larangan OR bursa) when:7d') +
      '&hl=id&gl=ID&ceid=ID:id',
    category: 'REGULATION',
    tier: 2,
    enabled: true,
  },
];

/**
 * Sumber yang SUDAH DIUJI dan SENGAJA tidak dipakai, beserta alasannya.
 *
 * Diukur lewat RssClient bot sendiri pada 2026-10-14. Dicatat supaya tidak
 * ditambahkan kembali oleh orang yang menganggapnya terlewat:
 *
 *   cryptoslate       — HTTP 403, menolak permintaan kita.
 *   coingape          — HTTP 403.
 *   bitcoinmagazine   — tidak membalas sama sekali (timeout).
 *   u.today           — hidup, 98 item, tetapi isinya "Price Prediction" dan
 *                       kabar whale. Judul begini dinilai kamus seolah punya
 *                       arah, padahal tidak memuat peristiwa apa pun.
 *   decrypt           — hidup, 33 item, tetapi dua teratas tentang OpenAI dan
 *                       Character.AI. Decrypt meliput AI sebanyak kripto.
 *   gnews-memecoin    — hidup, 100 item, nyaris seluruhnya laman harga dan
 *                       iklan: "Hunter Biden's Laptop price today", "Your
 *                       Easiest Way to Crypto". Nama koin sebagai kueri
 *                       menarik konten SEO, bukan kabar.
 */
export const REJECTED_NEWS_SOURCES = [
  'cryptoslate',
  'coingape',
  'bitcoinmagazine',
  'u.today',
  'decrypt',
  'gnews-memecoin',
] as const;

/** Templat kueri untuk berita satu koin. `%s` diganti nama koin. */
export const COIN_QUERY_TEMPLATE =
  'https://news.google.com/rss/search?q=%s&hl=en-US&gl=US&ceid=US:en';
