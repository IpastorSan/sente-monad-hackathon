import { Controller, Get } from '@nestjs/common';

import { VenuesService } from './venues.service';

/**
 * TODO(MOV-250): stub controller. Market data and order routes land with the
 * Kuru and Perpl adapter issues.
 */
@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Get()
  describe(): { module: string; implemented: boolean; venues: string[] } {
    return this.venuesService.describe();
  }
}
