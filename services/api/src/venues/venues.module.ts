import { Module } from '@nestjs/common';

import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

/**
 * TODO(MOV-250): stub module. Routes Venue calls to the Kuru (spot) and Perpl (perps) adapters.
 */
@Module({
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
