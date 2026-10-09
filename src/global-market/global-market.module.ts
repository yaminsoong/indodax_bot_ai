import { Module } from '@nestjs/common';
import { GlobalMarketService } from './global-market.service';
import { YahooFinanceClient } from './yahoo-finance.client';

/**
 * LEVEL 6 roadmap — konteks pasar global.
 *
 * Sengaja tidak bergantung pada modul lain: lapisan ini hanya mengambil harga
 * dan menilainya. Dengan begitu ia bisa dipakai Market Intelligence, Telegram,
 * dan dashboard tanpa membentuk ketergantungan melingkar.
 */
@Module({
  providers: [YahooFinanceClient, GlobalMarketService],
  exports: [GlobalMarketService],
})
export class GlobalMarketModule {}
