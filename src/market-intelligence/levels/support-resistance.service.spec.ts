import { SupportResistanceService } from './support-resistance.service';
import { StructureEngineService } from '../structure/structure-engine.service';
import { TechnicalService } from '../../indicators/technical.service';
import { Candle } from '../../indodax/indodax.types';

function bar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  return { time: i * 3600, open, high, low, close, volume };
}

/**
 * Pasar yang berayun antara 100 dan 120 berulang kali, lalu berhenti di tengah.
 * Bentuk ini memberi sentuhan berulang tepat di dua level.
 */
function rangeMarket(cycles = 8, low = 100, high = 120): Candle[] {
  const out: Candle[] = [];
  let i = 0;
  for (let c = 0; c < cycles; c++) {
    out.push(bar(i++, low + 2, low + 6, low, low + 5)); // menyentuh dasar
    out.push(bar(i++, low + 6, low + 12, low + 5, low + 11));
    out.push(bar(i++, high - 6, high, high - 8, high - 2)); // menyentuh puncak
    out.push(bar(i++, high - 3, high - 1, high - 10, high - 9));
  }
  for (let k = 0; k < 6; k++) out.push(bar(i++, 110, 111, 109, 110));
  return out;
}

describe('SupportResistanceService', () => {
  let service: SupportResistanceService;

  beforeEach(() => {
    const technical = new TechnicalService();
    service = new SupportResistanceService(new StructureEngineService(technical));
  });

  it('mengembalikan null bila candle terlalu sedikit', () => {
    expect(service.analyze('1H', [bar(0, 1, 1, 1, 1)])).toBeNull();
  });

  it('menemukan zona di dekat batas atas dan bawah rentang', () => {
    const report = service.analyze('1H', rangeMarket())!;
    expect(report.zones.length).toBeGreaterThan(0);

    const nearLow = report.zones.some((z) => z.priceLow <= 102 && z.priceHigh >= 98);
    const nearHigh = report.zones.some((z) => z.priceLow <= 122 && z.priceHigh >= 118);
    expect(nearLow).toBe(true);
    expect(nearHigh).toBe(true);
  });

  it('mengklasifikasi zona di bawah harga sebagai support dan di atasnya sebagai resistance', () => {
    const report = service.analyze('1H', rangeMarket())!;
    for (const z of report.zones) {
      if (z.priceHigh < report.price) {
        expect(['SUPPORT', 'STRONG_SUPPORT']).toContain(z.type);
      } else if (z.priceLow > report.price) {
        expect(['RESISTANCE', 'STRONG_RESISTANCE']).toContain(z.type);
      } else {
        expect(z.type).toBe('PIVOT');
      }
    }
  });

  it('menghitung support dan resistance terdekat beserta posisi harga dalam rentang', () => {
    const report = service.analyze('1H', rangeMarket())!;
    expect(report.nearestSupport).not.toBeNull();
    expect(report.nearestResistance).not.toBeNull();
    expect(report.nearestSupport!.price).toBeLessThan(report.price);
    expect(report.nearestResistance!.price).toBeGreaterThan(report.price);
    expect(report.positionInRange).not.toBeNull();
    expect(report.positionInRange!).toBeGreaterThanOrEqual(0);
    expect(report.positionInRange!).toBeLessThanOrEqual(1);
  });

  it('memberi kekuatan lebih tinggi pada level yang lebih sering disentuh', () => {
    const many = service.analyze('1H', rangeMarket(10))!;
    const few = service.analyze('1H', rangeMarket(4))!;

    const strongestMany = Math.max(...many.zones.map((z) => z.strength));
    const strongestFew = Math.max(...few.zones.map((z) => z.strength));
    expect(strongestMany).toBeGreaterThanOrEqual(strongestFew);
  });

  it('tidak menghitung candle beruntun di dalam zona sebagai banyak sentuhan', () => {
    // Harga diam di 100 selama 60 candle: itu SATU kunjungan, bukan 60 penolakan.
    const flat = Array.from({ length: 60 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    const spike = [bar(60, 100, 140, 99, 138), bar(61, 138, 139, 130, 132), bar(62, 132, 133, 128, 130)];
    const report = service.analyze('1H', [...flat, ...spike])!;
    const nearHundred = report.zones.find((z) => z.priceLow <= 101 && z.priceHigh >= 99);
    if (nearHundred) expect(nearHundred.touchCount).toBeLessThan(5);
  });

  it('menggabungkan level yang sangat berdekatan menjadi satu zona', () => {
    const report = service.analyze('1H', rangeMarket(), null, {
      clusterTolerancePercent: 5,
    })!;
    // Dengan toleransi sangat lebar, jumlah zona harus menyusut drastis.
    const tight = service.analyze('1H', rangeMarket(), null, {
      clusterTolerancePercent: 0.05,
    })!;
    expect(report.zones.length).toBeLessThanOrEqual(tight.zones.length);
  });

  it('menandai zona yang sedang ditempati harga sebagai PIVOT', () => {
    const candles = rangeMarket();
    const report = service.analyze('1H', candles, null, { clusterTolerancePercent: 8 })!;
    const inside = report.zones.filter(
      (z) => report.price >= z.priceLow && report.price <= z.priceHigh,
    );
    for (const z of inside) expect(z.type).toBe('PIVOT');
  });

  it('deterministik pada input yang sama', () => {
    const candles = rangeMarket();
    expect(JSON.stringify(service.analyze('1H', candles))).toBe(
      JSON.stringify(service.analyze('1H', candles)),
    );
  });
});
