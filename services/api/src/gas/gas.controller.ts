import { Controller, Get } from '@nestjs/common';

import { GasService } from './gas.service';

/**
 * TODO(MOV-250): stub controller. Routes land with the feature issue.
 */
@Controller('gas')
export class GasController {
  constructor(private readonly gasService: GasService) {}

  @Get()
  describe(): { module: string; implemented: boolean } {
    return this.gasService.describe();
  }
}
