import { PairRegistryService } from './pair-registry.service';

/**
 * Presisi kuantitas per pair.
 *
 * Diperbaiki setelah order LIVE sungguhan gagal pada 2026-10-09:
 *
 *   Pair: MUBARAKIDR
 *   Ukuran: Rp 11.049 (8.05233101)
 *   Indodax: "quantity amount has more precision than allowed (0)"
 *
 * `normalizeCoinAmount` MENGABAIKAN pair-nya — tanda tangannya `(_pair, ...)` —
 * dan selalu memotong ke 8 desimal. Itu benar untuk BTC dan sebagian besar
 * pair, tetapi MUBARAKIDR menuntut `volume_precision: 0` dan
 * `quantity_increment: 1`, yaitu kuantitas bilangan bulat.
 */
describe('Presisi kuantitas per pair', () => {
  let svc: PairRegistryService;

  /** Metadata nyata dari GET /api/pairs, diambil 2026-10-09. */
  const META: Record<string, any> = {
    mubarakidr: {
      id: 'mubarakidr',
      symbol: 'MUBARAKIDR',
      traded_currency: 'mubarak',
      pricescale: 0.001,
      price_round: 3,
      trade_min_base_currency: 10000,
      trade_min_traded_currency: 7.3349167,
      volume_precision: 0,
      quantity_increment: 1,
      trade_fee_percent_taker: 0.2,
      trade_fee_percent_maker: 0.1,
    },
    btcidr: {
      id: 'btcidr',
      symbol: 'BTCIDR',
      traded_currency: 'btc',
      pricescale: 1000,
      price_round: 0,
      trade_min_base_currency: 10000,
      trade_min_traded_currency: 0.00001,
      // volume_precision bernilai 0 untuk SELURUH 476 pair Indodax, termasuk
      // BTC yang jelas menerima 8 desimal. Field itu tidak bisa dipakai.
      volume_precision: 0,
      quantity_increment: 1e-8,
      trade_fee_percent_taker: 0.2,
      trade_fee_percent_maker: 0.1,
    },
  };

  beforeEach(() => {
    svc = Object.create(PairRegistryService.prototype) as PairRegistryService;
    const pairs = new Map<string, any>();
    for (const [id, p] of Object.entries(META)) {
      const priceStep = Number(p.pricescale) > 0 ? Number(p.pricescale) : 1;
      pairs.set(id, {
        id,
        symbol: p.symbol,
        baseCurrency: 'idr',
        tradedCurrency: p.traded_currency,
        priceStep,
        priceDecimals: Number(p.price_round),
        minOrderIdr: Number(p.trade_min_base_currency),
        minOrderCoin: Number(p.trade_min_traded_currency),
        quantityStep: Number(p.quantity_increment) > 0 ? Number(p.quantity_increment) : 1e-8,
        quantityDecimals: Math.max(
          0,
          Math.round(-Math.log10(Number(p.quantity_increment) > 0 ? Number(p.quantity_increment) : 1e-8)),
        ),
        takerFeePercent: Number(p.trade_fee_percent_taker),
        makerFeePercent: Number(p.trade_fee_percent_maker),
        isMaintenance: false,
        isSuspended: false,
      });
    }
    Object.assign(svc, { pairs, logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
  });

  // ─── Kasus kegagalan sungguhan ───────────────────────────────────────────

  it('membulatkan kuantitas MUBARAKIDR menjadi bilangan bulat', () => {
    // Angka persis dari order yang gagal.
    expect(svc.normalizeCoinAmount('mubarakidr', 8.05233101)).toBe(8);
  });

  it('memformat kuantitas MUBARAKIDR tanpa desimal', () => {
    // Inilah yang dikirim ke API. "8.05233101" ditolak; "8" diterima.
    expect(svc.formatCoinAmount('mubarakidr', 8.05233101)).toBe('8');
  });

  it('TIDAK membulatkan ke atas — pembulatan atas bisa melebihi saldo', () => {
    expect(svc.normalizeCoinAmount('mubarakidr', 8.99)).toBe(8);
    expect(svc.normalizeCoinAmount('mubarakidr', 7.999)).toBe(7);
  });

  // ─── Pair lain tidak boleh ikut kehilangan presisi ───────────────────────

  it('BTC tetap memakai 8 desimal', () => {
    expect(svc.normalizeCoinAmount('btcidr', 0.00012345678)).toBeCloseTo(0.00012345, 10);
    expect(svc.formatCoinAmount('btcidr', 0.00012345678)).toBe('0.00012345');
  });

  it('presisi dibaca per pair, bukan satu nilai untuk semua', () => {
    expect(svc.quantityDecimals('mubarakidr')).toBe(0);
    expect(svc.quantityDecimals('btcidr')).toBe(8);
  });

  // ─── quantity_increment ──────────────────────────────────────────────────

  it('kelipatan yang lebih kasar dari presisi desimal yang menentukan', () => {
    // Pair hipotetis: presisi 2 desimal tetapi kelipatan wajib 5.
    (svc as any).pairs.set('xidr', {
      ...(svc as any).pairs.get('btcidr'),
      id: 'xidr',
      quantityDecimals: 0,
      quantityStep: 5,
    });
    expect(svc.normalizeCoinAmount('xidr', 13.7)).toBe(10);
    expect(svc.normalizeCoinAmount('xidr', 19.99)).toBe(15);
  });

  // ─── Masukan menyimpang ──────────────────────────────────────────────────

  it('kuantitas nol atau negatif menghasilkan nol', () => {
    expect(svc.normalizeCoinAmount('mubarakidr', 0)).toBe(0);
    expect(svc.normalizeCoinAmount('mubarakidr', -5)).toBe(0);
  });

  it('kuantitas di bawah satu unit utuh menjadi nol, bukan dibulatkan naik', () => {
    // Penting: 0,9 unit pada pair presisi 0 TIDAK bisa dipesan. Membulatkan
    // naik ke 1 akan memesan lebih banyak daripada yang dianggarkan.
    expect(svc.normalizeCoinAmount('mubarakidr', 0.9)).toBe(0);
  });

  it('pair yang metadatanya belum termuat memakai presisi paling longgar', () => {
    // Tidak melempar: lebih baik presisi 8 daripada menggagalkan seluruh alur.
    expect(svc.normalizeCoinAmount('belumadaidr', 1.123456789)).toBeCloseTo(1.12345678, 10);
  });

  it('quantity_increment yang hilang memakai 8 desimal, bukan nol', () => {
    (svc as any).pairs.set('yidr', {
      ...(svc as any).pairs.get('btcidr'),
      id: 'yidr',
      quantityDecimals: 8,
      quantityStep: 0,
    });
    expect(svc.normalizeCoinAmount('yidr', 1.5)).toBeCloseTo(1.5, 10);
  });

  it('volume_precision DIABAIKAN — nilainya 0 untuk semua pair', () => {
    // Kalau field itu dipakai sebagai presisi, BTC akan dibulatkan menjadi
    // bilangan bulat dan seluruh order BTC rusak. Diukur langsung: 476 dari
    // 476 pair Indodax melaporkan volume_precision 0.
    expect(META.btcidr.volume_precision).toBe(0);
    expect(svc.quantityDecimals('btcidr')).toBe(8);
    expect(svc.formatCoinAmount('btcidr', 8.05233101)).toBe('8.05233101');
  });

  // ─── Konsekuensi nilai order ─────────────────────────────────────────────

  it('pembulatan ke bawah bisa menjatuhkan nilai order di bawah minimum', () => {
    // Bukan bug, tetapi sifat yang HARUS divalidasi setelah pembulatan —
    // bukan sebelumnya. Dengan harga 1372: anggaran Rp10.100 memberi qty
    // 7,3615 yang dipotong menjadi 7, bernilai Rp9.604 — di bawah Rp10.000.
    const harga = 1372;
    const qty = svc.normalizeCoinAmount('mubarakidr', 10100 / harga);
    expect(qty).toBe(7);
    expect(qty * harga).toBeLessThan(10000);
  });

  it('anggaran yang cukup tetap lolos setelah pembulatan', () => {
    const harga = 1372;
    const qty = svc.normalizeCoinAmount('mubarakidr', 11049 / harga);
    expect(qty).toBe(8);
    expect(qty * harga).toBeGreaterThanOrEqual(10000);
    expect(qty).toBeGreaterThanOrEqual(7.3349167);
  });
});
