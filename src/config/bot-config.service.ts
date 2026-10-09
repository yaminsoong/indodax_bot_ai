import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BotConfig } from '../database/entities/bot-config.entity';
import { normalizeTakeProfitLevels } from '../common/take-profit';
import { LiveModeResolution, TradingMode, resolveTradingMode } from '../common/live-mode';

/** Seluruh parameter yang mempengaruhi keputusan trading. */
export interface BotParams {
  // Pasar
  tradingPairs: string[];
  candleTimeframe: number;
  candleLimit: number;
  htfTimeframe: number;

  // Sizing & risiko
  riskPerTradePercent: number;
  maxPositionPercent: number;
  /** Bot menawarkan peluang sendiri lewat Telegram beserta tombol BUY. */
  /** Gerbang FOMO menolak entry yang mengejar gerakan yang sudah terjadi. */
  fomoGuardEnabled: boolean;
  opportunityAlertEnabled: boolean;
  /** Skor minimum sebuah pair sebelum ditawarkan. */
  opportunityMinScore: number;
  /** Jeda sebelum pair yang sama boleh ditawarkan lagi. */
  opportunityCooldownHours: number;
  /** Batas tawaran per pemeriksaan, agar tidak membanjiri Telegram. */
  opportunityMaxPerScan: number;
  maxConcurrentTrades: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  maxConsecutiveLosses: number;
  maxPositionsPerCorrelationGroup: number;

  // Exit
  atrStopMultiplier: number;
  atrTargetMultiplier: number;
  /** Lebar zona entry sebagai kelipatan ATR. */
  entryZoneAtrMultiplier: number;
  minStopPercent: number;
  maxStopPercent: number;
  breakEvenAtR: number;
  /**
   * Take profit bertingkat.
   *
   * Satu target tunggal memaksa pilihan yang sama-sama buruk: ambil cepat dan
   * kehilangan trade besar yang menutup banyak kerugian kecil, atau pegang
   * sampai target jauh dan sering melihat profit berbalik jadi nol. Tiga
   * tingkat memisahkan keduanya — kunci sebagian, biarkan sisanya berjalan.
   */
  takeProfitLevels: Array<{ atR: number; closePercent: number }>;
  trailingAtrMultiplier: number;
  maxHoldingHours: number;

  // Filter sinyal
  minSignalStrength: number;
  requireHtfTrend: boolean;
  minAdx: number;
  maxChoppiness: number;
  maxSpreadPercent: number;
  minOrderBookImbalance: number;
  minVolumeIdr24h: number;
  cooldownMinutesAfterLoss: number;
  /**
   * Rasio imbalan/risiko minimum yang diterima Risk Engine.
   *
   * Dengan parameter bawaan, target berada di 2R sehingga ambang 1,0 tidak
   * pernah menolak apa pun — ia baru bekerja saat target dipersempit lewat
   * konfigurasi atau saat strategi mengusulkan target yang terlalu dekat.
   * Setel 0 untuk menonaktifkan pemeriksaan ini sepenuhnya.
   */
  minRiskReward: number;

  // Eksekusi
  slippageTolerancePercent: number;
  orderFillTimeoutSeconds: number;
  /**
   * Pasang entry sebagai order maker (limit pasif di sisi bid).
   * Fee maker Indodax 0,1% vs taker 0,2% — memangkas separuh biaya bolak-balik.
   * Konsekuensinya order bisa tidak terisi bila harga langsung lari.
   */
  makerEntry: boolean;
  /** Seberapa jauh di bawah best bid order beli dipasang (persen). */
  makerOffsetPercent: number;
  /** Batas tunggu khusus order maker; lebih panjang karena menunggu harga datang. */
  makerFillTimeoutSeconds: number;
  /** Ambil profit dengan order maker juga (tidak mendesak). Stop loss selalu taker. */
  makerTakeProfit: boolean;

  // Kontrol
  tradingEnabled: boolean;
}

/** Kelompok aset berkorelasi — hanya N posisi diizinkan per kelompok. */
const CORRELATION_GROUPS: Record<string, string[]> = {
  MAJOR: ['btcidr', 'ethidr'],
  L1: ['bnbidr', 'solidr', 'adaidr', 'avaxidr', 'dotidr', 'nearidr', 'atomidr'],
  MEME: ['dogeidr', 'shibidr', 'pepeidr', 'flokiidr', 'wifidr', 'bonkidr'],
  DEFI: ['uniidr', 'aaveidr', 'linkidr', 'mkridr', 'crvidr'],
  STABLE: ['usdtidr', 'usdcidr', 'daiidr'],
};

/**
 * Sumber tunggal untuk parameter bot.
 *
 * Prioritas: override di tabel bot_config > variabel .env > default kode.
 * Override tersimpan di DB sehingga bisa diubah saat bot berjalan (lewat
 * Telegram atau dashboard) dan tetap bertahan setelah restart.
 */
@Injectable()
export class BotConfigService implements OnModuleInit {
  private readonly logger = new Logger(BotConfigService.name);
  private overrides = new Map<string, string>();

  /**
   * Penentu daftar pair, dipasang oleh TradingUniverseService.
   *
   * Dibuat sebagai callback, bukan injeksi langsung, karena semesta trading
   * sendiri membaca konfigurasi — menyuntikkannya ke sini akan membentuk
   * dependensi melingkar. Dengan cara ini belasan pemanggil `params()` yang
   * sinkron tetap bekerja tanpa perubahan apa pun.
   */
  private pairResolver: (() => string[]) | null = null;

  setPairResolver(fn: () => string[]): void {
    this.pairResolver = fn;
  }
  /** Peringatan LIVE-tanpa-konfirmasi hanya dicetak sekali. */
  private liveBlockWarned = false;

  constructor(
    private readonly env: ConfigService,
    @InjectRepository(BotConfig)
    private readonly repo: Repository<BotConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const rows = await this.repo.find();
      this.overrides = new Map(rows.map((r) => [r.key, r.value]));
      if (rows.length) this.logger.log(`Memuat ${rows.length} override konfigurasi dari database`);
    } catch (err) {
      this.logger.error(`Gagal memuat konfigurasi: ${err.message}`);
    }
  }

  // ─── Pembacaan bertingkat ────────────────────────────────────────────────

  private raw(key: string): string | undefined {
    return this.overrides.get(key) ?? this.env.get<string>(key);
  }

  num(key: string, fallback: number): number {
    const v = this.raw(key);
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.raw(key);
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'on', 'ya'].includes(v.toLowerCase());
  }

  str(key: string, fallback: string): string {
    const v = this.raw(key);
    return v === undefined || v === '' ? fallback : v;
  }

  list(key: string, fallback: string[]): string[] {
    const v = this.raw(key);
    if (!v) return fallback;
    return v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  // ─── Penulisan override ──────────────────────────────────────────────────

  /**
   * Kunci yang TIDAK BOLEH disimpan di database maupun ditampilkan ke klien.
   *
   * Rahasia hanya boleh datang dari variabel lingkungan atau penyimpanan aman.
   * Tanpa penjagaan ini, satu panggilan `POST /api/config` dengan key
   * `INDODAX_SECRET_KEY` akan menaruh kunci privat exchange ke dalam tabel
   * konfigurasi — lalu `GET /api/config` mengembalikannya ke browser siapa pun
   * yang punya akses dashboard.
   */
  private static readonly SECRET_PATTERN =
    /(API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|CREDENTIAL)/i;

  static isSecretKey(key: string): boolean {
    return BotConfigService.SECRET_PATTERN.test(key);
  }

  async set(key: string, value: string, description?: string): Promise<void> {
    if (BotConfigService.isSecretKey(key)) {
      throw new Error(
        `Kunci '${key}' tergolong rahasia dan tidak boleh disimpan lewat konfigurasi runtime. ` +
          `Setel lewat variabel lingkungan (.env) atau penyimpanan rahasia.`,
      );
    }
    return this.setInternal(key, value, description);
  }

  /** Penulisan tanpa penyaringan rahasia — hanya untuk pemakaian internal. */
  private async setInternal(key: string, value: string, description?: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { key } });
    if (existing) {
      await this.repo.update(existing.id, { value, description: description ?? existing.description });
    } else {
      await this.repo.save({ key, value, description: description ?? null });
    }
    this.overrides.set(key, value);
    this.logger.log(`Konfigurasi diubah: ${key} = ${value}`);
  }

  async unset(key: string): Promise<void> {
    await this.repo.delete({ key });
    this.overrides.delete(key);
    this.logger.log(`Override konfigurasi dihapus: ${key}`);
  }

  /**
   * Override yang tersimpan, dengan nilai rahasia disamarkan.
   *
   * Penyamaran tetap dilakukan meskipun `set()` sudah menolak kunci rahasia:
   * database bisa saja sudah berisi baris lama dari versi sebelumnya, dan
   * nilai itu tidak boleh ikut terkirim ke frontend.
   */
  listOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of this.overrides) {
      out[key] = BotConfigService.isSecretKey(key) ? '***DISAMARKAN***' : value;
    }
    return out;
  }

  // ─── Mode ────────────────────────────────────────────────────────────────

  /**
   * Mode yang benar-benar berlaku.
   *
   * LIVE menuntut konfirmasi eksplisit yang terpisah dari TRADING_MODE —
   * lihat `resolveTradingMode`. Bila konfirmasi belum ada, bot tetap berjalan
   * tetapi dalam SIMULATION, dan alasannya dicatat sekali agar tidak membanjiri
   * log setiap kali properti ini dibaca.
   */
  get mode(): TradingMode {
    const resolution = resolveTradingMode((key) => this.raw(key));
    if (resolution.blockedReason && !this.liveBlockWarned) {
      this.liveBlockWarned = true;
      this.logger.error(resolution.blockedReason);
    }
    return resolution.mode;
  }

  /** Penjelasan lengkap mode, termasuk alasan LIVE ditolak bila terjadi. */
  get modeResolution(): LiveModeResolution {
    return resolveTradingMode((key) => this.raw(key));
  }

  get isLive(): boolean {
    return this.mode === 'LIVE';
  }

  /** Modal awal untuk mode simulasi (tidak menyentuh saldo asli). */
  get simulationCapitalIdr(): number {
    return this.num('SIMULATION_CAPITAL_IDR', 10_000_000);
  }

  // ─── Snapshot parameter ──────────────────────────────────────────────────

  params(): BotParams {
    return {
      tradingPairs: this.pairResolver ? this.pairResolver() : this.list('TRADING_PAIRS', ['btcidr']),
      candleTimeframe: this.num('CANDLE_TIMEFRAME', 15),
      candleLimit: this.num('CANDLE_LIMIT', 200),
      htfTimeframe: this.num('HTF_TIMEFRAME', 60),

      riskPerTradePercent: this.num('RISK_PER_TRADE_PERCENT', 1.0),
      maxPositionPercent: this.num('MAX_POSITION_PERCENT', 20),
      fomoGuardEnabled: this.bool('FOMO_GUARD_ENABLED', true),
      opportunityAlertEnabled: this.bool('OPPORTUNITY_ALERT_ENABLED', true),
      opportunityMinScore: this.num('OPPORTUNITY_MIN_SCORE', 70),
      opportunityCooldownHours: this.num('OPPORTUNITY_COOLDOWN_HOURS', 4),
      opportunityMaxPerScan: this.num('OPPORTUNITY_MAX_PER_SCAN', 2),
      maxConcurrentTrades: this.num('MAX_CONCURRENT_TRADES', 3),
      maxDailyLossPercent: this.num('MAX_DAILY_LOSS_PERCENT', 5.0),
      maxDrawdownPercent: this.num('MAX_DRAWDOWN_PERCENT', 15),
      maxConsecutiveLosses: this.num('MAX_CONSECUTIVE_LOSSES', 4),
      maxPositionsPerCorrelationGroup: this.num('MAX_POSITIONS_PER_GROUP', 1),

      atrStopMultiplier: this.num('ATR_STOP_MULTIPLIER', 1.5),
      atrTargetMultiplier: this.num('ATR_TARGET_MULTIPLIER', 3.0),
      entryZoneAtrMultiplier: this.num('ENTRY_ZONE_ATR_MULTIPLIER', 0.4),
      minStopPercent: this.num('MIN_STOP_PERCENT', 0.8),
      maxStopPercent: this.num('MAX_STOP_PERCENT', 6.0),
      breakEvenAtR: this.num('BREAK_EVEN_AT_R', 1.0),
      takeProfitLevels: this.takeProfitLevels(),
      trailingAtrMultiplier: this.num('TRAILING_ATR_MULTIPLIER', 2.0),
      maxHoldingHours: this.num('MAX_HOLDING_HOURS', 48),

      minSignalStrength: this.num('MIN_SIGNAL_STRENGTH', 60),
      requireHtfTrend: this.bool('REQUIRE_HTF_TREND', true),
      minAdx: this.num('MIN_ADX', 20),
      maxChoppiness: this.num('MAX_CHOPPINESS', 61.8),
      maxSpreadPercent: this.num('MAX_SPREAD_PERCENT', 0.6),
      minOrderBookImbalance: this.num('MIN_ORDERBOOK_IMBALANCE', -0.2),
      minVolumeIdr24h: this.num('MIN_VOLUME_IDR_24H', 500_000_000),
      cooldownMinutesAfterLoss: this.num('COOLDOWN_MINUTES_AFTER_LOSS', 60),
      minRiskReward: this.num('MIN_RISK_REWARD', 1.0),

      slippageTolerancePercent: this.num('SLIPPAGE_TOLERANCE_PERCENT', 0.5),
      orderFillTimeoutSeconds: this.num('ORDER_FILL_TIMEOUT_SECONDS', 90),
      makerEntry: this.bool('MAKER_ENTRY', true),
      makerOffsetPercent: this.num('MAKER_OFFSET_PERCENT', 0.02),
      makerFillTimeoutSeconds: this.num('MAKER_FILL_TIMEOUT_SECONDS', 300),
      makerTakeProfit: this.bool('MAKER_TAKE_PROFIT', true),

      tradingEnabled: this.bool('TRADING_ENABLED', true),
    };
  }

  /**
   * Tiga tingkat take profit, diurutkan dari yang terdekat.
   *
   * Tingkat dengan persentase 0 dianggap mati, sehingga pengguna bisa kembali
   * ke satu target tunggal tanpa mengubah kode. Total persentase dibatasi 100:
   * menjual lebih dari yang dimiliki akan ditolak exchange di tengah jalan,
   * meninggalkan posisi dalam keadaan setengah tertutup.
   */
  private takeProfitLevels(): Array<{ atR: number; closePercent: number }> {
    return normalizeTakeProfitLevels([
      { atR: this.num('TP1_AT_R', 1.0), closePercent: this.num('TP1_CLOSE_PERCENT', 30) },
      { atR: this.num('TP2_AT_R', 2.0), closePercent: this.num('TP2_CLOSE_PERCENT', 30) },
      { atR: this.num('TP3_AT_R', 3.5), closePercent: this.num('TP3_CLOSE_PERCENT', 40) },
    ]);
  }

  /** Kelompok korelasi sebuah pair; 'OTHER' bila tidak terdaftar. */
  correlationGroup(pair: string): string {
    const key = pair.toLowerCase();
    for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
      if (members.includes(key)) return group;
    }
    return 'OTHER';
  }
}
