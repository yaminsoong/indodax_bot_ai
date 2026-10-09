import { Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/bot-config.service';
import { EmaScalpingStrategy } from './ema-scalping.strategy';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import { DonchianBreakoutStrategy } from './donchian-breakout.strategy';
import { TradingStrategy } from './strategy.interface';

/**
 * Daftar strategi yang tersedia.
 *
 * Strategi aktif dipilih lewat konfigurasi `ACTIVE_STRATEGY` (bisa diubah saat
 * bot berjalan). Semua trade menyimpan nama strategi yang memicunya, sehingga
 * performa tiap strategi bisa dibandingkan dari data nyata.
 */
@Injectable()
export class StrategyRegistry {
  private readonly logger = new Logger(StrategyRegistry.name);
  private readonly strategies = new Map<string, TradingStrategy>();

  constructor(
    private readonly config: BotConfigService,
    ema: EmaScalpingStrategy,
    meanReversion: MeanReversionStrategy,
    donchian: DonchianBreakoutStrategy,
  ) {
    this.register(ema);
    this.register(meanReversion);
    this.register(donchian);
  }

  private register(strategy: TradingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): TradingStrategy | undefined {
    return this.strategies.get(name);
  }

  all(): TradingStrategy[] {
    return [...this.strategies.values()];
  }

  list(): Array<{ name: string; description: string; active: boolean }> {
    const activeName = this.active().name;
    return this.all().map((s) => ({
      name: s.name,
      description: s.description,
      active: s.name === activeName,
    }));
  }

  /** Strategi yang sedang dipakai untuk trading live/simulasi. */
  active(): TradingStrategy {
    const name = this.config.str('ACTIVE_STRATEGY', 'EMA_SCALPING_V2');
    const strategy = this.strategies.get(name);
    if (!strategy) {
      this.logger.warn(`Strategi '${name}' tidak dikenal, memakai EMA_SCALPING_V2`);
      return this.strategies.get('EMA_SCALPING_V2')!;
    }
    return strategy;
  }

  async setActive(name: string): Promise<{ success: boolean; message: string }> {
    if (!this.strategies.has(name)) {
      return {
        success: false,
        message: `Strategi tidak dikenal. Pilihan: ${[...this.strategies.keys()].join(', ')}`,
      };
    }
    await this.config.set('ACTIVE_STRATEGY', name, 'Strategi trading aktif');
    return { success: true, message: `Strategi aktif diganti ke ${name}` };
  }
}
