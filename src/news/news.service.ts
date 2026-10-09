import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RssClient, RssItem } from './rss.client';
import { SentimentService } from './sentiment.service';
import { CoinMatcherService } from './coin-matcher.service';
import { AiSentimentService } from './ai-sentiment.service';
import {
  COIN_QUERY_TEMPLATE,
  DEFAULT_NEWS_SOURCES,
  NEWS_CAVEAT,
  NewsAssessment,
  NewsImpact,
  NewsItem,
  NewsSentiment,
  NewsSource,
} from './news.types';

/**
 * Berita lebih tua dari ini tidak lagi dinilai.
 *
 * Harga sudah selesai menyerap kabar dua hari lalu. Memasukkannya hanya
 * membuat skor berita bergerak lambat dan salah fase terhadap pasar.
 */
const MAX_AGE_HOURS = 48;

/** Berita sangat baru diberi bobot lebih besar; pengaruhnya memudar. */
const HALF_LIFE_HOURS = 12;

const CACHE_TTL_MS = 10 * 60_000;

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private readonly cache = new Map<string, { at: number; value: NewsAssessment }>();
  private readonly inFlight = new Map<string, Promise<NewsAssessment>>();

  constructor(
    private readonly rss: RssClient,
    private readonly sentiment: SentimentService,
    private readonly coins: CoinMatcherService,
    private readonly aiSentiment: AiSentimentService,
  ) {}

  /** Penilaian berita tingkat pasar dari seluruh sumber bawaan. */
  async assessMarket(universe: string[] = ['btc', 'eth'], sources = DEFAULT_NEWS_SOURCES): Promise<NewsAssessment> {
    return this.cached('__market__', async () => {
      const items = await this.collect(sources, universe);
      return this.score(null, items);
    });
  }

  /**
   * Penilaian berita untuk satu koin.
   *
   * Memakai Google News sebagai mesin pencari agar satu sumber melayani seluruh
   * pair — menambah pair baru tidak memerlukan feed baru.
   */
  async assessCoin(symbol: string): Promise<NewsAssessment> {
    const coin = symbol.toLowerCase();
    return this.cached(coin, async () => {
      const source: NewsSource = {
        id: `gnews-${coin}`,
        label: `Google News — ${coin.toUpperCase()}`,
        url: COIN_QUERY_TEMPLATE.replace('%s', encodeURIComponent(this.queryFor(coin))),
        category: 'COIN',
        tier: 2,
        enabled: true,
      };
      const items = await this.collect([source], [coin]);
      // Hanya berita yang benar-benar menyebut koin ini; hasil pencarian
      // Google rutin menyertakan kabar tetangga yang tidak relevan.
      return this.score(coin, items.filter((i) => i.affectedCoins.includes(coin)));
    });
  }

  /** Kueri pencarian untuk sebuah koin, mencakup nama panjang dan tickernya. */
  private queryFor(coin: string): string {
    const extra: Record<string, string> = {
      btc: 'Bitcoin BTC',
      eth: 'Ethereum ETH',
      sol: 'Solana SOL',
      xrp: 'XRP Ripple',
      bnb: 'BNB Binance',
      doge: 'Dogecoin DOGE',
    };
    const terms = extra[coin] ?? `${coin.toUpperCase()} crypto`;
    return `${terms} when:2d`;
  }

  // ─── Pengumpulan ──────────────────────────────────────────────────────────

  private async collect(sources: NewsSource[], universe: string[]): Promise<NewsItem[]> {
    const active = sources.filter((s) => s.enabled);

    const settled = await Promise.allSettled(
      active.map(async (s) => ({ source: s, items: await this.rss.fetch(s.url) })),
    );

    const byId = new Map<string, NewsItem>();

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'rejected') {
        this.logger.warn(`Feed ${active[i].label} gagal: ${outcome.reason?.message ?? outcome.reason}`);
        continue;
      }

      const { source, items } = outcome.value;
      for (const raw of items) {
        const item = this.toNewsItem(raw, source, universe);
        if (!item) continue;
        // Satu kabar sering muncul di beberapa feed. Yang paling awal
        // dipertahankan agar waktu terbitnya tidak bergeser.
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
    }

    const items = [...byId.values()].sort((a, b) => a.ageHours - b.ageHours);
    return this.rescoreWithAi(items, universe);
  }

  /**
   * Nilai ulang judul penting dengan AI, bila AI tersedia.
   *
   * Hanya judul yang bisa mengubah keputusan yang dikirim — berdampak
   * MEDIUM/HIGH atau menyebut koin yang sedang dipertimbangkan. Dari pengukuran
   * nyata, itu sekitar 20 dari 159 judul per pemindaian.
   *
   * Bila AI mati, tidak terkonfigurasi, atau membalas tanpa skor yang bisa
   * dibaca, seluruh item tetap memakai nilai kamusnya. Tidak ada jalur di sini
   * yang bisa membuat pemindaian berita gagal karena layanan pihak ketiga.
   */
  private async rescoreWithAi(items: NewsItem[], universe: string[]): Promise<NewsItem[]> {
    if (!items.length || !this.aiSentiment.isEnabled()) return items;

    const picked = this.aiSentiment.selectForRescoring(items, universe);
    if (!picked.length) return items;

    const scores = await this.aiSentiment.rescore(picked.map((i) => items[i].title));
    if (!scores.size) return items;

    // `scores` berindeks pada daftar yang DIKIRIM, bukan pada `items`.
    // Memetakannya langsung akan menempelkan skor ke judul yang salah.
    for (const [sentIndex, score] of scores) {
      const itemIndex = picked[sentIndex];
      if (itemIndex === undefined) continue;

      const item = items[itemIndex];
      const merged = this.aiSentiment.merge(
        { score: item.sentimentScore, sentiment: item.sentiment, matchedTerms: item.matchedTerms },
        score,
      );

      item.sentiment = merged.sentiment;
      item.sentimentScore = merged.score;
      item.matchedTerms = merged.matchedTerms;
      // Dampak ikut dihitung ulang: skor baru bisa mengubah kelasnya.
      item.impact = this.sentiment.impactOf(item.title, merged.score, 2);
    }

    this.logger.log(`AI menilai ulang ${scores.size} dari ${items.length} judul`);
    return items;
  }

  private toNewsItem(raw: RssItem, source: NewsSource, universe: string[]): NewsItem | null {
    const published = new Date(raw.pubDate);
    if (Number.isNaN(published.getTime())) return null;

    const ageHours = (Date.now() - published.getTime()) / 3_600_000;
    if (ageHours > MAX_AGE_HOURS) return null;
    // Waktu terbit di masa depan menandakan feed atau jam yang salah; menerima
    // ini akan memberi bobot terbesar justru pada data yang paling meragukan.
    if (ageHours < -2) return null;

    // Google News menempelkan " - Penerbit" di akhir judul. Itu dibuang dari
    // teks yang dinilai, bukan dibiarkan ikut mempengaruhi sentimen.
    const { title, publisherFromTitle } = splitPublisher(raw.title);

    const s = this.sentiment.analyze(title);

    return {
      id: createHash('sha1').update(normalizeTitle(title)).digest('hex').slice(0, 16),
      title,
      link: raw.link,
      publisher: raw.publisher ?? publisherFromTitle ?? source.label,
      sourceId: source.id,
      publishedAt: published.toISOString(),
      ageHours: Math.max(0, Math.round(ageHours * 10) / 10),
      category: source.category,
      sentiment: s.sentiment,
      sentimentScore: s.score,
      matchedTerms: s.matchedTerms,
      impact: this.sentiment.impactOf(title, s.score, source.tier),
      affectedCoins: this.coins.match(title, universe),
      marketWide: this.coins.isMarketWide(title),
    };
  }

  // ─── Penilaian ────────────────────────────────────────────────────────────

  /**
   * Gabungkan beberapa berita menjadi satu skor 0-100 berpusat di 50.
   *
   * Pembobotan memakai dua pengali: umur (memudar separuh tiap 12 jam) dan
   * dampak. Tanpa peluruhan umur, kabar dua hari lalu menahan entry hari ini.
   *
   * Dipisah dari pengambilan agar bisa diuji tanpa jaringan.
   */
  score(coin: string | null, items: NewsItem[]): NewsAssessment {
    const relevant = items.filter((i) => i.sentiment !== 'NEUTRAL');

    let weighted = 0;
    let totalWeight = 0;

    for (const item of relevant) {
      const recency = Math.pow(0.5, item.ageHours / HALF_LIFE_HOURS);
      const impactWeight = item.impact === 'HIGH' ? 3 : item.impact === 'MEDIUM' ? 2 : 1;
      const weight = recency * impactWeight;

      weighted += (item.sentimentScore / 100) * weight;
      totalWeight += weight;
    }

    const positiveCount = items.filter((i) => i.sentiment === 'POSITIVE').length;
    const negativeCount = items.filter((i) => i.sentiment === 'NEGATIVE').length;
    const neutralCount = items.filter((i) => i.sentiment === 'NEUTRAL').length;

    // Tidak ada berita berarti TIDAK TAHU. Dibedakan dari netral: netral
    // adalah kesimpulan, tidak tahu adalah ketiadaan kesimpulan.
    const inconclusive = totalWeight === 0;

    const score = inconclusive
      ? 50
      : Math.round(Math.max(0, Math.min(100, 50 + (weighted / totalWeight) * 50)));

    const sentiment: NewsSentiment =
      inconclusive || (score > 40 && score < 60) ? 'NEUTRAL' : score >= 60 ? 'POSITIVE' : 'NEGATIVE';

    return {
      coin,
      score,
      sentiment,
      impact: highestImpact(items),
      items,
      positiveCount,
      negativeCount,
      neutralCount,
      inconclusive,
      caveat: inconclusive
        ? `Tidak ada berita berarah dalam ${MAX_AGE_HOURS} jam terakhir — ` +
          `diperlakukan sebagai TIDAK TAHU, bukan aman. ${NEWS_CAVEAT}`
        : NEWS_CAVEAT,
      assessedAt: new Date().toISOString(),
    };
  }

  private async cached(key: string, build: () => Promise<NewsAssessment>): Promise<NewsAssessment> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const running = this.inFlight.get(key);
    if (running) return running;

    const promise = build()
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }
}

function highestImpact(items: NewsItem[]): NewsImpact {
  if (items.some((i) => i.impact === 'HIGH')) return 'HIGH';
  if (items.some((i) => i.impact === 'MEDIUM')) return 'MEDIUM';
  return 'LOW';
}

/** Pisahkan " - Penerbit" yang ditempelkan Google News di akhir judul. */
function splitPublisher(title: string): { title: string; publisherFromTitle: string | null } {
  const at = title.lastIndexOf(' - ');
  if (at <= 0 || at < title.length - 60) return { title, publisherFromTitle: null };
  return {
    title: title.slice(0, at).trim(),
    publisherFromTitle: title.slice(at + 3).trim() || null,
  };
}

/** Judul yang sama dari dua feed sering berbeda tanda baca dan kapitalisasi. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
