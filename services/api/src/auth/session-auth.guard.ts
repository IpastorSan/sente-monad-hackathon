import {
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { authConfig } from './auth.config';
import { PLACEHOLDER_USER_ID_HEADER, readPlaceholderUserId } from './placeholder-header';
import { attachPrincipal, type Principal } from './principal';
import { verifySessionToken } from './session-token';

/**
 * ---------------------------------------------------------------------------
 * THE GUARD every user-facing route is bound to (SEN-37).
 *
 * `authorization: Bearer <token>` -> verify the HMAC and the expiry -> park a
 * `Principal` whose `userId` is the lowercase address in `sub`. Nothing else in
 * the request contributes to identity: not the body, not a header, not a query
 * parameter.
 *
 * PLACEHOLDER MODE. With `AUTH_PLACEHOLDER=1` (refused under
 * `NODE_ENV=production`, see `auth.config.ts`) a request with no bearer token
 * falls back to the old `x-sente-user-id` header, so every curl recipe in
 * `docs/` and every script still works. A request that DOES carry a bearer
 * token is verified as usual even in placeholder mode: a bad token is a 401,
 * never a silent downgrade to the header.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);
  private warned = false;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatableRequest>();

    const fromSession = principalFromBearer(request);
    if (fromSession) {
      attachPrincipal(request, fromSession);
      return true;
    }

    if (authConfig().mode === 'placeholder') {
      const userId = readPlaceholderUserId(request);
      if (userId !== undefined) {
        this.warnOnce();
        attachPrincipal(request, { userId });
        return true;
      }
      throw new UnauthorizedException({
        statusCode: 401,
        reason: 'unauthenticated',
        message: `No session token, and no ${PLACEHOLDER_USER_ID_HEADER} header (AUTH_PLACEHOLDER is on)`,
      });
    }

    throw new UnauthorizedException({
      statusCode: 401,
      reason: 'unauthenticated',
      message: 'Missing authorization: Bearer <token> — sign in at POST /auth/challenge',
    });
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      `PLACEHOLDER AUTH ACTIVE: trusting the ${PLACEHOLDER_USER_ID_HEADER} header because AUTH_PLACEHOLDER is set.`,
    );
  }
}

export interface AuthenticatableRequest {
  headers?: Record<string, unknown>;
}

/**
 * The principal a verified bearer token names, or undefined when the request
 * carries no bearer token at all.
 *
 * @throws UnauthorizedException when a token is present but forged, tampered
 * with or expired. A bad token is never treated as "no token": that is what
 * would let an expired session quietly fall back to a weaker mode.
 */
export function principalFromBearer(request: AuthenticatableRequest): Principal | undefined {
  const token = readBearerToken(request);
  if (token === undefined) return undefined;

  const config = authConfig();
  const verified = verifySessionToken(config.sessionSecret, token, Math.floor(Date.now() / 1000));
  if (!verified.ok) {
    throw new UnauthorizedException({
      statusCode: 401,
      reason: verified.failure === 'expired' ? 'session_expired' : 'invalid_session',
      message:
        verified.failure === 'expired'
          ? 'Session token has expired; sign in again'
          : 'Session token is not valid',
    });
  }
  return { userId: verified.claims.sub };
}

function readBearerToken(request: AuthenticatableRequest): string | undefined {
  const raw = request.headers?.authorization;
  if (typeof raw !== 'string') return undefined;

  const [scheme, ...rest] = raw.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const token = rest.join('');
  return token.length > 0 ? token : undefined;
}
