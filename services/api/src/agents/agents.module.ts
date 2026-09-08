import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * TODO(MOV-250): stub module. Agent lifecycle: hire, mandate issuance, enclave attestation, revoke.
 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
