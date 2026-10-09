import { CompositeScoreService, CompositeInput } from './composite-score.service';
import { NewsAssessment } from '../../news/news.types';
import { GlobalRiskAssessment } from '../../global-market/global-market.types';

/**
 * Sifat terpenting lapisan ini: berita bagus dan makro tenang TIDAK BOLEH
 * menaikkan setup teknikal yang lemah, sementara berita buruk HARUS bisa
 * membatalkan setup teknikal yang kuat.
 *
 * Asimetri itu bukan preferensi gaya. Berita positif tidak mengatakan apa pun
 * tentang di mana harga berada relatif terhadap struktur, stop, dan target —
 * sedangkan kabar peretasan membatalkan semuanya sekaligus.
 */
describe('Composite score', () => {
  let svc: CompositeScoreService;

  beforeEach(() => {
    svc = new CompositeScoreService();
  });

  const news = (over: Partial<NewsAssessment> = {}): NewsAssessment => ({
    coin: 'btc',
    score: 50,
    sentiment: 'NEUTRAL',
    impact: 'LOW',
    items: [],
    positiveCount: 0,
    negativeCount: 0,
    neutralCount: 0,
    inconclusive: false,
    caveat: 'kamus kata',
    assessedAt: new Date().toISOString(),
    ...over,
  });

  const global = (over: Partial<GlobalRiskAssessment> = {}): GlobalRiskAssessment => ({
    score: 50,
    regime: 'MIXED',
    quotes: [],
    drivers: [],
    unavailable: [],
    staleCount: 0,
    inconclusive: false,
    caveat: 'korelasi tidak stabil',
    assessedAt: new Date().toISOString(),
    ...over,
  });

  const input = (over: Partial<CompositeInput> = {}): CompositeInput => ({
    pair: 'btcidr',
    technical: 70,
    liquidity: 80,
    news: news(),
    global: global(),
    ...over,
  });

  // ─── Pengaruh satu arah ──────────────────────────────────────────────────

  it('berita dan makro bagus TIDAK menaikkan skor efektif di atas teknikal', () => {
    const r = svc.combine(input({ technical: 55, liquidity: 100, news: news({ score: 100 }), global: global({ score: 100 }) }));
    expect(r.blendedScore).toBeGreaterThan(55); // angka tampilan boleh naik
    expect(r.effectiveScore).toBe(55); // yang dipakai gerbang tidak
  });

  it('berita buruk MENURUNKAN skor efektif walau teknikalnya kuat', () => {
    const r = svc.combine(input({ technical: 90, news: news({ score: 10, negativeCount: 4 }) }));
    expect(r.effectiveScore).toBeLessThan(90);
  });

  it('skor efektif tidak pernah melebihi teknikal dalam kombinasi apa pun', () => {
    for (const t of [0, 25, 50, 75, 100]) {
      for (const n of [0, 50, 100]) {
        for (const g of [0, 50, 100]) {
          const r = svc.combine(input({ technical: t, liquidity: 100, news: news({ score: n }), global: global({ score: g }) }));
          expect(r.effectiveScore).toBeLessThanOrEqual(t);
        }
      }
    }
  });

  // ─── Blocker ─────────────────────────────────────────────────────────────

  it('berita sangat negatif berdampak tinggi menjadi blocker', () => {
    const r = svc.combine(input({ news: news({ score: 15, impact: 'HIGH', negativeCount: 5 }) }));
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(r.blockers[0]).toMatch(/berita negatif/i);
  });

  it('berita negatif berdampak RENDAH hanya meredam, tidak memblokir', () => {
    // Satu blog bernada negatif tidak boleh membatalkan setup.
    const r = svc.combine(input({ news: news({ score: 15, impact: 'LOW', negativeCount: 1 }) }));
    expect(r.blockers).toEqual([]);
    expect(r.dampeners.length).toBeGreaterThan(0);
  });

  it('makro sangat risk-off menjadi blocker', () => {
    const r = svc.combine(input({ global: global({ score: 15, regime: 'RISK_OFF', drivers: ['DXY +1.2%'] }) }));
    expect(r.blockers.some((b) => /makro/i.test(b))).toBe(true);
  });

  it('RISK_OFF ringan hanya meredam', () => {
    const r = svc.combine(input({ global: global({ score: 32, regime: 'RISK_OFF' }) }));
    expect(r.blockers).toEqual([]);
    expect(r.dampeners.some((d) => /risk-off/i.test(d))).toBe(true);
  });

  // ─── Data tidak tersedia ─────────────────────────────────────────────────

  it('berita tidak tersedia TIDAK dianggap aman dan bobotnya dialihkan', () => {
    const r = svc.combine(input({ news: null }));
    const newsComp = r.components.find((c) => c.name === 'NEWS')!;
    expect(newsComp.unavailable).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.caveats.some((c) => /bukan dianggap aman|didistribusikan ulang/i.test(c))).toBe(true);
  });

  it('berita inconclusive diperlakukan sama dengan tidak tersedia', () => {
    const r = svc.combine(input({ news: news({ inconclusive: true, score: 50 }) }));
    expect(r.components.find((c) => c.name === 'NEWS')!.unavailable).toBe(true);
  });

  it('komponen hilang tidak menarik skor ke tengah', () => {
    // Teknikal 90 + likuiditas 90, berita dan makro hilang. Bila yang hilang
    // diisi 50, skor jatuh ke sekitar 78 tanpa alasan.
    const r = svc.combine(input({ technical: 90, liquidity: 90, news: null, global: null }));
    expect(r.blendedScore).toBe(90);
  });

  it('seluruh lapisan luar hilang menyisakan teknikal apa adanya', () => {
    const r = svc.combine(input({ technical: 64, liquidity: 64, news: null, global: null }));
    expect(r.effectiveScore).toBe(64);
  });

  // ─── Pelaporan ───────────────────────────────────────────────────────────

  it('selalu melaporkan keempat komponen', () => {
    const names = svc.combine(input()).components.map((c) => c.name).sort();
    expect(names).toEqual(['GLOBAL', 'LIQUIDITY', 'NEWS', 'TECHNICAL']);
  });

  it('meneruskan peringatan dari lapisan sumber tanpa menghilangkannya', () => {
    const r = svc.combine(input());
    expect(r.caveats.some((c) => /kamus kata/.test(c))).toBe(true);
    expect(r.caveats.some((c) => /korelasi tidak stabil/.test(c))).toBe(true);
  });

  it('menyebut instrumen makro kedaluwarsa', () => {
    const r = svc.combine(input({ global: global({ staleCount: 3 }) }));
    expect(r.caveats.some((c) => /kedaluwarsa/i.test(c))).toBe(true);
  });

  it('peringatan tidak diduplikasi', () => {
    const r = svc.combine(input());
    expect(r.caveats.length).toBe(new Set(r.caveats).size);
  });

  it('nilai di luar rentang dan NaN tidak merusak skor', () => {
    const r = svc.combine(input({ technical: NaN, liquidity: 500 }));
    expect(r.effectiveScore).toBeGreaterThanOrEqual(0);
    expect(r.effectiveScore).toBeLessThanOrEqual(100);
  });
});
