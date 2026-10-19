import { Injectable } from '@nestjs/common';
import { NewsImpact, NewsSentiment } from './news.types';

export interface SentimentResult {
  sentiment: NewsSentiment;
  /** -100 sampai +100. */
  score: number;
  /** Kata yang memicu penilaian — supaya hasilnya bisa diperiksa manusia. */
  matchedTerms: string[];
}

/**
 * Bobot kata dipilih berdasarkan seberapa langsung sebuah kata menggerakkan
 * harga, bukan seberapa positif bunyinya.
 *
 * Perhatikan asimetrinya: kata negatif diberi bobot lebih besar dari padanan
 * positifnya. Itu bukan pesimisme, melainkan cerminan perilaku pasar — kabar
 * peretasan atau pelarangan bergerak dalam hitungan menit, sementara kabar
 * kemitraan sering sudah tercermin di harga sebelum beritanya terbit.
 */
const NEGATIVE_TERMS: Record<string, number> = {
  hack: 30, hacked: 30, exploit: 28, breach: 25, stolen: 25, drained: 28,
  ban: 28, banned: 28, banning: 25, illegal: 22, lawsuit: 20, sue: 18, sued: 20,
  fraud: 28, scam: 25, ponzi: 28, laundering: 22, indicted: 25, arrested: 22,
  crash: 25, plunge: 24, plummet: 24, collapse: 28, tumble: 20, slump: 20,
  selloff: 20, liquidated: 22, liquidation: 20, bankruptcy: 30, insolvent: 30,
  delist: 25, delisted: 25, halt: 18, halted: 20, suspended: 20, freeze: 18,
  bearish: 18, downgrade: 18, warning: 14, probe: 16, investigation: 18,
  crackdown: 22, restrict: 16, reject: 16, rejected: 18, denied: 16,
  outflow: 16, outflows: 16, dump: 18, capitulation: 22, default: 22,
  hawkish: 18, tightening: 16, recession: 22, inflation: 12, layoffs: 14,
  'risk-off': 20, 'sell-off': 20, exodus: 18, vulnerability: 18, downtime: 14,

  // --- Bahasa Indonesia ---
  // Sumber berita Indonesia penting untuk bot yang berdagang di Indodax:
  // kebijakan Bappebti/OJK dan kabar bursa lokal nyaris tidak pernah muncul
  // di feed berbahasa Inggris. Tanpa kata-kata ini, seluruh judul Indonesia
  // dinilai 0 -- diukur langsung: "Bitcoin Anjlok Tajam, Investor Panik Jual"
  // mendapat skor 0, sementara padanannya dalam Inggris mendapat -24.
  anjlok: 24, ambruk: 26, merosot: 20, melemah: 14, terjun: 20, tergerus: 16,
  panik: 20, kepanikan: 20, rugi: 14, kerugian: 14, merugi: 16,
  dilarang: 28, larangan: 25, melarang: 25, diblokir: 20, disita: 22,
  penipuan: 28, penipu: 25, pencucian: 22, bodong: 26, pailit: 30, bangkrut: 30,
  ditangkap: 22, dipidana: 22, digugat: 20, gugatan: 20, sanksi: 20, denda: 16,
  diretas: 30, peretasan: 30, dibobol: 25, dicuri: 25, pencurian: 25,
  ditolak: 18, dihentikan: 20, disetop: 20, dibekukan: 18, dicabut: 22,
  resesi: 22, ambrol: 24, jeblok: 22, lesu: 14, tekanan: 12,
  // Bentuk AKTIF tanpa awalan di-. Judul "27 Situs Exchange Kripto Diblokir"
  // tertangkap, tetapi "Korea Selatan Blokir 27 Platform" lolos -- celah yang
  // sama dengan "cabut izin", dan ditutup dengan cara yang sama.
  blokir: 20, larang: 25, retas: 30, sita: 22, bobol: 25,
  // Frasa bentuk aktif. Judul Indonesia sering memakai "Cabut Izin" dan
  // "Gagal Bayar" tanpa awalan di-, sehingga bentuk pasifnya saja tidak cukup.
  'cabut izin': 25, 'gagal bayar': 22, 'aksi jual': 20, 'tekanan jual': 18,
};

const POSITIVE_TERMS: Record<string, number> = {
  surge: 18, soar: 18, rally: 16, jump: 14, climb: 12, gain: 10, gains: 10,
  breakout: 14, 'all-time high': 20, 'record high': 18, milestone: 12,
  approve: 20, approved: 22, approval: 22, greenlight: 20, cleared: 16,
  etf: 14, inflow: 16, inflows: 16, accumulate: 12, accumulation: 12,
  adoption: 16, partnership: 12, integration: 10, launch: 10, launches: 10,
  upgrade: 14, mainnet: 12, bullish: 16, outperform: 14, rebound: 14,
  institutional: 12, custody: 10, listing: 16, listed: 14,
  dovish: 16, 'rate cut': 20, easing: 14, stimulus: 16, 'risk-on': 18,
  buyback: 14, staking: 8, dividend: 8,

  // --- Bahasa Indonesia ---
  melonjak: 18, menguat: 14, meroket: 20, reli: 16, bangkit: 12,
  pemulihan: 14, terobosan: 14, lonjakan: 16, menanjak: 12, naik: 10,
  disetujui: 22, persetujuan: 22, direstui: 20, dilegalkan: 18, diizinkan: 18,
  diluncurkan: 10, peluncuran: 10, kemitraan: 12, adopsi: 16, insentif: 12,
  keuntungan: 10, untung: 10, cuan: 12, tumbuh: 10, bertumbuh: 10,
  'rekor tertinggi': 20, 'suku bunga dipangkas': 20, 'aliran masuk': 16,
};

/**
 * Kata yang SENGAJA tidak dipakai, beserta alasannya.
 *
 * Masing-masing pernah ada di kamus di atas dan menghasilkan penilaian yang
 * jelas salah pada berita sungguhan. Dicatat di sini supaya tidak ditambahkan
 * kembali oleh orang yang menganggapnya terlewat:
 *
 *   reserve  — menabrak "Federal Reserve". Judul "Corrections Issued for
 *              Federal Reserve Bank Name" dinilai +10 padahal tidak
 *              mengandung arah apa pun.
 *   treasury — menabrak "Treasury Department" dan "Treasury yield", yang
 *              justru sering kabar buruk untuk aset berisiko.
 *   record   — "record high" dan "record low" berlawanan arah. Hanya frasa
 *              lengkapnya yang dipakai.
 *   high/low — terlalu umum; hampir setiap judul harga memuatnya.
 */
export const DELIBERATELY_EXCLUDED = ['reserve', 'treasury', 'record', 'high', 'low'] as const;

/** Dipakai tes untuk menjaga agar kata di atas tidak kembali masuk kamus. */
export const SENTIMENT_DICTIONARY_KEYS = (): string[] => [
  ...Object.keys(POSITIVE_TERMS),
  ...Object.keys(NEGATIVE_TERMS),
];

/**
 * Kata yang membalik makna kata setelahnya.
 *
 * Tanpa ini "SEC rejects spot ETF" dan "SEC approves spot ETF" sama-sama
 * terbaca positif karena keduanya memuat "etf", dan "no hack occurred" terbaca
 * negatif. Pembalikan hanya berlaku dalam jarak beberapa kata — di luar itu
 * kaitannya terlalu lemah untuk diandalkan.
 */
const NEGATORS = [
  'no', 'not', 'never', 'without', 'denies', 'denied', 'deny', 'dismisses', 'dismissed', 'avoids', 'halts',
  // Negasi Bahasa Indonesia. Tanpa ini "Bitcoin Tidak Anjlok" dinilai
  // negatif, padahal artinya justru kebalikannya.
  'tidak', 'tak', 'bukan', 'belum', 'tanpa', 'batal', 'membantah', 'dibantah',
];
const NEGATION_WINDOW = 3;

/** Kata yang menandakan berita berdampak besar, lepas dari arahnya. */
const HIGH_IMPACT_TERMS = [
  'federal reserve', 'fed', 'fomc', 'interest rate', 'rate cut', 'rate hike',
  'cpi', 'inflation', 'sec', 'etf', 'ban', 'banned', 'hack', 'exploit',
  'bankruptcy', 'regulation', 'lawsuit', 'crackdown', 'ojk', 'halving',
];

/**
 * Penilai sentimen berbasis kamus.
 *
 * Deterministik dengan sengaja: masukan yang sama selalu memberi hasil yang
 * sama, hasilnya bisa diuji, dan tidak ada biaya per panggilan. Ia TIDAK
 * memahami bahasa — lihat peringatan di `news.types.ts` sebelum
 * mempercayainya untuk keputusan.
 */
@Injectable()
export class SentimentService {
  analyze(title: string): SentimentResult {
    const text = title.toLowerCase();
    const words = text.split(/[^a-z0-9'’-]+/).filter(Boolean);

    let score = 0;
    const matched: string[] = [];

    // Frasa lebih dulu: "rate cut" harus dinilai sebagai satu hal, bukan
    // sebagai "rate" dan "cut" yang terpisah.
    for (const [term, weight] of [...Object.entries(POSITIVE_TERMS), ...Object.entries(NEGATIVE_TERMS)]) {
      if (!term.includes(' ')) continue;
      if (!text.includes(term)) continue;
      const positive = term in POSITIVE_TERMS;
      const negated = this.phraseNegated(text, term);
      score += (positive === !negated ? 1 : -1) * weight;
      matched.push(negated ? `!${term}` : term);
    }

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const base = lookupBase(w);
      if (!base) continue;

      const posWeight = POSITIVE_TERMS[base];
      const negWeight = NEGATIVE_TERMS[base];
      if (posWeight === undefined && negWeight === undefined) continue;

      const negated = this.negatedAt(words, i);
      if (posWeight !== undefined) {
        score += negated ? -posWeight : posWeight;
        matched.push(negated ? `!${w}` : w);
      } else {
        score += negated ? negWeight : -negWeight;
        matched.push(negated ? `!${w}` : w);
      }
    }

    const clamped = Math.max(-100, Math.min(100, score));

    return {
      // Ambang ±10 menyingkirkan satu kata lemah yang kebetulan lewat; di
      // bawah itu judulnya tidak benar-benar mengatakan arah apa pun.
      sentiment: clamped >= 10 ? 'POSITIVE' : clamped <= -10 ? 'NEGATIVE' : 'NEUTRAL',
      score: clamped,
      matchedTerms: matched,
    };
  }

  /** HIGH bila menyentuh kebijakan/regulasi/keamanan, atau sentimennya kuat. */
  impactOf(title: string, sentimentScore: number, sourceTier: 1 | 2 | 3): NewsImpact {
    const text = title.toLowerCase();
    const heavy = HIGH_IMPACT_TERMS.some((t) => text.includes(t));
    const strong = Math.abs(sentimentScore) >= 25;

    if (heavy && sourceTier === 1) return 'HIGH';
    if (heavy && strong) return 'HIGH';
    if (heavy || strong) return 'MEDIUM';
    return 'LOW';
  }

  /** Dipakai tes untuk memastikan bentuk berimbuhan dikenali. */
  resolveWord(word: string): string | null {
    return lookupBase(word);
  }

  private negatedAt(words: string[], index: number): boolean {
    const from = Math.max(0, index - NEGATION_WINDOW);
    return words.slice(from, index).some((w) => NEGATORS.includes(w));
  }

  private phraseNegated(text: string, phrase: string): boolean {
    const at = text.indexOf(phrase);
    if (at <= 0) return false;
    const before = text
      .slice(0, at)
      .split(/[^a-z0-9'’-]+/)
      .filter(Boolean)
      .slice(-NEGATION_WINDOW);
    return before.some((w) => NEGATORS.includes(w));
  }
}

/**
 * Cari bentuk dasar sebuah kata di dalam kamus.
 *
 * Ditambahkan setelah membandingkan hasil kamus dengan AI pada berita nyata:
 * judul "Bitcoin plunged nearly $2000, triggering liquidations" dinilai
 * **0** oleh kamus — padahal `plunge` dan `liquidation` keduanya ADA di kamus.
 * Yang tidak ada hanyalah bentuk berimbuhannya. AI menilai judul yang sama -75.
 *
 * Kegagalan seperti ini paling berbahaya karena tidak terlihat: tidak ada
 * galat, tidak ada kata yang cocok, skornya nol, dan judul yang jelas buruk
 * lewat tanpa jejak.
 *
 * Varian dicoba berurutan dari yang paling spesifik. Hanya akhiran yang lazim
 * pada kata kerja dan kata benda berita yang dicoba — bukan stemmer penuh,
 * yang akan memetakan kata tak berkaitan ke bentuk dasar yang sama.
 */
function lookupBase(word: string): string | null {
  if (word in POSITIVE_TERMS || word in NEGATIVE_TERMS) return word;

  const known = (w: string) => w in POSITIVE_TERMS || w in NEGATIVE_TERMS;

  const variants: string[] = [];
  if (word.endsWith('ies')) variants.push(word.slice(0, -3) + 'y'); // rallies -> rally
  if (word.endsWith('es')) variants.push(word.slice(0, -2)); // surges -> surge
  if (word.endsWith('s')) variants.push(word.slice(0, -1)); // liquidations -> liquidation
  if (word.endsWith('ed')) {
    variants.push(word.slice(0, -1)); // plunged -> plunge
    variants.push(word.slice(0, -2)); // crashed -> crash
  }
  if (word.endsWith('ing')) {
    variants.push(word.slice(0, -3)); // crashing -> crash
    variants.push(word.slice(0, -3) + 'e'); // plunging -> plunge
  }

  for (const v of variants) {
    // Batang sangat pendek terlalu mudah bertabrakan dengan kata lain.
    if (v.length >= 4 && known(v)) return v;
  }

  return null;
}
