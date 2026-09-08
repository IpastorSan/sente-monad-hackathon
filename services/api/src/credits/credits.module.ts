import { Module } from '@nestjs/common';

import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

/**
 * TODO(MOV-250): stub module. Per-agent OpenRouter key provisioning and inference spend accounting.
 */
@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
