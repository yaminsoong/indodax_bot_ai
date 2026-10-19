/**
 * Bahasa untuk operator, bukan untuk programmer.
 *
 * Satu tempat supaya istilah yang sama tidak diterjemahkan berbeda di menu
 * yang berbeda — masalah yang sudah tiga kali terjadi di proyek ini ketika
 * dua jalur kode menjelaskan hal yang sama dengan caranya masing-masing.
 *
 * Aturan yang dipakai di sini:
 *
 * 1. **Sebut akibatnya, bukan namanya.** "Drawdown 15%" tidak memberi tahu
 *    apa pun; "turun 15% dari posisi tertinggi" memberi tahu.
 *
 * 2. **Istilah yang memang dipakai di layar bursa dipertahankan.** Operator
 *    melihat "spread" dan "limit" di Indodax; menerjemahkannya justru membuat
 *    dua kosakata untuk satu hal.
 *
 * 3. **Angka tetap angka.** Menyederhanakan bahasa bukan alasan membulatkan
 *    atau menyembunyikan ketidakpastian.
 */

/** Nama indikator -> apa yang sebenarnya diukurnya. */
export const INDIKATOR: Record<string, string> = {
  EMA: 'arah rata-rata harga',
  RSI: 'seberapa jenuh beli/jual',
  ADX: 'seberapa kuat trennya',
  ATR: 'seberapa jauh harga biasa bergerak',
  MACD: 'pergeseran momentum',
  BOLLINGER: 'lebar sebaran harga',
};

/** Keputusan mesin -> arti praktisnya bagi operator. */
export function artiKeputusan(decision: string): string {
  switch (decision) {
    case 'HIGH_QUALITY_SETUP':
      return 'layak — kualitasnya bagus';
    case 'TRADE_SETUP':
      return 'layak dipertimbangkan';
    case 'NO_TRADE':
      return 'belum layak dibeli';
    case 'WATCH':
      return 'pantau dulu';
    default:
      return decision.toLowerCase().replace(/_/g, ' ');
  }
}

/** Kondisi pasar -> gambaran sehari-hari. */
export function artiKondisi(regime: string): string {
  switch (regime) {
    case 'BULL_TREND':
      return 'sedang naik';
    case 'BEAR_TREND':
      return 'sedang turun';
    case 'SIDEWAYS':
      return 'menyamping, tanpa arah jelas';
    case 'RANGING':
      return 'bolak-balik di satu rentang';
    case 'VOLATILE':
      return 'bergerak liar';
    case 'BREAKOUT':
      return 'baru menembus ke atas';
    case 'DISTRIBUTION':
      return 'ada yang melepas barang';
    case 'ACCUMULATION':
      return 'ada yang mengumpulkan';
    default:
      return regime.toLowerCase().replace(/_/g, ' ');
  }
}

/** Gaya eksekusi -> apa yang terjadi pada ordernya. */
export function artiGayaOrder(maker: boolean): string {
  return maker
    ? 'pasang harga sendiri lalu menunggu (fee lebih murah, bisa tidak kebeli)'
    : 'beli di harga pasar sekarang (pasti kebeli, fee dua kali lebih mahal)';
}

/** Sebab posisi ditutup -> kalimat biasa. */
export function artiSebabTutup(reason: string): string {
  switch (reason) {
    case 'STOP_LOSS':
      return 'kena batas kerugian';
    case 'TRAILING_STOP':
      return 'kena batas kerugian yang sudah dinaikkan';
    case 'TAKE_PROFIT':
      return 'kena target untung';
    case 'STRATEGY_EXIT':
      return 'ditutup karena sinyalnya berbalik';
    case 'MAX_HOLDING_TIME':
      return 'ditutup karena sudah terlalu lama';
    case 'MANUAL_CLOSE':
      return 'ditutup manual oleh Anda';
    case 'PANIC_CLOSE':
      return 'ditutup lewat tombol darurat';
    default:
      return reason.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Penurunan dari titik tertinggi, dijelaskan apa adanya.
 *
 * "Drawdown" adalah istilah yang paling sering disalahpahami: ia BUKAN
 * kerugian total, melainkan jarak dari titik terbaik yang pernah dicapai.
 */
export function jelaskanPenurunan(persen: number, batas: number): string {
  if (persen <= 0) return 'Belum turun dari titik tertinggi.';
  const sisa = Math.max(0, batas - persen);
  return (
    `Sekarang ${persen.toFixed(1)}% di bawah titik tertinggi. ` +
    (sisa > 0
      ? `Bot berhenti sendiri bila mencapai ${batas}% (sisa ${sisa.toFixed(1)}%).`
      : `Sudah melewati batas ${batas}% — bot berhenti membuka posisi baru.`)
  );
}

/**
 * Kelipatan risiko (R) dijelaskan dalam rupiah, bukan huruf.
 *
 * "2R" tidak berarti apa pun sampai dikaitkan dengan jumlah yang dipertaruhkan.
 */
export function jelaskanR(r: number, risikoIdr: number): string {
  const rp = Math.round(Math.abs(r) * risikoIdr);
  const arah = r >= 0 ? 'untung' : 'rugi';
  return `${arah} ${r >= 0 ? '' : '-'}${rp.toLocaleString('id-ID')} (${r.toFixed(2)}x dari yang dipertaruhkan)`;
}

/**
 * Berapa banyak data di belakang sebuah angka.
 *
 * Dipakai agar operator tahu kapan sebuah angka belum layak dipercaya, tanpa
 * perlu memahami galat baku.
 */
export function seberapaYakin(jumlahTrade: number): string {
  if (jumlahTrade === 0) return 'belum ada data';
  if (jumlahTrade < 10) return `baru ${jumlahTrade} trade — terlalu sedikit, anggap belum berarti`;
  if (jumlahTrade < 30) return `${jumlahTrade} trade — masih tipis, bisa berubah banyak`;
  if (jumlahTrade < 100) return `${jumlahTrade} trade — mulai bisa dibaca, belum pasti`;
  return `${jumlahTrade} trade — cukup untuk dipercaya`;
}
