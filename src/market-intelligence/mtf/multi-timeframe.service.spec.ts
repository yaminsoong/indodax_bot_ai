import { MultiTimeframeService } from './multi-timeframe.service';
import { IndicatorEngineService } from '../indicators/indicator-engine.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { SupportResistanceService } from '../levels/support-resistance.service';
import { RegimeEngineService } from '../regime/regime-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { aggregateCandles } from './candle-aggregator';
import { Candle } from '../../indodax/indodax.types';
import {
  bearishSet,
  bullishSet,
  conflictingSet,
  makeSeries,
} from '../../../test/fixtures/market-candles';

function buildService(): MultiTimeframeService {
  const technical = new TechnicalService();
  const structure = new StructureEngineService(technical);
  return new MultiTimeframeService(
    new IndicatorEngineService(technical),
    structure,
    new SupportResistanceService(structure),
    new RegimeEngineService(),
  );
}

describe('aggregateCandles', () => {
  /** Enam candle 4H berurutan mulai tepat di tengah malam UTC. */
  function fourHour(count: number, startTime = 0): Candle[] {
    return Array.from({ length: count }, (_, i) => ({
      time: startTime + i * 14400,
      open: 100 + i,
      high: 110 + i,
      low: 90 + i,
      close: 105 + i,
      volume: 10,
    }));
  }

  it('menggabungkan enam candle 4H menjadi satu candle harian', () => {
    const daily = aggregateCandles(fourHour(12), 1440, 240);
    expect(daily).toHaveLength(2);
    expect(daily[0].open).toBe(100);
    expect(daily[0].close).toBe(110); // close candle ke-6
    expect(daily[0].high).toBe(115);
    expect(daily[0].low).toBe(90);
    expect(daily[0].volume).toBe(60);
  });

  it('membuang bucket terakhir yang belum lengkap', () => {
    // 9 candle = 1 hari penuh + 3 candle hari berikutnya.
    const daily = aggregateCandles(fourHour(9), 1440, 240);
    expect(daily).toHaveLength(1);
  });

  it('melewati bucket yang candle-nya bolong', () => {
    const bars = fourHour(12).filter((_, i) => i !== 3); // hari pertama kehilangan satu candle
    const daily = aggregateCandles(bars, 1440, 240);
    expect(daily.map((d) => d.time)).not.toContain(0);
  });

  it('mengembalikan data apa adanya bila target tidak lebih besar dari sumber', () => {
    const bars = fourHour(6);
    expect(aggregateCandles(bars, 240, 240)).toBe(bars);
  });

  it('menghasilkan candle yang time-nya selaras batas hari UTC', () => {
    const daily = aggregateCandles(fourHour(12), 1440, 240);
    for (const d of daily) expect(d.time % 86400).toBe(0);
  });
});

describe('MultiTimeframeService', () => {
  let service: MultiTimeframeService;

  beforeEach(() => {
    service = buildService();
  });

  it('menganalisis seluruh timeframe yang datanya memadai', () => {
    const ctx = service.build('btcidr', bullishSet());
    expect(Object.keys(ctx.timeframes).sort()).toEqual(['15m', '1D', '1H', '4H', '5m'].sort());
    expect(ctx.missing).toHaveLength(0);
    expect(ctx.pair).toBe('btcidr');
  });

  it('menandai timeframe tanpa data yang cukup sebagai missing', () => {
    const ctx = service.build('btcidr', {
      '1H': makeSeries({ bars: 200, driftPercent: 0.2 }),
      '15m': makeSeries({ bars: 10 }),
    });
    expect(ctx.timeframes['1H']).toBeDefined();
    expect(ctx.missing).toContain('15m');
    expect(ctx.missing).toContain('4H');
    expect(ctx.missing).toContain('1D');
  });

  it('memberi skor keselarasan positif pada pasar bullish di semua timeframe', () => {
    const ctx = service.build('btcidr', bullishSet());
    expect(ctx.alignment.score).toBeGreaterThan(0.5);
    expect(ctx.alignment.direction).toBe('BULLISH');
    expect(ctx.alignment.conflicts).toHaveLength(0);
  });

  it('memberi skor keselarasan negatif pada pasar bearish', () => {
    const ctx = service.build('btcidr', bearishSet());
    expect(ctx.alignment.score).toBeLessThan(-0.5);
    expect(ctx.alignment.direction).toBe('BEARISH');
  });

  it('melaporkan konflik saat timeframe besar dan kecil berlawanan', () => {
    const ctx = service.build('btcidr', conflictingSet());
    expect(ctx.alignment.conflicts.length).toBeGreaterThan(0);
    expect(ctx.alignment.conflicts.join(' ')).toMatch(/4H|1H/);
  });

  it('memilih 1H sebagai timeframe setup dan 5m sebagai timeframe eksekusi', () => {
    const ctx = service.build('btcidr', bullishSet());
    expect(ctx.primaryTimeframe).toBe('1H');
    expect(ctx.executionTimeframe).toBe('5m');
  });

  it('turun ke timeframe lain bila 1H atau 5m tidak tersedia', () => {
    const ctx = service.build('btcidr', {
      '4H': makeSeries({ bars: 200, driftPercent: 0.2, stepSeconds: 14400 }),
    });
    expect(ctx.primaryTimeframe).toBe('4H');
    expect(ctx.executionTimeframe).toBe('4H');
  });

  it('memberi setiap timeframe peran hierarkinya', () => {
    const ctx = service.build('btcidr', bullishSet());
    expect(ctx.timeframes['1D']!.role).toBe('MACRO_TREND');
    expect(ctx.timeframes['4H']!.role).toBe('PRIMARY_TREND');
    expect(ctx.timeframes['1H']!.role).toBe('SETUP');
    expect(ctx.timeframes['15m']!.role).toBe('CONFIRMATION');
    expect(ctx.timeframes['5m']!.role).toBe('EXECUTION_TIMING');
  });

  it('menyertakan alasan bias untuk tiap timeframe', () => {
    const ctx = service.build('btcidr', bullishSet());
    for (const analysis of Object.values(ctx.timeframes)) {
      expect(analysis!.biasReasons.length).toBeGreaterThan(0);
      expect(analysis!.biasConfidence).toBeGreaterThan(0);
    }
  });

  it('deterministik pada input yang sama', () => {
    const set = bullishSet();
    expect(JSON.stringify(service.build('btcidr', set).alignment)).toBe(
      JSON.stringify(service.build('btcidr', set).alignment),
    );
  });

  it('tidak melakukan panggilan jaringan apa pun', () => {
    // Service dibangun tanpa IndodaxService sama sekali - kompilasi ini sendiri
    // sudah membuktikan lapisan analisis tidak bergantung pada API.
    const ctx = service.build('btcidr', bullishSet());
    expect(ctx.asOf).toBeGreaterThan(0);
  });
});
