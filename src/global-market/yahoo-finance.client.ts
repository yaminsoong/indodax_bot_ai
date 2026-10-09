import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface YahooQuote {
  price: number;
  previousClose: number;
  /** Epoch detik waktu harga terakhir menurut Yahoo. */
  quotedAtSec: number;
  currency: string;
}

/**
 * Pengambil harga instrumen makro dari Yahoo Finance.
 *
 * Memakai endpoint chart (`/v8/finance/chart/<simbol>`) dan BUKAN endpoint
 * quote (`/v7/finance/quote`): per Oktober 2026 endpoint quote membalas
 * `Unauthorized` tanpa kredensial, sementara endpoint chart masih terbuka.
 * Diverifikasi langsung, bukan diasumsikan.
 *
 * Satu permintaan per simbol — endpoint ini tidak menerima banyak simbol
 * sekaligus. Karena instrumen makro bergerak lambat dan pasarnya tutup
 * berjam-jam setiap hari, hasilnya di-cache agar tidak membebani sumber.
 */
@Injectable()
export class YahooFinanceClient {
  private readonly logger = new Logger(YahooFinanceClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://query1.finance.yahoo.com',
      timeout: 15000,
      headers: {
        // Tanpa User-Agent peramban, Yahoo membalas 429 untuk sebagian wilayah.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'application/json',
      },
    });
  }

  /**
   * Ambil harga satu simbol.
   *
   * Melempar bila simbol tidak dikenal atau sumber tidak menjawab; pemanggil
   * yang memutuskan apakah ketidaktersediaan itu fatal. Lapisan ini tidak
   * pernah mengarang nilai pengganti — instrumen yang hilang harus terlihat
   * hilang, bukan terbaca sebagai nol persen perubahan.
   */
  async getQuote(sourceSymbol: string): Promise<YahooQuote> {
    const path = `/v8/finance/chart/${encodeURIComponent(sourceSymbol)}`;
    const res = await this.http.get(path, {
      params: { range: '5d', interval: '1d' },
    });

    const result = res.data?.chart?.result?.[0];
    const error = res.data?.chart?.error;
    if (error) {
      throw new Error(`Yahoo menolak ${sourceSymbol}: ${error.description ?? error.code}`);
    }

    const meta = result?.meta;
    if (!meta) {
      throw new Error(`Balasan Yahoo untuk ${sourceSymbol} tidak memuat meta`);
    }

    const price = Number(meta.regularMarketPrice);
    // chartPreviousClose adalah penutupan sebelum rentang yang diminta;
    // previousClose kadang tidak ada pada indeks tertentu.
    const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);

    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) {
      throw new Error(
        `Harga ${sourceSymbol} tidak terbaca (price=${meta.regularMarketPrice}, prev=${meta.chartPreviousClose})`,
      );
    }

    const quotedAtSec = Number(meta.regularMarketTime);

    return {
      price,
      previousClose,
      quotedAtSec: Number.isFinite(quotedAtSec) ? quotedAtSec : Math.floor(Date.now() / 1000),
      currency: String(meta.currency ?? 'USD'),
    };
  }
}
