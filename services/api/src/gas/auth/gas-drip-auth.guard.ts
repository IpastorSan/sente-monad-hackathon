import {
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { PLACEHOLDER_USER_ID_HEADER, readPlaceholderUserId } from '../../auth/placeholder-header';
import { attachPrincipal } from '../../auth/principal';
import { principalFromBearer } from '../../auth/session-auth.guard';

export { PLACEHOLDER_USER_ID_HEADER };

/**
 * PLACEHOLDER AUTH — replaced by `SessionAuthGuard` (SEN-37) everywhere except
 * `GET /leaderboard`, whose module SEN-37 was not allowed to edit.
 *
 * It now accepts a real session token first, so the app and the judge-facing
 * deployment reach the leaderboard with the same bearer token as every other
 * route. Only when there is no token at all does it fall back to trusting the
 * `x-sente-user-id` header, and only outside production — this guard keeps its
 * original environment contract (rather than SEN-37's `AUTH_PLACEHOLDER` gate)
 * because `leaderboard.controller.spec.ts` pins that contract and lives in the
 * same untouchable directory.
 *
 * @deprecated Bind `SessionAuthGuard` instead; deleting this file is the last
 * step of that move.
 */
@Injectable()
export class PlaceholderGasDripAuthGuard implements CanActivate {
  private readonly logger = new Logger(PlaceholderGasDripAuthGuard.name);
  private warned = false;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();

    const fromSession = principalFromBearer(request);
    if (fromSession) {
      attachPrincipal(request, fromSession);
      return true;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException(
        'This route accepts only a session token in production (POST /auth/challenge)',
      );
    }
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        `PLACEHOLDER AUTH ACTIVE: trusting the ${PLACEHOLDER_USER_ID_HEADER} header. SessionAuthGuard replaces this.`,
      );
    }

    const userId = readPlaceholderUserId(request);
    if (userId === undefined) {
      throw new UnauthorizedException(`Missing or malformed ${PLACEHOLDER_USER_ID_HEADER} header`);
    }

    attachPrincipal(request, { userId });
    return true;
  }
}
