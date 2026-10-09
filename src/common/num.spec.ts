import {
  roundToStep,
  floorToStep,
  decimalsOf,
  toPlainString,
  floorDecimals,
  round,
  clamp,
  mean,
  stdev,
} from './num';

/**
 * Pembulatan harga adalah titik gagal yang sunyi: implementasi lama memakai
 * Math.floor(), yang mengubah harga koin di bawah Rp 1 menjadi 0 dan membuat
 * order ditolak — atau lebih buruk, terkirim dengan nilai yang salah.
 */
describe('num helpers', () => {
  describe('decimalsOf', () => {
    it.each([
      [1000, 0],
      [1, 0],
      [0.1, 1],
      [0.001, 3],
      [0.000001, 6],
      [0.00000001, 8],
    ])('desimal dari %p adalah %p', (step, expected) => {
      expect(decimalsOf(step)).toBe(expected);
    });
  });

  describe('roundToStep', () => {
    it('membulatkan harga BTC ke tick Rp 1.000', () => {
      // btcidr punya pricescale 1000
      expect(roundToStep(1_384_001_499, 1000)).toBe(1_384_001_000);
      expect(roundToStep(1_384_001_500, 1000)).toBe(1_384_002_000);
    });

    it('mempertahankan presisi pada koin sangat murah', () => {
      // pepeidr punya pricescale 0.000001 — Math.floor() akan menghasilkan 0.
      expect(roundToStep(0.00001234, 0.000001)).toBe(0.000012);
      expect(roundToStep(0.00001234, 0.000001)).toBeGreaterThan(0);
    });

    it('membulatkan ke tick bilangan bulat', () => {
      expect(roundToStep(3456.7, 1)).toBe(3457);
      expect(roundToStep(3456.2, 1)).toBe(3456);
    });

    it('mengembalikan nilai apa adanya bila step tidak valid', () => {
      expect(roundToStep(123.456, 0)).toBe(123.456);
      expect(roundToStep(123.456, -1)).toBe(123.456);
    });

    it('tidak menghasilkan galat floating point', () => {
      expect(roundToStep(0.07, 0.01)).toBe(0.07);
      expect(roundToStep(1.005, 0.01)).toBe(1.01);
    });
  });

  describe('floorToStep', () => {
    it('tidak pernah membulatkan naik — kuantitas jual tak boleh melebihi saldo', () => {
      expect(floorToStep(0.123456789, 0.00000001)).toBe(0.12345678);
      expect(floorToStep(9.99, 1)).toBe(9);
    });
  });

  describe('toPlainString', () => {
    it('tidak pernah memakai notasi eksponen', () => {
      // Indodax menolak "1e-7".
      expect(toPlainString(1e-7, 8)).toBe('0.0000001');
      expect(toPlainString(0.00000001, 8)).toBe('0.00000001');
      expect(String(1e-7)).toContain('e'); // membuktikan default JS bermasalah
    });

    it('membuang nol di belakang', () => {
      expect(toPlainString(1.5, 8)).toBe('1.5');
      expect(toPlainString(100, 8)).toBe('100');
    });

    it('menangani nilai besar', () => {
      expect(toPlainString(1_384_001_000, 0)).toBe('1384001000');
    });
  });

  describe('floorDecimals / round', () => {
    it('floorDecimals memotong ke bawah', () => {
      expect(floorDecimals(1.999, 2)).toBe(1.99);
    });
    it('round membulatkan ke terdekat', () => {
      expect(round(1.995, 2)).toBe(2);
      expect(round(1.994, 2)).toBe(1.99);
    });
  });

  describe('clamp / mean / stdev', () => {
    it('clamp membatasi rentang', () => {
      expect(clamp(150, 0, 100)).toBe(100);
      expect(clamp(-5, 0, 100)).toBe(0);
      expect(clamp(50, 0, 100)).toBe(50);
    });

    it('mean mengembalikan 0 untuk array kosong', () => {
      expect(mean([])).toBe(0);
      expect(mean([1, 2, 3])).toBe(2);
    });

    it('stdev menghitung deviasi populasi', () => {
      expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 6);
      expect(stdev([5])).toBe(0);
    });
  });
});
