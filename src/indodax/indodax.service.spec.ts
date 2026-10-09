import { IndodaxService } from './indodax.service';

/**
 * Timeframe yang salah adalah kegagalan sunyi: API menolaknya, data candle
 * kosong, dan gejalanya identik dengan "tidak ada peluang trading". Bot lama
 * berjalan berbulan-bulan tanpa satu sinyal pun karena hal serupa.
 */
describe('IndodaxService.isValidTimeframe', () => {
  it.each([1, 5, 15, 30, 60, 240])('menerima %p menit', (tf) => {
    expect(IndodaxService.isValidTimeframe(tf)).toBe(true);
  });

  it.each([360, 720, 2, 45, 0, -15, 1440])('menolak %p menit', (tf) => {
    expect(IndodaxService.isValidTimeframe(tf)).toBe(false);
  });

  it('menolak 360 dan 720 walau terlihat wajar sebagai 6 dan 12 jam', () => {
    // Diverifikasi langsung terhadap API Indodax: keduanya dibalas
    // "invalid TimeFrame".
    expect(IndodaxService.isValidTimeframe(360)).toBe(false);
    expect(IndodaxService.isValidTimeframe(720)).toBe(false);
  });

  it('mengekspos daftar timeframe valid untuk pesan error', () => {
    expect([...IndodaxService.VALID_TIMEFRAMES]).toEqual([1, 5, 15, 30, 60, 240]);
  });
});
