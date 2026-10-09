import {
  DELIBERATELY_EXCLUDED,
  SENTIMENT_DICTIONARY_KEYS,
  SentimentService,
} from './sentiment.service';

/**
 * Sentimen berbasis kamus punya satu kelemahan yang menentukan berguna atau
 * tidaknya seluruh lapisan: tanpa penanganan negasi, "SEC menolak ETF" dan
 * "SEC menyetujui ETF" sama-sama terbaca positif karena keduanya memuat "etf".
 * Itu bukan ketidaktelitian kecil — itu membalik kesimpulan.
 */
describe('SentimentService', () => {
  let svc: SentimentService;

  beforeEach(() => {
    svc = new SentimentService();
  });

  // ─── Arah dasar ──────────────────────────────────────────────────────────

  it('mengenali judul positif', () => {
    const r = svc.analyze('SEC approves spot Bitcoin ETF, inflows surge');
    expect(r.sentiment).toBe('POSITIVE');
    expect(r.score).toBeGreaterThan(0);
  });

  it('mengenali judul negatif', () => {
    const r = svc.analyze('Exchange hacked, $200M stolen in exploit');
    expect(r.sentiment).toBe('NEGATIVE');
    expect(r.score).toBeLessThan(0);
  });

  it('judul tanpa kata bermuatan dinilai netral', () => {
    const r = svc.analyze('Bitcoin trades sideways as volume holds steady');
    expect(r.sentiment).toBe('NEUTRAL');
  });

  // ─── Negasi ──────────────────────────────────────────────────────────────

  it('membalik makna saat dinegasikan', () => {
    const setuju = svc.analyze('SEC approves spot ETF');
    const tolak = svc.analyze('SEC denies spot ETF application');
    expect(setuju.sentiment).toBe('POSITIVE');
    expect(tolak.score).toBeLessThan(setuju.score);
  });

  it('"no hack" tidak dibaca sebagai peretasan', () => {
    const r = svc.analyze('Exchange confirms no hack occurred');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.matchedTerms).toContain('!hack');
  });

  it('negasi hanya berlaku di dekat katanya, tidak sepanjang judul', () => {
    // "not" di awal tidak boleh membalik "hack" yang jauh di belakangnya —
    // kaitannya terlalu lemah untuk diandalkan.
    const r = svc.analyze('Not confirmed yet but analysts say the bridge hack drained funds');
    expect(r.sentiment).toBe('NEGATIVE');
  });

  it('frasa dinilai sebagai satu kesatuan', () => {
    // "rate cut" positif; bila "rate" dan "cut" dinilai terpisah artinya hilang.
    const r = svc.analyze('Fed signals rate cut in December');
    expect(r.sentiment).toBe('POSITIVE');
    expect(r.matchedTerms).toContain('rate cut');
  });

  it('frasa yang dinegasikan juga terbalik', () => {
    const r = svc.analyze('Fed denies rate cut is coming');
    expect(r.matchedTerms).toContain('!rate cut');
  });

  // ─── Asimetri yang disengaja ─────────────────────────────────────────────

  it('kabar buruk berbobot lebih besar daripada kabar baik setara', () => {
    // Mencerminkan perilaku pasar: peretasan bergerak dalam menit, kemitraan
    // sering sudah tercermin di harga.
    const buruk = Math.abs(svc.analyze('Protocol hacked').score);
    const baik = Math.abs(svc.analyze('Protocol partnership').score);
    expect(buruk).toBeGreaterThan(baik);
  });

  // ─── Bentuk berimbuhan ───────────────────────────────────────────────────

  it('mengenali bentuk berimbuhan — judul ini pernah dinilai 0', () => {
    // Ditemukan saat membandingkan kamus dengan AI pada berita nyata. `plunge`
    // dan `liquidation` ADA di kamus; yang tidak ada hanya bentuk
    // berimbuhannya, sehingga judul yang jelas buruk lewat tanpa jejak.
    const r = svc.analyze('Bitcoin plunged nearly $2000 in 20 minutes, triggering liquidations');
    expect(r.sentiment).toBe('NEGATIVE');
    expect(r.matchedTerms).toContain('plunged');
    expect(r.matchedTerms).toContain('liquidations');
  });

  it.each([
    ['plunged', 'plunge'],
    ['liquidations', 'liquidation'],
    ['crashed', 'crash'],
    ['crashing', 'crash'],
    ['surges', 'surge'],
    ['rallies', 'rally'],
    ['soared', 'soar'],
    ['hacking', 'hack'],
    ['approvals', 'approval'],
  ])('%s dipetakan ke %s', (bentuk, dasar) => {
    expect(svc.resolveWord(bentuk)).toBe(dasar);
  });

  it.each(['during', 'nothing', 'banking', 'sanding', 'pressing', 'address', 'landing'])(
    '"%s" tidak salah dipetakan ke kata bermuatan',
    (word) => {
      // Pemetaan akhiran bukan stemmer penuh justru karena ini: stemmer akan
      // memetakan kata tak berkaitan ke bentuk dasar yang sama.
      expect(svc.resolveWord(word)).toBeNull();
    },
  );

  it('kata pendek tidak dipetakan — batangnya terlalu mudah bertabrakan', () => {
    expect(svc.resolveWord('bes')).toBeNull();
    expect(svc.resolveWord('ges')).toBeNull();
  });

  // ─── Tabrakan kata yang pernah terjadi pada berita sungguhan ─────────────

  it('"Federal Reserve" bukan sinyal positif', () => {
    // Pernah dinilai +10 karena kata "reserve" ada di kamus positif. Judul ini
    // tidak mengandung arah apa pun dan harus netral.
    const r = svc.analyze('Corrections Issued for Federal Reserve Bank Name');
    expect(r.sentiment).toBe('NEUTRAL');
  });

  it('"Treasury yield" tidak dibaca positif', () => {
    const r = svc.analyze('Treasury Department issues new guidance');
    expect(r.sentiment).toBe('NEUTRAL');
  });

  it('kata yang sengaja dikecualikan tidak boleh kembali masuk kamus', () => {
    // Menjaga keputusan ini tetap berlaku: tiap kata di bawah pernah
    // menghasilkan penilaian yang jelas salah pada berita sungguhan.
    const keys = SENTIMENT_DICTIONARY_KEYS();
    for (const term of DELIBERATELY_EXCLUDED) {
      expect(keys).not.toContain(term);
    }
  });

  it('"record low" tidak dibaca positif seperti "record high"', () => {
    const tinggi = svc.analyze('Bitcoin hits record high');
    const rendah = svc.analyze('Volume slides to record low');
    expect(tinggi.sentiment).toBe('POSITIVE');
    expect(rendah.sentiment).not.toBe('POSITIVE');
  });

  // ─── Batas skor ──────────────────────────────────────────────────────────

  it('skor dibatasi pada -100..100 walau judulnya menumpuk kata', () => {
    const r = svc.analyze('hack exploit breach stolen fraud scam collapse bankruptcy banned delisted');
    expect(r.score).toBe(-100);
  });

  it('melaporkan kata pemicu agar hasilnya bisa diperiksa manusia', () => {
    const r = svc.analyze('Bitcoin ETF approval drives record inflows');
    expect(r.matchedTerms.length).toBeGreaterThan(0);
    expect(r.matchedTerms).toContain('approval');
  });

  it('tidak terpengaruh huruf besar-kecil', () => {
    expect(svc.analyze('EXCHANGE HACKED').score).toBe(svc.analyze('exchange hacked').score);
  });

  it('judul kosong tidak melempar', () => {
    expect(svc.analyze('').sentiment).toBe('NEUTRAL');
  });

  // ─── Dampak ──────────────────────────────────────────────────────────────

  it('berita kebijakan dari sumber tier 1 berdampak HIGH', () => {
    expect(svc.impactOf('Federal Reserve raises interest rate', -20, 1)).toBe('HIGH');
  });

  it('sentimen kuat pada topik berat tetap HIGH walau sumbernya tier rendah', () => {
    expect(svc.impactOf('Major exchange hack drains reserves', -60, 3)).toBe('HIGH');
  });

  it('judul biasa berdampak LOW', () => {
    expect(svc.impactOf('Analyst shares weekly chart outlook', 0, 3)).toBe('LOW');
  });

  it('topik berat tanpa sentimen kuat berdampak MEDIUM', () => {
    expect(svc.impactOf('SEC publishes crypto custody guidance', 0, 3)).toBe('MEDIUM');
  });
});
