import { Injectable, Logger } from '@nestjs/common';

/**
 * TODO(MOV-250): stub. Per-agent OpenRouter key provisioning and inference spend accounting.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  describe(): { module: string; implemented: boolean } {
    this.logger.debug('CreditsService is a scaffold stub');
    return { module: 'credits', implemented: false };
  }
}
