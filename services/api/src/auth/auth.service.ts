import { Injectable, Logger } from '@nestjs/common';

/**
 * TODO(MOV-250): stub. Privy token verification, session issuance, mandate signer binding.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  describe(): { module: string; implemented: boolean } {
    this.logger.debug('AuthService is a scaffold stub');
    return { module: 'auth', implemented: false };
  }
}
