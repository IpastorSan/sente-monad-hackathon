import { Controller, Get } from '@nestjs/common';

import { AgentsService } from './agents.service';

/**
 * TODO(MOV-250): stub controller. Routes land with the feature issue.
 */
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  describe(): { module: string; implemented: boolean } {
    return this.agentsService.describe();
  }
}
