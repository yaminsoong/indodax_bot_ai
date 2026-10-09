import { Injectable } from '@nestjs/common';

/**
 * Nama panjang per simbol, untuk mengenali berita yang tidak menyebut tickernya.
 *
 * Hanya memuat koin yang namanya benar-benar dipakai di berita. Daftar ini
 * tidak perlu lengkap: koin yang tidak terdaftar masih dikenali lewat
 * tickernya, hanya tidak lewat namanya.
 */
const COIN_NAMES: Record<string, string[]> = {
  btc: ['bitcoin'],
  eth: ['ethereum', 'ether'],
  bnb: ['binance coin', 'bnb chain'],
  sol: ['solana'],
  xrp: ['ripple'],
  ada: ['cardano'],
  doge: ['dogecoin'],
  matic: ['polygon'],
  dot: ['polkadot'],
  avax: ['avalanche'],
  link: ['chainlink'],
  ltc: ['litecoin'],
  trx: ['tron'],
  atom: ['cosmos'],
  near: ['near protocol'],
  arb: ['arbitrum'],
  op: ['optimism'],
  sui: ['sui network'],
  apt: ['aptos'],
  ton: ['toncoin'],
  shib: ['shiba inu'],
  pepe: ['pepe coin'],
  usdt: ['tether'],
  usdc: ['usd coin'],
};

/**
 * Ticker yang juga merupakan kata bahasa Inggris biasa.
 *
 * Untuk simbol-simbol ini, ticker SAJA tidak pernah cukup — harus ada kata
 * pendukung konteks crypto di judul yang sama. Tanpa aturan ini "Trump signs
 * OP-ED on tariffs" terbaca sebagai berita Optimism, dan "ATOM smashing
 * experiment" sebagai berita Cosmos.
 */
const AMBIGUOUS_TICKERS = new Set([
  'op', 'atom', 'near', 'link', 'sui', 'apt', 'ton', 'arb', 'ada', 'dot', 'sand', 'gas', 'id', 'win', 'ray', 'jup', 'me',
]);

/** Kata yang membuktikan sebuah judul memang berbicara soal crypto. */
const CRYPTO_CONTEXT = [
  'crypto', 'cryptocurrency', 'blockchain', 'token', 'coin', 'altcoin',
  'defi', 'web3', 'onchain', 'on-chain', 'staking', 'exchange', 'wallet',
  'bitcoin', 'ethereum', 'binance', 'coinbase', 'kripto', 'nft', 'airdrop',
  'mainnet', 'testnet', 'validator', 'protocol', 'ledger', 'satoshi',
];

/** Kata yang menandakan berita menyangkut seluruh pasar, bukan satu koin. */
const MARKET_WIDE = [
  'crypto market', 'cryptocurrency market', 'altcoins', 'altcoin season',
  'total market cap', 'risk-off', 'risk-on', 'federal reserve', 'fomc',
  'interest rate', 'inflation', 'cpi', 'regulation', 'sec ', 'ojk',
  'market crash', 'bull market', 'bear market', 'liquidations',
];

/**
 * Mencocokkan judul berita dengan simbol koin.
 *
 * Masalah yang diselesaikan di sini halus tapi merusak bila dibiarkan:
 * pencocokan substring sederhana membuat "SOL" cocok dengan "solution",
 * "solar", dan "sold". Satu berita tentang panel surya kemudian menjadi
 * "sentimen Solana negatif" dan menahan entry yang sebenarnya baik.
 */
@Injectable()
export class CoinMatcherService {
  /**
   * Simbol koin yang disebut judul ini.
   *
   * `universe` membatasi pencarian pada koin yang benar-benar diperdagangkan —
   * tidak ada gunanya mengenali koin yang tidak ada di Indodax.
   */
  match(title: string, universe: string[]): string[] {
    const text = title.toLowerCase();
    const hasCryptoContext = CRYPTO_CONTEXT.some((c) => text.includes(c));
    const found = new Set<string>();

    for (const raw of universe) {
      const symbol = raw.toLowerCase();

      // Nama panjang cukup berdiri sendiri: "Solana" tidak ambigu.
      const names = COIN_NAMES[symbol] ?? [];
      if (names.some((n) => text.includes(n))) {
        found.add(symbol);
        continue;
      }

      if (!this.tickerPresent(text, symbol)) continue;

      // Ticker ambigu hanya diterima bila judulnya terbukti soal crypto.
      if (AMBIGUOUS_TICKERS.has(symbol) && !hasCryptoContext) continue;

      // Ticker satu-dua huruf terlalu sering kebetulan; selalu butuh konteks.
      if (symbol.length <= 2 && !hasCryptoContext) continue;

      found.add(symbol);
    }

    return [...found];
  }

  /** True bila judulnya berbicara tentang pasar secara keseluruhan. */
  isMarketWide(title: string): boolean {
    const text = title.toLowerCase();
    return MARKET_WIDE.some((m) => text.includes(m));
  }

  /**
   * Ticker harus berdiri sebagai kata utuh.
   *
   * Batas kata memakai kelas karakter eksplisit alih-alih `\b` karena `\b`
   * menganggap tanda hubung sebagai batas, sehingga "non-btc" ikut cocok.
   */
  private tickerPresent(text: string, symbol: string): boolean {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`, 'i').test(text);
  }
}
