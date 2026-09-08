import {
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { attachPrincipal } from './gas-drip-auth';

/** Header the placeholder guard trusts. Replaced by a real session in MOV-251. */
export const PLACEHOLDER_USER_ID_HEADER = 'x-sente-user-id';

/** Conservative shape so a userId cannot smuggle separators into log lines or keys. */
const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * PLACEHOLDER AUTH — see the seam docs in `gas-drip-auth.ts`.
 *
 * Trusts an `x-sente-user-id` header. That is obviously forgeable, which is
 * fine for local development against MOV-252 and not fine anywhere else, so the
 * guard hard-refuses under NODE_ENV=production rather than quietly authorising
 * whoever sets a header. MOV-251 deletes this file.
 */
@Injectable()
export class PlaceholderGasDripAuthGuard implements CanActivate {
  private readonly logger = new Logger(PlaceholderGasDripAuthGuard.name);
  private warned = false;

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(
        'Gas drip auth is not configured for production (MOV-251 replaces the placeholder guard)',
      );
    }
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        `PLACEHOLDER AUTH ACTIVE: trusting the ${PLACEHOLDER_USER_ID_HEADER} header. MOV-251 replaces this.`,
      );
    }

    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const raw = request.headers?.[PLACEHOLDER_USER_ID_HEADER];
    const userId = typeof raw === 'string' ? raw.trim() : '';

    if (!USER_ID_PATTERN.test(userId)) {
      throw new UnauthorizedException(`Missing or malformed ${PLACEHOLDER_USER_ID_HEADER} header`);
    }

    attachPrincipal(request, { userId });
    return true;
  }
}
