import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BotConfigService } from './bot-config.service';
import { IndodaxService } from '../indodax/indodax.service';
import { PairRegistryService } from '../indodax/pair-registry.service';
import { isStablecoinPair } from '../common/stablecoins';


export interface UniverseSnapshot {
  pairs: string[];
  mode: 'AUTO' | 'MANUAL';
  refreshedAt: Date | null;
  /** Total pair IDR yang dipertimbangkan saat penyaringan terakhir. */
  consideredPairs: number;
  rejected: { volume: number; stablecoin: number; untradable: number };
}

/**
 * Menentukan pair mana yang ditradingkan bot.
 *
 * `TRADING_PAIRS=auto` membuat daftarnya mengikuti pasar Indodax: pair paling
 * likuid dipilih sendiri dan disegarkan berkala. Daftar eksplisit tetap
 * dihormati apa adanya.
 *
 * Mengapa ada layanan tersendiri, bukan sekadar membuat `params.tradingPairs`
 * asinkron: belasan tempat membacanya secara sinkron — scheduler, health check,
 * dashboard, perintah Telegram. Menjadikan semuanya asinkron hanya demi satu
 * pengambilan data berkala akan menyebarkan `await` ke seluruh basis kode tanpa
 * menambah ketepatan apa pun. Di sini daftarnya disegarkan di latar belakang
 * dan dibaca seketika.
 */
@Injectable()
export class TradingUniverseService implements OnModuleInit {
  private readonly logger = new Logger(TradingUniverseService.name);

  private pairs: string[] = [];
  private refreshedAt: Date | null = null;
  private consideredPairs = 0;
  private rejected = { volume: 0, stablecoin: 0, untradable: 0 };
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly config: BotConfigService,
    private readonly indodax: IndodaxService,
    private readonly registry: PairRegistryService,
  ) {}

  onModuleInit(): void {
    // Dipasang lebih dulu agar setiap pembacaan params() — termasuk yang
    // terjadi sebelum penyegaran pertama selesai — sudah melewati semesta ini.
    this.config.setPairResolver(() => this.current());
  }

  /** True bila daftar pair ditentukan pasar, bukan oleh operator. */
  get isAuto(): boolean {
    const raw = this.config.str('TRADING_PAIRS', 'btcidr').trim().toLowerCase();
    return raw === 'auto' || raw === '';
  }

  /**
   * Pair yang aktif saat ini. Sinkron dan selalu mengembalikan sesuatu.
   *
   * Sebelum penyegaran pertama selesai, mengembalikan daftar cadangan agar bot
   * tidak diam total hanya karena satu panggilan jaringan belum kembali.
   */
  current(): string[] {
    if (!this.isAuto) return this.config.list('TRADING_PAIRS', ['btcidr']);
    if (this.pairs.length) return this.pairs;
    return this.config.list('TRADING_PAIRS_FALLBACK', ['btcidr', 'ethidr']);
  }

  snapshot(): UniverseSnapshot {
    return {
      pairs: this.current(),
      mode: this.isAuto ? 'AUTO' : 'MANUAL',
      refreshedAt: this.refreshedAt,
      consideredPairs: this.consideredPairs,
      rejected: { ...this.rejected },
    };
  }

  /** Segarkan bila sudah kedaluwarsa; aman dipanggil tiap siklus. */
  async refreshIfStale(maxAgeMs = 6 * 60 * 60 * 1000): Promise<void> {
    if (!this.isAuto) return;
    if (this.refreshedAt && Date.now() - this.refreshedAt.getTime() < maxAgeMs) return;
    await this.refresh();
  }

  /**
   * Pilih ulang pair dari pasar.
   *
   * Dijalankan di bawah satu promise bersama supaya beberapa pemanggil yang
   * datang bersamaan saat startup tidak memicu beberapa pengambilan sekaligus.
   */
  async refresh(): Promise<void> {
    if (!this.isAuto) return;
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const minVolume = this.config.num('TRADING_UNIVERSE_MIN_VOLUME_IDR', 1_000_000_000);
        const size = this.config.num('TRADING_UNIVERSE_SIZE', 10);

        const market = await this.indodax.getMarketSummary();
        const rejected = { volume: 0, stablecoin: 0, untradable: 0 };

        const eligible = market
          .filter((m) => {
            if (isStablecoinPair(m.pair)) {
              rejected.stablecoin++;
              return false;
            }
            if (m.volumeIdr < minVolume) {
              rejected.volume++;
              return false;
            }
            if (!this.registry.isTradable(m.pair).ok) {
              rejected.untradable++;
              return false;
            }
            return true;
          })
          .sort((a, b) => b.volumeIdr - a.volumeIdr)
          .slice(0, size)
          .map((m) => m.pair);

        if (!eligible.length) {
          // Daftar lama dipertahankan: semesta kosong akan membuat bot berhenti
          // memantau posisi yang mungkin masih terbuka.
          this.logger.warn(
            `Tidak ada pair yang memenuhi syarat (volume minimum ${(minVolume / 1e9).toFixed(1)} miliar). ` +
              `Mempertahankan daftar sebelumnya.`,
          );
          return;
        }

        const previous = new Set(this.pairs);
        const added = eligible.filter((p) => !previous.has(p));
        const removed = this.pairs.filter((p) => !eligible.includes(p));

        this.pairs = eligible;
        this.refreshedAt = new Date();
        this.consideredPairs = market.length;
        this.rejected = rejected;

        this.logger.log(
          `Semesta trading: ${eligible.length} pair dari ${market.length} pair IDR ` +
            `(${rejected.volume} volume kurang, ${rejected.stablecoin} stablecoin)`,
        );
        if (added.length || removed.length) {
          this.logger.log(
            `  masuk: ${added.join(', ') || '-'} | keluar: ${removed.join(', ') || '-'}`,
          );
        }
      } catch (err) {
        this.logger.error(`Gagal menyegarkan semesta trading: ${err.message}`);
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }
}
