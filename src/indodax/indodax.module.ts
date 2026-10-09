import { Module } from '@nestjs/common';
import { IndodaxService } from './indodax.service';
import { PairRegistryService } from './pair-registry.service';
import { IndodaxV2Client } from './indodax-v2.client';

@Module({
  providers: [IndodaxService, PairRegistryService, IndodaxV2Client],
  exports: [IndodaxService, PairRegistryService, IndodaxV2Client],
})
export class IndodaxModule {}
