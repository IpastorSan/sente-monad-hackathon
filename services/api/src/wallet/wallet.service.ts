import { Injectable, Logger } from '@nestjs/common';

/**
 * TODO(MOV-250): stub. Smart-account creation and ERC-4337 UserOperation submission via Pimlico.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  describe(): { module: string; implemented: boolean } {
    this.logger.debug('WalletService is a scaffold stub');
    return { module: 'wallet', implemented: false };
  }
}
