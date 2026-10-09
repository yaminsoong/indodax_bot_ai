import { Module } from '@nestjs/common';
import { NewsService } from './news.service';
import { RssClient } from './rss.client';
import { SentimentService } from './sentiment.service';
import { CoinMatcherService } from './coin-matcher.service';
import { AiSentimentService } from './ai-sentiment.service';
import { AiModule } from '../ai/ai.module';

/**
 * LEVEL 5 roadmap — News Intelligence.
 *
 * Seperti Global Market, modul ini tidak bergantung pada modul lain: ia
 * mengambil berita dan menilainya, lalu hasilnya dipakai lapisan di atasnya.
 */
@Module({
  imports: [AiModule],
  providers: [RssClient, SentimentService, CoinMatcherService, AiSentimentService, NewsService],
  exports: [NewsService, SentimentService, CoinMatcherService, AiSentimentService],
})
export class NewsModule {}
