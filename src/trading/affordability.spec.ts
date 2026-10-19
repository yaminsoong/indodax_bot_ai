import { AffordabilityService } from './affordability.service';
import { makeParams } from '../../test/fixtures/bot-params';
import { BotParams } from '../config/bot-config.service';

/**
 * Menjawab "pair mana yang benar-benar bisa saya beli dengan saldo sekarang".
 *
 * Risk Engine sudah menolak order di bawah minimum, tetapi penolakannya terjadi
 * SETELAH sinyal muncul. Operator bermodal kecil karena itu tidak bisa
 * membedakan dua keadaan yang tindakannya berlawanan: tidak ada peluang
 * (tunggu) versus tidak ada peluang yang mampu dibeli (tambah modal).
 *
 * Angka yang dipakai di sini diukur dari akun sungguhan: saldo Rp16.998,
 * minimum order Indodax Rp10.000 untuk SELURUH 464 pair IDR tanpa kecuali.
 */
describe('AffordabilityService', () => {
  let svc: AffordabilityService;
  let params: BotParams;

  const SALDO = 16_998;

  beforeEach(() => {
    params = makeParams({
      riskPerTradePercent: 1.5,
      maxPositionPercent: 65,
      atrStopMultiplier: 1.5,
      minStopPercent: 0.8,
    });

    svc = new AffordabilityService(
      {
        require: () => ({ minOrderIdr: 10_000 }),
        takerFeeRate: () => 0.002,
      } as any,
      { params: () => params } as any,
    );
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
  });

  // ─── Kasus nyata dari akun pengguna ──────────────────────────────────────

  it('DOGE mampu dibeli dengan saldo Rp16.998', () => {
    // ATR 0,77% -> stop 1,155% -> posisi = 255/0,01155 = Rp22.078,
    // dibatasi 65% ekuitas = Rp11.049. Di atas minimum Rp10.000.
    const r = svc.check('dogeidr', SALDO, 0.77);
    expect(r.status).toBe('MAMPU');
    expect(r.cappedIdr).toBeCloseTo(SALDO * 0.65, 0);
  });

  it('FARTCOIN mampu dibeli — stop lebar tetapi masih lolos', () => {
    const r = svc.check('fartcoinidr', SALDO, 1.66);
    expect(r.status).toBe('MAMPU');
    expect(r.cappedIdr).toBeGreaterThanOrEqual(10_000);
  });

  it('pair ber-ATR sangat tinggi DITOLAK walau sama likuidnya', () => {
    // ATR 7% -> stop 10,5% -> posisi = 255/0,105 = Rp2.428. Di bawah minimum.
    // Inilah yang melawan dugaan lazim: gejolak tinggi butuh modal LEBIH besar.
    const r = svc.check('rlcidr', SALDO, 7.0);
    expect(r.status).toBe('DI_BAWAH_MINIMUM');
    expect(r.minEquityNeededIdr).toBeGreaterThan(SALDO);
  });

  it('menyebut ekuitas minimum yang dibutuhkan, bukan hanya menolak', () => {
    // Tanpa angka ini operator tidak tahu harus menambah berapa.
    const r = svc.check('rlcidr', SALDO, 7.0);
    expect(r.reason).toMatch(/Butuh ekuitas minimal Rp/);
    expect(r.minEquityNeededIdr).toBeGreaterThan(0);
  });

  // ─── Pembatas mana yang mengikat ─────────────────────────────────────────

  it('pada ATR rendah, batas porsi ekuitas yang mengikat', () => {
    const r = svc.check('btcidr', SALDO, 0.36);
    // Posisi alami jauh melebihi 65% ekuitas, jadi dipotong ke batas itu.
    expect(r.requestedIdr).toBeGreaterThan(r.cappedIdr);
    expect(r.equitySharePercent).toBeCloseTo(65, 0);
  });

  it('pada ATR tinggi, jatah risiko yang mengikat', () => {
    const r = svc.check('xidr', SALDO, 5.0);
    // Posisi alami sudah di bawah batas porsi, jadi tidak dipotong.
    expect(r.cappedIdr).toBeCloseTo(r.requestedIdr, 5);
  });

  it('ekuitas minimum mengambil pembatas yang paling ketat', () => {
    const rendah = svc.check('aidr', SALDO, 0.36);
    const tinggi = svc.check('bidr', SALDO, 7.0);
    // Stop lebar menuntut ekuitas lebih besar.
    expect(tinggi.minEquityNeededIdr).toBeGreaterThan(rendah.minEquityNeededIdr);
  });

  // ─── Modal Rp20.000 yang diminta pengguna ────────────────────────────────

  it('Rp20.000 cukup untuk pair ber-ATR rendah', () => {
    expect(svc.check('dogeidr', 20_000, 0.77).status).toBe('MAMPU');
  });

  it('Rp20 TIDAK cukup untuk apa pun', () => {
    // Minimum Indodax Rp10.000 berlaku untuk seluruh 464 pair IDR.
    const r = svc.check('dogeidr', 20, 0.77);
    expect(r.status).toBe('DI_BAWAH_MINIMUM');
  });

  it('batas porsi 20% membuat Rp20.000 tidak cukup sama sekali', () => {
    // Menjelaskan mengapa batas itu harus dinaikkan pada akun kecil:
    // 20% x Rp20.000 = Rp4.000, di bawah minimum Rp10.000.
    params = makeParams({ maxPositionPercent: 20, riskPerTradePercent: 1.5 });
    expect(svc.check('dogeidr', 20_000, 0.77).status).toBe('DI_BAWAH_MINIMUM');
    expect(svc.check('dogeidr', 20_000, 0.77).minEquityNeededIdr).toBe(50_000);
  });

  // ─── Fee ikut dihitung ───────────────────────────────────────────────────

  it('fee entry harus ikut tersedia', () => {
    // Posisi tepat sebesar ekuitas akan gagal karena fee belum terhitung.
    params = makeParams({ riskPerTradePercent: 1.5, maxPositionPercent: 100 });
    const r = svc.check('dogeidr', 10_050, 0.77);
    expect(['DANA_KURANG', 'DI_BAWAH_MINIMUM']).toContain(r.status);
  });

  // ─── Data tidak lengkap ──────────────────────────────────────────────────

  it('ATR tidak diketahui memakai stop minimum, bukan menebak', () => {
    const r = svc.check('dogeidr', SALDO, null);
    expect(r.stopPercent).toBe(params.minStopPercent);
    expect(r.status).toBe('MAMPU');
  });

  it('ekuitas nol dilaporkan TIDAK DIKETAHUI, bukan MAMPU', () => {
    expect(svc.check('dogeidr', 0, 0.77).status).toBe('TIDAK_DIKETAHUI');
  });

  it('metadata pair belum termuat tetap memakai minimum Indodax yang berlaku', () => {
    svc = new AffordabilityService(
      {
        require: () => {
          throw new Error('belum termuat');
        },
        takerFeeRate: () => {
          throw new Error('belum termuat');
        },
      } as any,
      { params: () => params } as any,
    );
    jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);

    const r = svc.check('belumadaidr', SALDO, 0.77);
    expect(r.minOrderIdr).toBe(10_000);
    expect(r.status).toBe('MAMPU');
  });

  // ─── Pengurutan ──────────────────────────────────────────────────────────

  it('yang MAMPU didahulukan, lalu yang butuh modal paling sedikit', () => {
    const hasil = svc.checkMany(
      [
        { pair: 'rlcidr', atrPercent: 7.0 },
        { pair: 'dogeidr', atrPercent: 0.77 },
        { pair: 'xidr', atrPercent: 4.0 },
      ],
      SALDO,
    );

    expect(hasil[0].pair).toBe('dogeidr');
    expect(hasil[0].status).toBe('MAMPU');
    // Yang tidak mampu diurutkan dari yang paling dekat terjangkau.
    const gagal = hasil.filter((h) => h.status !== 'MAMPU');
    for (let i = 1; i < gagal.length; i++) {
      expect(gagal[i].minEquityNeededIdr).toBeGreaterThanOrEqual(gagal[i - 1].minEquityNeededIdr);
    }
  });

  it('daftar kosong tidak melempar', () => {
    expect(svc.checkMany([], SALDO)).toEqual([]);
  });
});
