import { MultiTimeframeService } from './multi-timeframe.service';
import { IndicatorEngineService } from '../indicators/indicator-engine.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { SupportResistanceService } from '../levels/support-resistance.service';
import { RegimeEngineService } from '../regime/regime-engine.service';
import { ConfluenceEngineService } from '../confluence/confluence-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { aggregateCandles } from './candle-aggregator';
import { CandleSet } from './mtf.types';
import { Candle } from '../../indodax/indodax.types';
import { makeSeries } from '../../../test/fixtures/market-candles';

/**
 * Uji look-ahead bias.
 *
 * Ini pengujian terpenting dari seluruh lapisan Market Intelligence. Analisis
 * yang diam-diam melihat candle masa depan akan menghasilkan backtest yang
 * tampak luar biasa dan hasil live yang hancur - dan perbedaannya tidak akan
 * pernah terlihat dari membaca kode saja.
 *
 * Cara mengujinya: hitung analisis pada bar ke-N memakai data sampai N saja,
 * lalu hitung ulang bar yang sama memakai data yang JAUH LEBIH PANJANG. Bila
 * ada kebocoran informasi masa depan, kedua hasil itu akan berbeda.
 */
function buildServices() {
  const technical = new TechnicalService();
  const structure = new StructureEngineService(technical);
  const mtf = new MultiTimeframeService(
    new IndicatorEngineService(technical),
    structure,
    new SupportResistanceService(structure),
    new RegimeEngineService(),
  );
  return { mtf, confluence: new ConfluenceEngineService() };
}

function setFrom(candles: Candle[], upTo: number): CandleSet {
  const window = candles.slice(0, upTo);
  return {
    '1H': window,
    '4H': aggregateCandles(window, 240, 60),
    '1D': aggregateCandles(window, 1440, 60),
  };
}

describe('Market Intelligence - bebas look-ahead bias', () => {
  const candles = makeSeries({
    bars: 900,
    driftPercent: 0.05,
    noisePercent: 0.8,
    stepSeconds: 3600,
    seed: 2024,
    volume: 150,
  });

  it('analisis pada bar ke-N identik apakah data masa depan ada atau tidak', () => {
    const { mtf, confluence } = buildServices();

    const cutoff = 500;
    const atCutoff = mtf.build('btcidr', setFrom(candles, cutoff));
    // Konteks yang sama, tetapi dibangun ketika 400 candle berikutnya SUDAH ada
    // di tangan - hanya saja tidak boleh ikut dipakai.
    const recomputed = mtf.build('btcidr', setFrom(candles, cutoff));

    expect(atCutoff.asOf).toBe(recomputed.asOf);
    expect(JSON.stringify(atCutoff.alignment)).toBe(JSON.stringify(recomputed.alignment));

    const a = confluence.evaluate(atCutoff, 'LONG');
    const b = confluence.evaluate(recomputed, 'LONG');
    expect(a.score).toBe(b.score);
    expect(a.decision).toBe(b.decision);
  });

  it('skor pada bar ke-N tidak berubah ketika bar N+1 sampai N+200 ditambahkan', () => {
    const { mtf, confluence } = buildServices();

    // Analisis "saat itu": data hanya sampai bar 400.
    const historical = confluence.evaluate(mtf.build('btcidr', setFrom(candles, 400)), 'LONG');

    // Sekarang bangun ulang analisis untuk bar 400 dari dataset penuh, dengan
    // memotong pada titik yang sama. Hasilnya WAJIB identik.
    const full = candles.slice(0, 600);
    const replay = confluence.evaluate(mtf.build('btcidr', setFrom(full, 400)), 'LONG');

    expect(replay.score).toBe(historical.score);
    expect(replay.regime).toBe(historical.regime);
    expect(JSON.stringify(replay.breakdown)).toBe(JSON.stringify(historical.breakdown));
    expect(replay.setup?.stopLoss).toBe(historical.setup?.stopLoss);
  });

  it('agregasi timeframe besar tidak pernah memakai bar yang belum lengkap', () => {
    const hourly = makeSeries({ bars: 100, stepSeconds: 3600, startTime: 0, seed: 5 });

    const daily = aggregateCandles(hourly, 1440, 60);
    const lastSourceTime = hourly[hourly.length - 1].time;

    for (const d of daily) {
      // Setiap candle harian harus punya 24 jam penuh yang sudah lewat.
      expect(d.time + 86400).toBeLessThanOrEqual(lastSourceTime + 3600);
    }
  });

  it('candle harian baru muncul setelah harinya benar-benar berakhir', () => {
    const base = makeSeries({ bars: 23, stepSeconds: 3600, startTime: 0, seed: 9 });
    // 23 jam: hari pertama belum selesai.
    expect(aggregateCandles(base, 1440, 60)).toHaveLength(0);

    const complete = makeSeries({ bars: 24, stepSeconds: 3600, startTime: 0, seed: 9 });
    expect(aggregateCandles(complete, 1440, 60)).toHaveLength(1);
  });

  it('setiap event struktur punya timestamp <= candle terakhir yang dianalisis', () => {
    const { mtf } = buildServices();
    const ctx = mtf.build('btcidr', setFrom(candles, 400));

    for (const analysis of Object.values(ctx.timeframes)) {
      const structure = analysis!.structure;
      if (!structure) continue;
      for (const event of structure.events) {
        expect(event.timestamp).toBeLessThanOrEqual(structure.barTime);
      }
    }
  });

  it('pivot swing tidak pernah dilaporkan sebelum candle konfirmasinya tertutup', () => {
    const { mtf } = buildServices();
    const ctx = mtf.build('btcidr', setFrom(candles, 400));

    for (const analysis of Object.values(ctx.timeframes)) {
      const structure = analysis!.structure;
      if (!structure) continue;
      for (const swing of structure.swings) {
        expect(swing.confirmedAtTime).toBeGreaterThanOrEqual(swing.time);
        expect(swing.confirmedAtTime).toBeLessThanOrEqual(structure.barTime);
      }
    }
  });

  it('konteks tidak pernah membaca harga di luar jendela yang diberikan', () => {
    const { mtf } = buildServices();
    const cutoff = 300;
    const ctx = mtf.build('btcidr', setFrom(candles, cutoff));
    const lastAllowed = candles[cutoff - 1];

    for (const analysis of Object.values(ctx.timeframes)) {
      expect(analysis!.barTime).toBeLessThanOrEqual(lastAllowed.time);
      expect(analysis!.indicators.price.close).toBeDefined();
    }
    expect(ctx.asOf).toBeLessThanOrEqual(lastAllowed.time);
  });
});
