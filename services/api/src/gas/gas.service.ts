import { Injectable, Logger } from '@nestjs/common';

/**
 * TODO(MOV-250): stub. Testnet MON drip for new accounts, rotating over GAS_DRIP_PRIVATE_KEYS.
 */
@Injectable()
export class GasService {
  private readonly logger = new Logger(GasService.name);

  describe(): { module: string; implemented: boolean } {
    this.logger.debug('GasService is a scaffold stub');
    return { module: 'gas', implemented: false };
  }
}
