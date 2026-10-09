import { CoinMatcherService } from './coin-matcher.service';

/**
 * Pencocokan substring sederhana adalah jebakan paling mahal di lapisan ini:
 * "SOL" cocok dengan "solution", "solar", dan "sold". Satu berita panel surya
 * kemudian menjadi "sentimen Solana negatif" lalu MENAHAN entry yang
 * sebenarnya baik — kerugian nyata dari kesalahan yang tidak terlihat di log.
 */
describe('CoinMatcherService', () => {
  let svc: CoinMatcherService;
  const universe = ['btc', 'eth', 'sol', 'xrp', 'op', 'atom', 'near', 'link', 'ada', 'doge'];

  beforeEach(() => {
    svc = new CoinMatcherService();
  });

  // ─── False match yang harus dihindari ────────────────────────────────────

  it('tidak mencocokkan SOL di dalam "solution"', () => {
    expect(svc.match('New solution for payment processing', universe)).not.toContain('sol');
  });

  it('tidak mencocokkan SOL di dalam "solar" atau "sold"', () => {
    expect(svc.match('Solar panel maker sold its factory', universe)).not.toContain('sol');
  });

  it('tidak mencocokkan ticker ambigu tanpa konteks crypto', () => {
    // "OP" dan "NEAR" dan "LINK" adalah kata Inggris biasa.
    const r = svc.match('Op-ed: markets near all-time high, see link below', universe);
    expect(r).not.toContain('op');
    expect(r).not.toContain('near');
    expect(r).not.toContain('link');
  });

  it('ATOM dalam konteks fisika bukan berita Cosmos', () => {
    expect(svc.match('Scientists split an atom in new experiment', universe)).not.toContain('atom');
  });

  it('tidak mencocokkan ticker yang menyatu dengan tanda hubung', () => {
    expect(svc.match('Why non-btc assets lagged', universe)).not.toContain('btc');
  });

  // ─── Yang harus tetap cocok ──────────────────────────────────────────────

  it('mencocokkan ticker yang berdiri sebagai kata utuh', () => {
    expect(svc.match('BTC breaks above resistance', universe)).toContain('btc');
  });

  it('mencocokkan nama panjang tanpa perlu tickernya', () => {
    expect(svc.match('Solana Foundation unveils settlement program', universe)).toContain('sol');
    expect(svc.match('Ethereum upgrade goes live', universe)).toContain('eth');
  });

  it('ticker ambigu DITERIMA bila judulnya terbukti soal crypto', () => {
    expect(svc.match('OP token rallies as crypto market recovers', universe)).toContain('op');
  });

  it('mencocokkan beberapa koin dalam satu judul', () => {
    const r = svc.match('Bitcoin and Ethereum lead crypto rebound', universe);
    expect(r).toContain('btc');
    expect(r).toContain('eth');
  });

  it('tidak terpengaruh huruf besar-kecil', () => {
    expect(svc.match('bitcoin surges', universe)).toContain('btc');
  });

  it('hanya mencari koin yang ada di universe', () => {
    // Pair yang tidak diperdagangkan tidak perlu dikenali.
    expect(svc.match('Cardano ADA upgrade', ['btc', 'eth'])).toEqual([]);
  });

  it('judul tanpa koin menghasilkan daftar kosong', () => {
    expect(svc.match('Federal Reserve holds rates steady', universe)).toEqual([]);
  });

  it('tidak pernah mengembalikan duplikat', () => {
    const r = svc.match('Bitcoin BTC bitcoin BTC rally', universe);
    expect(r.filter((c) => c === 'btc')).toHaveLength(1);
  });

  // ─── Berita tingkat pasar ────────────────────────────────────────────────

  it('mengenali berita yang menyangkut seluruh pasar', () => {
    expect(svc.isMarketWide('Federal Reserve signals higher rates')).toBe(true);
    expect(svc.isMarketWide('Crypto market sheds $100B in liquidations')).toBe(true);
  });

  it('berita satu koin bukan berita pasar', () => {
    expect(svc.isMarketWide('Solana Foundation announces upgrade')).toBe(false);
  });
});
