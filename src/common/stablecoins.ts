/**
 * Pair stablecoin terhadap rupiah.
 *
 * Dikecualikan dari pemilihan pair otomatis maupun pemindaian pasar: volumenya
 * terbesar di Indodax (USDT/IDR sendiri melampaui BTC/IDR beberapa kali lipat),
 * tetapi pergerakan harganya adalah kurs rupiah — bukan perilaku aset kripto
 * yang bisa dimanfaatkan strategi momentum. Membiarkannya ikut berarti puncak
 * peringkat hampir selalu diisi pair yang tidak pernah benar-benar ingin
 * ditradingkan.
 *
 * Daftarnya berada di satu tempat agar scanner dan pemilih semesta trading
 * tidak pernah berbeda pendapat tentang apa yang dianggap stablecoin.
 */
export const STABLECOIN_IDR_PAIRS: ReadonlySet<string> = new Set([
  'usdtidr',
  'usdcidr',
  'daiidr',
  'busdidr',
  'tusdidr',
  'usdpidr',
  'fdusdidr',
]);

export function isStablecoinPair(pair: string): boolean {
  return STABLECOIN_IDR_PAIRS.has(pair.toLowerCase());
}
