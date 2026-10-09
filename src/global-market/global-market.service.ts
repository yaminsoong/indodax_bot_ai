import { Injectable, Logger } from '@nestjs/common';
import { YahooFinanceClient } from './yahoo-finance.client';
import {
  GLOBAL_CAVEAT,
  GLOBAL_SYMBOLS,
  GlobalQuote,
  GlobalRegime,
  GlobalRiskAssessment,
  GlobalSymbol,
  GlobalSymbolSpec,
} from './global-market.types';

/**
 * Jam sebelum sebuah harga dianggap kedaluwarsa.
 *
 * Pasar saham AS tutup sekitar 17,5 jam setiap hari kerja dan penuh di akhir
 * pekan, sedangkan crypto jalan terus. 36 jam membuat penutupan Jumat masih
 * terpakai sepanjang Sabtu — setelah itu ia bukan lagi gambaran kondisi
 * sekarang, hanya jejak masa lalu.
 */
const STALE_AFTER_HOURS = 36;

/** Instrumen makro bergerak lambat; mengambilnya tiap menit tidak ada gunanya. */
const CACHE_TTL_MS = 10 * 60_000;

/**
 * Minimal bobot yang harus berhasil diambil sebelum skor berarti apa pun.
 *
 * Tanpa ambang ini, kegagalan mengambil enam dari tujuh instrumen tetap
 * menghasilkan angka yang terlihat sah — bentuk kegagalan sunyi yang paling
 * berbahaya karena tidak ada yang tampak rusak.
 */
const MIN_WEIGHT_FOR_VERDICT = 50;

@Injectable()
export class GlobalMarketService {
  private readonly logger = new Logger(GlobalMarketService.name);
  private cached: { at: number; value: GlobalRiskAssessment } | null = null;
  private inFlight: Promise<GlobalRiskAssessment> | null = null;

  constructor(private readonly yahoo: YahooFinanceClient) {}

  /** Penilaian terakhir, diambil ulang bila cache sudah tua. */
  async assess(force = false): Promise<GlobalRiskAssessment> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.value;
    }
    // Beberapa pair dianalisis bersamaan saat scan; semuanya menunggu satu
    // pengambilan yang sama alih-alih memicu tujuh permintaan masing-masing.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchAndScore()
      .then((value) => {
        this.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Penilaian dari cache tanpa memicu permintaan jaringan. */
  cachedAssessment(): GlobalRiskAssessment | null {
    return this.cached?.value ?? null;
  }

  private async fetchAndScore(): Promise<GlobalRiskAssessment> {
    const quotes: GlobalQuote[] = [];
    const unavailable: GlobalSymbol[] = [];

    const settled = await Promise.allSettled(
      GLOBAL_SYMBOLS.map(async (spec) => ({ spec, quote: await this.yahoo.getQuote(spec.source) })),
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const spec = GLOBAL_SYMBOLS[i];

      if (outcome.status === 'rejected') {
        unavailable.push(spec.symbol);
        this.logger.warn(`${spec.label} tidak terambil: ${outcome.reason?.message ?? outcome.reason}`);
        continue;
      }

      const { quote } = outcome.value;
      const ageHours = (Date.now() - quote.quotedAtSec * 1000) / 3_600_000;

      quotes.push({
        symbol: spec.symbol,
        label: spec.label,
        price: quote.price,
        previousClose: quote.previousClose,
        changePercent: ((quote.price - quote.previousClose) / quote.previousClose) * 100,
        quotedAt: new Date(quote.quotedAtSec * 1000).toISOString(),
        ageHours: Math.max(0, Math.round(ageHours * 10) / 10),
        stale: ageHours > STALE_AFTER_HOURS,
      });
    }

    return this.score(quotes, unavailable);
  }

  /**
   * Gabungkan perubahan harga menjadi satu skor 0-100.
   *
   * Tiap instrumen dinormalkan terhadap ambang "gerakan besar"-nya sendiri,
   * lalu dibatasi pada ±1. Tanpa normalisasi per instrumen, VIX yang rutin
   * bergerak 8% akan menenggelamkan DXY yang bergerak 0,3% — padahal keduanya
   * sama-sama sinyal yang berarti pada skalanya masing-masing.
   *
   * Dipisah dari pengambilan data agar bisa diuji tanpa jaringan.
   */
  score(quotes: GlobalQuote[], unavailable: GlobalSymbol[] = []): GlobalRiskAssessment {
    const specs = new Map<GlobalSymbol, GlobalSymbolSpec>(
      GLOBAL_SYMBOLS.map((s) => [s.symbol, s]),
    );

    let weighted = 0;
    let usableWeight = 0;
    const negatives: { label: string; change: number; impact: number }[] = [];

    for (const q of quotes) {
      const spec = specs.get(q.symbol);
      if (!spec) continue;

      // Data kedaluwarsa tidak ikut menilai: penutupan Jumat bukan kondisi
      // Minggu. Ia tetap ditampilkan agar operator tahu pasarnya tutup.
      if (q.stale) continue;

      const normalized = clamp(q.changePercent / spec.significantMovePercent, -1, 1);
      // INVERSE: instrumen naik berarti kondisi risiko memburuk.
      const directional = spec.polarity === 'INVERSE' ? -normalized : normalized;

      weighted += directional * spec.weight;
      usableWeight += spec.weight;

      if (directional < 0) {
        negatives.push({
          label: spec.label,
          change: q.changePercent,
          impact: directional * spec.weight,
        });
      }
    }

    const staleCount = quotes.filter((q) => q.stale).length;
    const inconclusive = usableWeight < MIN_WEIGHT_FOR_VERDICT;

    // Netral = 50. Bobot yang terpakai menentukan seberapa jauh skor bisa
    // bergerak dari netral, sehingga data yang sedikit otomatis menghasilkan
    // skor yang mendekati netral alih-alih ekstrem yang tidak berdasar.
    const score = inconclusive
      ? 50
      : Math.round(clamp(50 + (weighted / usableWeight) * 50, 0, 100));

    const drivers = negatives
      .sort((a, b) => a.impact - b.impact)
      .slice(0, 3)
      .map((n) => `${n.label} ${n.change >= 0 ? '+' : ''}${n.change.toFixed(2)}%`);

    return {
      score,
      regime: this.regimeOf(score, inconclusive),
      quotes,
      drivers,
      unavailable,
      staleCount,
      inconclusive,
      caveat: inconclusive
        ? `Data makro tidak cukup (${unavailable.length} gagal diambil, ${staleCount} kedaluwarsa) — ` +
          `diperlakukan sebagai TIDAK TAHU, bukan netral. ${GLOBAL_CAVEAT}`
        : GLOBAL_CAVEAT,
      assessedAt: new Date().toISOString(),
    };
  }

  /**
   * Ambang regime dibuat lebar di tengah dengan sengaja.
   *
   * Pasar makro lebih sering tidak mengatakan apa-apa daripada mengatakan
   * sesuatu. Rentang MIXED yang lebar mencegah lapisan ini mengubah derau
   * harian menjadi keputusan.
   */
  private regimeOf(score: number, inconclusive: boolean): GlobalRegime {
    if (inconclusive) return 'MIXED';
    if (score <= 35) return 'RISK_OFF';
    if (score >= 65) return 'RISK_ON';
    return 'MIXED';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
