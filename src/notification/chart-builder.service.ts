import { Injectable, Logger } from '@nestjs/common';
import { IndodaxService } from '../indodax/indodax.service';
import { TechnicalService } from '../indicators/technical.service';
import { BotConfigService } from '../config/bot-config.service';
import { SupportResistanceService } from '../market-intelligence/levels/support-resistance.service';
import { ChartLevel, ChartRendererService } from './chart-renderer.service';
import { fmtPrice } from '../common/num';
import { Timeframe } from '../market-intelligence/market-intelligence.types';
import { Candle } from '../indodax/indodax.types';

export interface TradeLevels {
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
}

const COLOR = {
  strongResistance: '#dc2626',
  resistance: '#ef4444',
  pivot: '#8b93a7',
  support: '#22c55e',
  strongSupport: '#16a34a',
  entry: '#3b82f6',
  stop: '#f59e0b',
  target: '#a855f7',
};

/**
 * Merakit chart dari data pasar dan level yang sudah dihitung di tempat lain.
 *
 * Tidak menghitung apa pun sendiri: level support/resistance berasal dari
 * `SupportResistanceService` yang sama dengan yang dipakai Market Intelligence
 * untuk MENOLAK sinyal. Menghitungnya ulang di sini akan menghasilkan gambar
 * yang tidak cocok dengan alasan penolakan yang dibaca operator — bentuk
 * ketidaksesuaian yang paling merusak kepercayaan.
 */
@Injectable()
export class ChartBuilderService {
  private readonly logger = new Logger(ChartBuilderService.name);

  constructor(
    private readonly indodax: IndodaxService,
    private readonly technical: TechnicalService,
    private readonly config: BotConfigService,
    private readonly renderer: ChartRendererService,
    private readonly levels: SupportResistanceService,
  ) {}

  /**
   * Bangun chart satu pair. Mengembalikan null bila gagal — pemanggil tetap
   * mengirim notifikasi teksnya, karena kehilangan gambar jauh lebih ringan
   * daripada kehilangan peringatan stop loss.
   */
  async build(
    pair: string,
    options: {
      timeframeMinutes?: number;
      bars?: number;
      trade?: TradeLevels;
      subtitle?: string;
      maxZones?: number;
    } = {},
  ): Promise<Buffer | null> {
    try {
      const params = this.config.params();
      const tf = options.timeframeMinutes ?? params.candleTimeframe;
      const bars = options.bars ?? 140;

      // +60 candle agar EMA panjang sudah "panas" di bar pertama yang digambar.
      const candles = await this.indodax.getCandles(pair, tf, bars + 60);
      if (candles.length < 30) {
        this.logger.warn(`Chart ${pair} dilewati: hanya ${candles.length} candle`);
        return null;
      }

      const closes = candles.map((c) => c.close);
      const emas: Record<string, number[]> = {
        'EMA 21': this.technical.calculateEMA(closes, 21),
        'EMA 50': this.technical.calculateEMA(closes, 50),
      };

      const chartLevels = [
        ...this.zoneLevels(pair, candles, tf, options.maxZones ?? 4),
        ...this.tradeLevels(options.trade),
      ];

      return this.renderer.render({
        pair,
        timeframeMinutes: tf,
        candles,
        emas,
        levels: chartLevels,
        subtitle: options.subtitle,
        maxCandles: bars,
      });
    } catch (err) {
      this.logger.error(`Gagal membangun chart ${pair}: ${err.message}`);
      return null;
    }
  }

  /**
   * Petakan menit ke label timeframe yang dipakai Market Intelligence.
   * Menit yang tidak punya padanan jatuh ke yang terdekat di bawahnya, supaya
   * level tetap terhitung alih-alih hilang diam-diam.
   */
  private toTimeframeLabel(minutes: number): Timeframe {
    if (minutes >= 1440) return '1D';
    if (minutes >= 240) return '4H';
    if (minutes >= 60) return '1H';
    if (minutes >= 15) return '15m';
    return '5m';
  }

  /** Zona S/R terkuat yang paling dekat dengan harga. */
  private zoneLevels(
    pair: string,
    candles: Candle[],
    tf: number,
    maxZones: number,
  ): ChartLevel[] {
    try {
      const report = this.levels.analyze(this.toTimeframeLabel(tf), candles);
      if (!report?.zones?.length) return [];

      // Zona jauh tidak menambah informasi tetapi memampatkan skala harga,
      // jadi yang dipilih adalah yang terkuat DI ANTARA yang terdekat.
      const near = report.zones
        .filter((z) => Math.abs(z.distancePercent) <= 12)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, maxZones);

      return near.map((z) => ({
        price: z.price,
        bandLow: z.priceLow,
        bandHigh: z.priceHigh,
        dashed: false,
        color: this.zoneColor(z.type),
        label: `${this.zoneLabel(z.type)} ${z.touchCount}x`,
      }));
    } catch (err) {
      this.logger.warn(`Level S/R ${pair} tidak terhitung: ${err.message}`);
      return [];
    }
  }

  private tradeLevels(trade?: TradeLevels): ChartLevel[] {
    if (!trade) return [];
    const out: ChartLevel[] = [];
    if (trade.entry) {
      out.push({ price: trade.entry, label: 'ENTRY', color: COLOR.entry, dashed: true });
    }
    if (trade.stopLoss) {
      out.push({ price: trade.stopLoss, label: 'STOP', color: COLOR.stop, dashed: true });
    }
    if (trade.takeProfit) {
      out.push({ price: trade.takeProfit, label: 'TARGET', color: COLOR.target, dashed: true });
    }
    return out;
  }

  private zoneColor(type: string): string {
    switch (type) {
      case 'STRONG_RESISTANCE':
        return COLOR.strongResistance;
      case 'RESISTANCE':
        return COLOR.resistance;
      case 'STRONG_SUPPORT':
        return COLOR.strongSupport;
      case 'SUPPORT':
        return COLOR.support;
      default:
        return COLOR.pivot;
    }
  }

  private zoneLabel(type: string): string {
    switch (type) {
      case 'STRONG_RESISTANCE':
        return 'R KUAT';
      case 'RESISTANCE':
        return 'R';
      case 'STRONG_SUPPORT':
        return 'S KUAT';
      case 'SUPPORT':
        return 'S';
      default:
        return 'PIVOT';
    }
  }

  /** Keterangan ringkas untuk menyertai chart analisis pair. */
  describe(pair: string, price: number, extra: string[] = []): string {
    return [`*${pair.toUpperCase()}* — Rp ${fmtPrice(price)}`, ...extra].join('\n');
  }
}
