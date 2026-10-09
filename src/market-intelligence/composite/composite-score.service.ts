import { Injectable, Logger } from '@nestjs/common';
import { NewsAssessment } from '../../news/news.types';
import { GlobalRiskAssessment } from '../../global-market/global-market.types';

export interface CompositeInput {
  pair: string;
  /** Skor Confluence Engine 0-100 — penilaian teknikal. */
  technical: number;
  /** 0-100 dari kualitas likuiditas pair (volume, spread, kedalaman). */
  liquidity: number;
  news: NewsAssessment | null;
  global: GlobalRiskAssessment | null;
}

export interface CompositeComponent {
  name: 'TECHNICAL' | 'NEWS' | 'GLOBAL' | 'LIQUIDITY';
  score: number;
  weight: number;
  /** True bila komponen tidak dapat dinilai dan bobotnya didistribusikan ulang. */
  unavailable: boolean;
  note: string;
}

export interface CompositeResult {
  pair: string;
  /**
   * Rata-rata berbobot keempat komponen — angka yang ditampilkan di dashboard
   * dan Telegram. Inilah "FINAL SCORE" dalam rancangan roadmap.
   */
  blendedScore: number;
  /**
   * Skor yang BENAR-BENAR dipakai gerbang entry.
   *
   * Selalu <= skor teknikal. Lihat penjelasan panjang di `combine()` — ini
   * perbedaan terpenting di seluruh berkas ini.
   */
  effectiveScore: number;
  components: CompositeComponent[];
  /** Alasan tegas menolak. Bila tidak kosong, entry harus ditahan. */
  blockers: string[];
  /** Hal yang memperlemah tanpa menolak. */
  dampeners: string[];
  caveats: string[];
}

/** Bobot tampilan untuk `blendedScore`. Totalnya 100. */
const WEIGHTS = { TECHNICAL: 55, NEWS: 15, GLOBAL: 15, LIQUIDITY: 15 } as const;

/** Di bawah ini, berita dianggap jelas buruk. */
const NEWS_BLOCK_BELOW = 30;
/** Di bawah ini, kondisi makro dianggap jelas buruk. */
const GLOBAL_BLOCK_BELOW = 25;

/**
 * Menyatukan teknikal, berita, makro, dan likuiditas menjadi satu angka.
 *
 * Mengapa ada DUA skor dan bukan satu — ini inti rancangannya:
 *
 * `blendedScore` adalah rata-rata berbobot seperti yang digambarkan di
 * roadmap, dan itu angka yang enak dibaca manusia.
 *
 * Tetapi memakainya sebagai gerbang entry akan membuat berita bagus MENAIKKAN
 * setup teknikal yang lemah. Itu arah pengaruh yang salah. Berita positif dan
 * makro yang tenang bukan alasan untuk membeli — keduanya tidak memberi tahu
 * apa pun tentang di mana harga berada relatif terhadap struktur, stop, dan
 * target. Sementara berita buruk dan makro yang memburuk BENAR-BENAR bisa
 * membatalkan setup teknikal yang sempurna.
 *
 * Pengaruhnya karena itu dibuat satu arah: `effectiveScore` tidak pernah
 * melebihi skor teknikal. Lapisan luar hanya bisa menurunkan dan menolak.
 * Ini konsisten dengan keputusan arsitektur Market Intelligence sejak awal —
 * gerbangnya hanya-menolak.
 */
@Injectable()
export class CompositeScoreService {
  private readonly logger = new Logger(CompositeScoreService.name);

  combine(input: CompositeInput): CompositeResult {
    const components: CompositeComponent[] = [];
    const blockers: string[] = [];
    const dampeners: string[] = [];
    const caveats: string[] = [];

    components.push({
      name: 'TECHNICAL',
      score: clamp01to100(input.technical),
      weight: WEIGHTS.TECHNICAL,
      unavailable: false,
      note: 'Skor Confluence Engine',
    });

    components.push({
      name: 'LIQUIDITY',
      score: clamp01to100(input.liquidity),
      weight: WEIGHTS.LIQUIDITY,
      unavailable: false,
      note: 'Volume, spread, dan kedalaman order book',
    });

    // ─── Berita ─────────────────────────────────────────────────────────────
    if (!input.news || input.news.inconclusive) {
      components.push({
        name: 'NEWS',
        score: 50,
        weight: WEIGHTS.NEWS,
        unavailable: true,
        note: input.news ? 'Tidak ada berita berarah' : 'Berita tidak terambil',
      });
      caveats.push('Berita tidak dinilai — bobotnya didistribusikan ulang, bukan dianggap aman.');
    } else {
      const n = input.news;
      components.push({
        name: 'NEWS',
        score: n.score,
        weight: WEIGHTS.NEWS,
        unavailable: false,
        note: `${n.positiveCount} positif / ${n.negativeCount} negatif · dampak ${n.impact}`,
      });

      if (n.score < NEWS_BLOCK_BELOW && n.impact === 'HIGH') {
        blockers.push(
          `Berita negatif berdampak tinggi (skor ${n.score}/100, ${n.negativeCount} berita negatif)`,
        );
      } else if (n.score < 45) {
        dampeners.push(`Berita cenderung negatif (${n.score}/100)`);
      }
      caveats.push(n.caveat);
    }

    // ─── Makro ──────────────────────────────────────────────────────────────
    if (!input.global || input.global.inconclusive) {
      components.push({
        name: 'GLOBAL',
        score: 50,
        weight: WEIGHTS.GLOBAL,
        unavailable: true,
        note: input.global ? 'Data makro tidak cukup' : 'Data makro tidak terambil',
      });
      caveats.push('Kondisi makro tidak dinilai — bobotnya didistribusikan ulang.');
    } else {
      const g = input.global;
      components.push({
        name: 'GLOBAL',
        score: g.score,
        weight: WEIGHTS.GLOBAL,
        unavailable: false,
        note: `${g.regime}${g.drivers.length ? ' · ' + g.drivers.join(', ') : ''}`,
      });

      if (g.score < GLOBAL_BLOCK_BELOW) {
        blockers.push(`Kondisi makro jelas risk-off (skor ${g.score}/100: ${g.drivers.join(', ')})`);
      } else if (g.regime === 'RISK_OFF') {
        dampeners.push(`Makro risk-off (${g.score}/100)`);
      }
      if (g.staleCount > 0) {
        caveats.push(`${g.staleCount} instrumen makro kedaluwarsa (pasar tutup) dan tidak ikut dinilai.`);
      }
      caveats.push(g.caveat);
    }

    // Bobot komponen yang tidak tersedia dibagi ke yang tersedia, bukan
    // dihitung sebagai 50 — mengisi nilai netral akan menarik seluruh skor ke
    // tengah dan menyamarkan setup yang sebenarnya kuat atau lemah.
    const available = components.filter((c) => !c.unavailable);
    const availableWeight = available.reduce((s, c) => s + c.weight, 0);
    const blended = availableWeight
      ? Math.round(available.reduce((s, c) => s + c.score * c.weight, 0) / availableWeight)
      : clamp01to100(input.technical);

    // Pengaruh satu arah: lapisan luar hanya menurunkan, tidak pernah menaikkan.
    const effective = Math.min(clamp01to100(input.technical), blended);

    return {
      pair: input.pair,
      blendedScore: blended,
      effectiveScore: effective,
      components,
      blockers,
      dampeners,
      caveats: [...new Set(caveats)],
    };
  }
}

function clamp01to100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}
