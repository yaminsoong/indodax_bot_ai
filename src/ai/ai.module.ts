import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { AnthropicProvider } from './providers/anthropic.provider';

/**
 * Lapisan AI, netral terhadap penyedia.
 *
 * Seluruh penyedia selalu didaftarkan; yang menentukan mana yang dipakai adalah
 * `AI_PROVIDER` di `.env`. Mendaftarkan semuanya membuat pergantian penyedia
 * tidak memerlukan perubahan kode sama sekali.
 */
@Module({
  providers: [GeminiProvider, GroqProvider, AnthropicProvider, AiService],
  exports: [AiService],
})
export class AiModule {}
