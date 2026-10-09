import { BotParams } from '../../src/config/bot-config.service';

/**
 * Parameter default untuk pengujian.
 *
 * Sengaja dikumpulkan di satu tempat: sebelumnya tiap spec menyalin seluruh
 * objek BotParams, sehingga setiap penambahan satu parameter mematahkan
 * kompilasi beberapa file test sekaligus.
 *
 * Berada di `test/` (bukan `src/`) agar tidak ikut terkompilasi ke dist/ —
 * tsconfig.build.json sudah mengecualikan direktori ini.
 */
export function makeParams(overrides: Partial<BotParams> = {}): BotParams {
  return {
    tradingPairs: ['btcidr'],
    candleTimeframe: 15,
    candleLimit: 200,
    htfTimeframe: 60,

    riskPerTradePercent: 1,
    maxPositionPercent: 20,
    maxConcurrentTrades: 3,

    // Pengawas peluang dimatikan dalam pengujian: ia mengirim pesan Telegram
    // dan memanggil scanner, keduanya tidak relevan bagi spec risk/strategi.
    fomoGuardEnabled: true,
    opportunityAlertEnabled: false,
    opportunityMinScore: 70,
    opportunityCooldownHours: 4,
    opportunityMaxPerScan: 2,
    maxDailyLossPercent: 5,
    maxDrawdownPercent: 15,
    maxConsecutiveLosses: 4,
    maxPositionsPerCorrelationGroup: 1,

    atrStopMultiplier: 1.5,
    atrTargetMultiplier: 3,
    entryZoneAtrMultiplier: 0.4,
    minStopPercent: 0.8,
    maxStopPercent: 6,
    breakEvenAtR: 1,
    takeProfitLevels: [
      { atR: 1.0, closePercent: 30 },
      { atR: 2.0, closePercent: 30 },
      { atR: 3.5, closePercent: 40 },
    ],
    trailingAtrMultiplier: 2,
    maxHoldingHours: 48,

    minSignalStrength: 60,
    requireHtfTrend: true,
    minAdx: 20,
    maxChoppiness: 61.8,
    maxSpreadPercent: 0.6,
    minOrderBookImbalance: -0.2,
    minVolumeIdr24h: 500_000_000,
    cooldownMinutesAfterLoss: 60,
    minRiskReward: 1.0,

    slippageTolerancePercent: 0.5,
    orderFillTimeoutSeconds: 90,
    makerEntry: true,
    makerOffsetPercent: 0.02,
    makerFillTimeoutSeconds: 300,
    makerTakeProfit: true,

    tradingEnabled: true,
    ...overrides,
  };
}
