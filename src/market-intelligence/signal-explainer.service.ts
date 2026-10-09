import { Injectable } from '@nestjs/common';
import { fmtPrice } from '../common/num';
import { ConfluenceResult } from './confluence/confluence.types';
import { MtfContext } from './mtf/mtf.types';
import { Timeframe } from './market-intelligence.types';

export interface SignalExplanation {
  /** Judul singkat, mis. "BTC/IDR - LONG SETUP". */
  headline: string;
  /** Ringkasan satu baris per aspek. */
  summary: Record<string, string>;
  /** Alasan yang mendukung. */
  reasons: string[];
  /** Peringatan yang perlu diketahui walau trade tetap diambil. */
  risks: string[];
  /** Alasan tegas menolak, bila ada. */
  blockers: string[];
  /** Teks siap kirim ke Telegram atau log. */
  text: string;
}

/**
 * Menyusun penjelasan yang bisa dibaca manusia untuk setiap keputusan
 * (bagian 12 spesifikasi).
 *
 * Bukan hiasan: penjelasan inilah yang membuat operator bisa menilai apakah bot
 * menolak trade karena alasan yang masuk akal, atau karena satu filter yang
 * terlalu ketat. Bot yang pasif tanpa penjelasan tidak bisa dibedakan dari bot
 * yang rusak.
 */
@Injectable()
export class SignalExplainerService {
  explain(result: ConfluenceResult, mtf: MtfContext): SignalExplanation {
    const pairLabel = formatPair(result.pair);
    const headline = `${pairLabel} - ${this.decisionLabel(result)}`;

    const primary = mtf.timeframes[result.timeframe];
    const ind = primary?.indicators;

    const summary: Record<string, string> = {
      Skor: `${result.score}/100 (${result.decision})`,
      Arah: result.direction,
      Regime: result.regime,
      Tren: this.trendSummary(mtf),
      Struktur: this.structureSummary(result, mtf),
      Momentum: this.momentumSummary(result, mtf),
      Volume: this.volumeSummary(mtf, result.timeframe),
      Volatilitas: this.volatilitySummary(result, mtf),
    };

    if (result.setup) {
      summary['Risk/Reward'] = `1:${result.setup.riskReward.toFixed(1)}`;
      summary['Entry'] = `${fmtPrice(result.setup.entryLow)} - ${fmtPrice(result.setup.entryHigh)}`;
      summary['Stop Loss'] = `${fmtPrice(result.setup.stopLoss)} (${result.setup.stopBasis})`;
      summary['TP1 / TP2 / TP3'] =
        `${fmtPrice(result.setup.takeProfit1)} / ${fmtPrice(result.setup.takeProfit2)} / ${fmtPrice(result.setup.takeProfit3)}`;
    }

    if (!result.executable && result.direction === 'SHORT') {
      summary['Catatan'] = 'Indodax adalah bursa spot - setup SHORT hanya informasi, tidak dieksekusi';
    }

    const reasons = result.reasons.filter((r) => r.kind === 'POSITIVE').map((r) => r.text);
    const risks = [...new Set([...result.riskFactors, ...result.reasons.filter((r) => r.kind === 'RISK').map((r) => r.text)])];

    return {
      headline,
      summary,
      reasons,
      risks,
      blockers: result.blockers,
      text: this.render(headline, summary, reasons, risks, result.blockers),
    };
  }

  // --- Ringkasan per aspek -------------------------------------------------

  private decisionLabel(result: ConfluenceResult): string {
    if (result.blockers.length) return 'NO TRADE';
    switch (result.decision) {
      case 'HIGH_QUALITY_SETUP':
        return `${result.direction} SETUP BERKUALITAS TINGGI`;
      case 'TRADE_SETUP':
        return `${result.direction} SETUP`;
      case 'WATCH':
        return 'PANTAU';
      default:
        return 'NO TRADE';
    }
  }

  private trendSummary(mtf: MtfContext): string {
    const parts: string[] = [];
    for (const tf of ['1D', '4H', '1H', '15m', '5m'] as Timeframe[]) {
      const a = mtf.timeframes[tf];
      if (a) parts.push(`${tf} ${a.bias}`);
    }
    if (!parts.length) return 'tidak tersedia';
    const suffix = mtf.alignment.conflicts.length ? ' - ADA KONFLIK' : '';
    return `${parts.join(', ')}${suffix}`;
  }

  private structureSummary(result: ConfluenceResult, mtf: MtfContext): string {
    const structure = mtf.timeframes[result.timeframe]?.structure;
    if (!structure) return 'tidak tersedia';
    const latest = structure.latest.BOS ?? structure.latest.CHOCH ?? structure.latest.BREAKOUT;
    if (!latest) return `${structure.trend} (belum ada event penting)`;
    return `${structure.trend} - ${latest.type} ${latest.direction} @ ${fmtPrice(latest.price)}`;
  }

  private momentumSummary(result: ConfluenceResult, mtf: MtfContext): string {
    const m = mtf.timeframes[result.timeframe]?.indicators.momentum;
    if (!m) return 'tidak tersedia';
    const parts: string[] = [];
    if (m.rsi14 !== null) parts.push(`RSI ${m.rsi14.toFixed(0)}`);
    if (m.adx !== null) parts.push(`ADX ${m.adx.toFixed(0)}`);
    if (m.macd.histogram !== null) {
      parts.push(`MACD ${m.macd.histogram >= 0 ? 'positif' : 'negatif'}`);
    }
    return parts.join(', ') || 'tidak tersedia';
  }

  /**
   * Ringkasan volatilitas dengan DUA angka yang tidak boleh tertukar.
   *
   * ATR persen adalah ukuran absolut: "seberapa besar pergerakannya dibanding
   * harga". Label HIGH/LOW berasal dari ATR dibanding rata-rata ATR-nya
   * sendiri: "seberapa besar dibanding kebiasaan pair ini belakangan".
   * Keduanya bisa bertolak belakang - ATR 0,4% dari harga tetap bisa dua kali
   * lipat dari normanya sendiri. Menampilkan "ATR 0,40% (high volatility)"
   * tanpa penjelasan membuat pembacanya mengira ada kesalahan hitung.
   */
  private volatilitySummary(result: ConfluenceResult, mtf: MtfContext): string {
    const a = mtf.timeframes[result.timeframe];
    const atrPercent = a?.indicators.volatility.atrPercent;
    if (atrPercent === null || atrPercent === undefined || !a) return 'tidak tersedia';

    const relative = a.regime.volatility.replace('_VOLATILITY', '').toLowerCase();
    const ratio = a.indicators.volatility.atrRatio;
    const ratioText = ratio !== null ? ` (${ratio.toFixed(2)}x rata-ratanya)` : '';

    return `ATR ${atrPercent.toFixed(2)}% dari harga; relatif terhadap normanya: ${relative}${ratioText}`;
  }

  private volumeSummary(mtf: MtfContext, tf: Timeframe): string {
    const v = mtf.timeframes[tf]?.indicators.volume;
    if (!v || v.relativeVolume === null) return 'tidak tersedia';
    const pct = Math.round((v.relativeVolume - 1) * 100);
    const label = pct >= 0 ? `+${pct}%` : `${pct}%`;
    return `${label} dari rata-rata (${v.state.toLowerCase()})`;
  }

  // --- Render --------------------------------------------------------------

  private render(
    headline: string,
    summary: Record<string, string>,
    reasons: string[],
    risks: string[],
    blockers: string[],
  ): string {
    const lines = [headline, ''];

    for (const [key, value] of Object.entries(summary)) {
      lines.push(`${key}: ${value}`);
    }

    if (reasons.length) {
      lines.push('', 'Alasan:');
      for (const r of reasons) lines.push(`  + ${r}`);
    }

    if (risks.length) {
      lines.push('', 'Risiko:');
      for (const r of risks) lines.push(`  ! ${r}`);
    }

    if (blockers.length) {
      lines.push('', 'DITOLAK karena:');
      for (const b of blockers) lines.push(`  x ${b}`);
    }

    return lines.join('\n');
  }
}

/** btcidr -> BTC/IDR */
export function formatPair(pair: string): string {
  const upper = pair.toUpperCase();
  if (upper.endsWith('IDR')) return `${upper.slice(0, -3)}/IDR`;
  if (upper.endsWith('USDT')) return `${upper.slice(0, -4)}/USDT`;
  return upper;
}
