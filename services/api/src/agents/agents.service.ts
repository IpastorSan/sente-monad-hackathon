import { Injectable, Logger } from '@nestjs/common';

/**
 * TODO(MOV-250): stub. Agent lifecycle: hire, mandate issuance, enclave attestation, revoke.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  describe(): { module: string; implemented: boolean } {
    this.logger.debug('AgentsService is a scaffold stub');
    return { module: 'agents', implemented: false };
  }
}
