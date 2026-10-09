export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  high: number;
  low: number;
  last: number;
  buy: number;   // best bid
  sell: number;  // best ask
  volume_idr: number;
  volume_coin: number;
  /** Dihitung dari /api/summaries (prices_24h); ticker Indodax TIDAK menyediakannya. */
  percent_change_24h: number;
  spreadPercent: number;
}

export interface Balance {
  idr: number;
  [coin: string]: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  data?: any;
}

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'unknown';

/** Hasil rekonsiliasi order dengan exchange — sumber kebenaran untuk entry/exit. */
export interface OrderFill {
  orderId: string;
  status: OrderStatus;
  /** Kuantitas koin yang benar-benar tereksekusi. */
  filledCoin: number;
  /** Nilai IDR yang benar-benar tereksekusi (sebelum fee). */
  filledIdr: number;
  /** Harga rata-rata eksekusi; 0 bila belum ada fill. */
  avgPrice: number;
  /** Fee dalam IDR yang dibebankan (estimasi bila API tidak menyediakan). */
  feeIdr: number;
  raw?: any;
}

export interface OrderBook {
  buy: number[][];  // [price, amount]
  sell: number[][];
}
