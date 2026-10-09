import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ChartBuilderService } from './chart-builder.service';
import { MarketIntelligenceConfigService } from '../market-intelligence/mi-config.service';
import { SignalScannerService, ScannerResult } from '../market-intelligence/scanner/signal-scanner.service';
import { fmtPrice } from '../common/num';

const MEDAL = ['🥇', '🥈', '🥉'];

/**
 * Melaporkan hasil pemindaian pasar ke Telegram.
 *
 * Sengaja TIDAK memicu order. Scanner adalah radar untuk operator; backtest
 * sejauh ini belum menunjukkan ekspektasi positif, dan memindai ratusan pair
 * dengan ekspektasi negatif bukan memperbesar peluang melainkan mempercepat
 * kerugian. Penyambungannya ke eksekusi otomatis menunggu bukti.
 */
@Injectable()
export class ScannerReportService {
  private readonly logger = new Logger(ScannerReportService.name);

  constructor(
    private readonly scanner: SignalScannerService,
    private readonly notification: NotificationService,
    private readonly charts: ChartBuilderService,
    private readonly config: MarketIntelligenceConfigService,
  ) {}

  /**
   * Pindai pasar lalu kirim ringkasannya.
   *
   * @param withChart kirim chart untuk kandidat teratas bila skornya memadai.
   */
  async scanAndReport(withChart = true): Promise<ScannerResult> {
    const started = Date.now();
    const result = await this.scanner.scan({});
    const durationSec = ((Date.now() - started) / 1000).toFixed(0);

    const minScore = this.config.params().scannerAlertMinScore;
    const ranked = [...result.overview].sort((a, b) => b.score - a.score);
    const worthy = ranked.filter((r) => r.score >= minScore);

    await this.notification.sendRaw(this.format(result, ranked, worthy, minScore, durationSec));

    // Chart hanya untuk kandidat TERBAIK, dan hanya bila memang melewati
    // ambang. Mengirim gambar untuk setiap pair akan membanjiri chat dan
    // membuat yang benar-benar penting tenggelam.
    if (withChart && worthy.length) {
      const top = worthy[0];
      const image = await this.charts.build(top.pair, {
        subtitle: `Skor ${top.score}/100 · ${top.regime}`,
      });
      if (image) {
        await this.notification.sendChart(
          image,
          `🥇 *${top.pair.toUpperCase()}* — skor ${top.score}/100\n` +
            `${top.decision} · ${top.trend} · ${top.regime}\n` +
            `Harga Rp ${fmtPrice(top.price)}`,
        );
      }
    }

    this.logger.log(
      `Pemindaian selesai dalam ${durationSec}s: ${result.pairsScanned} pair dianalisis, ` +
        `${worthy.length} melewati ambang skor ${minScore}`,
    );
    return result;
  }

  private format(
    result: ScannerResult,
    ranked: ScannerResult['overview'],
    worthy: ScannerResult['overview'],
    minScore: number,
    durationSec: string,
  ): string {
    const pf = result.prefilter;
    const lines: string[] = ['🔎 *PEMINDAIAN PASAR*', ''];

    if (pf) {
      lines.push(
        `Disaring: ${pf.candidates.length} kandidat dari ${pf.totalPairs} pair IDR`,
        `  (${pf.rejected.volume} volume kurang, ${pf.rejected.stablecoin} stablecoin, ${pf.rejected.untradable} tidak dapat ditradingkan)`,
        `Dianalisis: ${result.pairsScanned} pair dalam ${durationSec} detik`,
        '',
      );
    }

    if (!ranked.length) {
      lines.push('Tidak ada pair yang berhasil dianalisis.');
      return lines.join('\n');
    }

    const top = ranked.slice(0, 8);
    for (const [i, r] of top.entries()) {
      const mark = MEDAL[i] ?? `${i + 1}.`;
      const flag = r.score >= minScore ? '' : ' ·';
      lines.push(
        `${mark} *${r.pair.toUpperCase()}* ${String(r.score).padStart(3)}/100${flag}`,
        `     ${r.decision} · ${r.regime}` +
          (r.rsi !== null ? ` · RSI ${r.rsi.toFixed(0)}` : '') +
          (r.atrPercent !== null ? ` · ATR ${r.atrPercent.toFixed(2)}%` : ''),
      );
    }

    const below = result.pairsScanned - worthy.length;
    lines.push(
      '',
      worthy.length
        ? `✅ ${worthy.length} pair melewati ambang skor ${minScore}`
        : `❌ Tidak ada pair yang melewati ambang skor ${minScore}`,
    );
    if (below > 0) lines.push(`❌ ${below} pair belum memenuhi setup`);

    if (result.hits.length) {
      lines.push('', '*Kondisi terdeteksi:*');
      // Satu baris per pair agar daftarnya tidak meledak saat banyak pair
      // memicu beberapa jenis kondisi sekaligus.
      const byPair = new Map<string, string[]>();
      for (const h of result.hits.slice(0, 20)) {
        const list = byPair.get(h.pair) ?? [];
        if (!list.includes(h.type)) list.push(h.type);
        byPair.set(h.pair, list);
      }
      for (const [pair, types] of byPair) {
        lines.push(`  ${pair.toUpperCase()}: ${types.join(', ')}`);
      }
    }

    lines.push(
      '',
      '_Radar, bukan sinyal order. Keputusan tetap di tangan Anda._',
    );
    return lines.join('\n');
  }
}
