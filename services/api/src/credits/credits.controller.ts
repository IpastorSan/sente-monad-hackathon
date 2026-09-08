import { Controller, Get } from '@nestjs/common';

import { CreditsService } from './credits.service';

/**
 * TODO(MOV-250): stub controller. Routes land with the feature issue.
 */
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get()
  describe(): { module: string; implemented: boolean } {
    return this.creditsService.describe();
  }
}
