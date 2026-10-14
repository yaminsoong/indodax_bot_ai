import { NewsService } from './news.service';
import { RssClient } from './rss.client';
import { SentimentService } from './sentiment.service';
import { CoinMatcherService } from './coin-matcher.service';
import { AiSentimentService } from './ai-sentiment.service';
import { NewsItem } from './news.types';

describe('Penilaian berita', () => {
  let svc: NewsService;

  beforeEach(() => {
    // AI dimatikan: suite ini menguji penilaian kamus, dan jalur AI punya
    // spec-nya sendiri di ai-sentiment.spec.ts.
    const aiOff = new AiSentimentService(
      { isAvailable: () => false, tryComplete: async () => null } as any,
      new SentimentService(),
      { get: (_k: string, d: string) => d } as any,
    );
    svc = new NewsService(new RssClient(), new SentimentService(), new CoinMatcherService(), aiOff);
  });

  const item = (over: Partial<NewsItem> = {}): NewsItem => ({
    id: Math.random().toString(36).slice(2),
    title: 'judul',
    link: 'https://contoh/1',
    publisher: 'Contoh',
    sourceId: 'test',
    publishedAt: new Date().toISOString(),
    ageHours: 1,
    category: 'CRYPTO',
    sentiment: 'NEUTRAL',
    sentimentScore: 0,
    matchedTerms: [],
    impact: 'LOW',
    affectedCoins: [],
    marketWide: false,
    ...over,
  });

  // ─── Tidak tahu vs netral ────────────────────────────────────────────────

  it('tanpa berita menghasilkan TIDAK TAHU, bukan aman', () => {
    // Pembedaan ini penting: lapisan di atasnya tidak boleh menyimpulkan
    // "berita aman" dari "tidak ada berita".
    const r = svc.score('btc', []);
    expect(r.inconclusive).toBe(true);
    expect(r.score).toBe(50);
    expect(r.caveat).toMatch(/TIDAK TAHU/i);
  });

  it('berita yang semuanya netral juga TIDAK TAHU', () => {
    const r = svc.score('btc', [item(), item()]);
    expect(r.inconclusive).toBe(true);
    expect(r.score).toBe(50);
  });

  // ─── Arah skor ───────────────────────────────────────────────────────────

  it('berita negatif menurunkan skor di bawah 50', () => {
    const r = svc.score('btc', [item({ sentiment: 'NEGATIVE', sentimentScore: -60 })]);
    expect(r.score).toBeLessThan(50);
    expect(r.sentiment).toBe('NEGATIVE');
  });

  it('berita positif menaikkan skor di atas 50', () => {
    const r = svc.score('btc', [item({ sentiment: 'POSITIVE', sentimentScore: 60 })]);
    expect(r.score).toBeGreaterThan(50);
    expect(r.sentiment).toBe('POSITIVE');
  });

  it('berita berlawanan saling meredam', () => {
    const r = svc.score('btc', [
      item({ sentiment: 'POSITIVE', sentimentScore: 50, ageHours: 1 }),
      item({ sentiment: 'NEGATIVE', sentimentScore: -50, ageHours: 1 }),
    ]);
    expect(r.score).toBe(50);
  });

  // ─── Peluruhan umur ──────────────────────────────────────────────────────

  it('berita baru lebih berpengaruh daripada berita lama', () => {
    const baru = svc.score('btc', [item({ sentiment: 'NEGATIVE', sentimentScore: -80, ageHours: 0 })]);
    const lama = svc.score('btc', [item({ sentiment: 'NEGATIVE', sentimentScore: -80, ageHours: 36 })]);
    // Keduanya negatif, tetapi yang lama tidak boleh menahan sekuat yang baru.
    expect(baru.score).toBeLessThan(50);
    expect(lama.score).toBeLessThan(50);
    expect(lama.score).toBeGreaterThanOrEqual(baru.score);
  });

  it('kabar buruk baru mengalahkan kabar baik lama', () => {
    const r = svc.score('btc', [
      item({ sentiment: 'POSITIVE', sentimentScore: 70, ageHours: 40 }),
      item({ sentiment: 'NEGATIVE', sentimentScore: -70, ageHours: 0.5 }),
    ]);
    expect(r.score).toBeLessThan(50);
  });

  // ─── Bobot dampak ────────────────────────────────────────────────────────

  it('berita HIGH impact lebih berpengaruh daripada LOW', () => {
    const tinggi = svc.score('btc', [
      item({ sentiment: 'NEGATIVE', sentimentScore: -50, impact: 'HIGH' }),
      item({ sentiment: 'POSITIVE', sentimentScore: 50, impact: 'LOW' }),
    ]);
    expect(tinggi.score).toBeLessThan(50);
  });

  it('melaporkan dampak tertinggi di antara seluruh berita', () => {
    const r = svc.score('btc', [item({ impact: 'LOW' }), item({ impact: 'HIGH' })]);
    expect(r.impact).toBe('HIGH');
  });

  // ─── Pencacahan ──────────────────────────────────────────────────────────

  it('menghitung positif, negatif, dan netral secara terpisah', () => {
    const r = svc.score('btc', [
      item({ sentiment: 'POSITIVE', sentimentScore: 30 }),
      item({ sentiment: 'POSITIVE', sentimentScore: 30 }),
      item({ sentiment: 'NEGATIVE', sentimentScore: -30 }),
      item(),
    ]);
    expect(r.positiveCount).toBe(2);
    expect(r.negativeCount).toBe(1);
    expect(r.neutralCount).toBe(1);
  });

  it('skor tetap dalam 0..100 untuk masukan ekstrem', () => {
    const buruk = svc.score('btc', Array.from({ length: 20 }, () =>
      item({ sentiment: 'NEGATIVE', sentimentScore: -100, impact: 'HIGH', ageHours: 0 }),
    ));
    expect(buruk.score).toBeGreaterThanOrEqual(0);
    expect(buruk.score).toBeLessThanOrEqual(100);
  });

  it('selalu membawa peringatan tentang keterbatasan kamus kata', () => {
    const r = svc.score('btc', [item({ sentiment: 'NEGATIVE', sentimentScore: -40 })]);
    expect(r.caveat).toMatch(/kamus kata/i);
  });
});

/**
 * Parser RSS ditulis sendiri untuk menghindari dependensi tambahan, jadi
 * tanggung jawab atas CDATA, entity HTML, dan Atom ada di sini — bukan di
 * pustaka pihak ketiga yang sudah teruji.
 */
describe('RssClient.parse', () => {
  let rss: RssClient;

  beforeEach(() => {
    rss = new RssClient();
  });

  it('membaca item RSS biasa', () => {
    const items = rss.parse(`<rss><channel>
      <item><title>Bitcoin naik</title><link>https://a/1</link>
      <pubDate>Tue, 06 Oct 2026 04:48:34 GMT</pubDate></item>
    </channel></rss>`);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Bitcoin naik');
    expect(items[0].link).toBe('https://a/1');
  });

  it('membuka CDATA', () => {
    const items = rss.parse('<item><title><![CDATA[ETH & BTC rally]]></title></item>');
    expect(items[0].title).toBe('ETH & BTC rally');
  });

  it('membuka entity HTML sebelum penilaian sentimen', () => {
    // Tanpa ini, pencocokan kata gagal pada judul seperti "Fed&#39;s decision".
    const items = rss.parse('<item><title>Fed&#39;s rate cut &amp; markets</title></item>');
    expect(items[0].title).toBe("Fed's rate cut & markets");
  });

  it('&amp; dibuka terakhir agar &amp;#39; tidak menjadi kutip', () => {
    const items = rss.parse('<item><title>harga &amp;#39; literal</title></item>');
    expect(items[0].title).toBe("harga &#39; literal");
  });

  it('mengambil penerbit dari tag source Google News', () => {
    const items = rss.parse(
      '<item><title>Berita - CoinDesk</title><source url="https://coindesk.com">CoinDesk</source></item>',
    );
    expect(items[0].publisher).toBe('CoinDesk');
  });

  it('membaca Atom entry dengan link di atribut href', () => {
    const items = rss.parse(
      '<feed><entry><title>Judul Atom</title><link href="https://b/2"/><updated>2026-10-06T00:00:00Z</updated></entry></feed>',
    );
    expect(items[0].title).toBe('Judul Atom');
    expect(items[0].link).toBe('https://b/2');
  });

  it('melewati item tanpa judul alih-alih membuat entri kosong', () => {
    expect(rss.parse('<item><link>https://a/1</link></item>')).toHaveLength(0);
  });

  it('XML kosong atau rusak menghasilkan daftar kosong, tidak melempar', () => {
    expect(rss.parse('')).toEqual([]);
    expect(rss.parse('bukan xml sama sekali')).toEqual([]);
  });

  it('membaca banyak item sekaligus', () => {
    const xml = Array.from({ length: 5 }, (_, i) => `<item><title>Judul ${i}</title></item>`).join('');
    expect(rss.parse(xml)).toHaveLength(5);
  });
});
