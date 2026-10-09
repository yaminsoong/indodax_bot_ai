import { Module } from '@nestjs/common';
import { AiAnalystService } from './ai-analyst.service';
import { AiModule } from '../ai/ai.module';
import { NewsModule } from '../news/news.module';
import { GlobalMarketModule } from '../global-market/global-market.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { TradingModule } from '../trading/trading.module';
import { BotConfigModule } from '../config/bot-config.module';

/**
 * AI Analyst (LEVEL 6 roadmap bagian AI).
 *
 * Modul ini hanya MEMBACA. Ia mengimpor TradingModule untuk melihat portofolio,
 * tetapi tidak memiliki jalur apa pun untuk memasang order — dan instruksi
 * sistemnya menyatakan itu secara eksplisit kepada model.
 */
@Module({
  imports: [
    AiModule,
    NewsModule,
    GlobalMarketModule,
    AnalysisModule,
    TradingModule,
    BotConfigModule,
  ],
  providers: [AiAnalystService],
  exports: [AiAnalystService],
})
export class AnalystModule {}
