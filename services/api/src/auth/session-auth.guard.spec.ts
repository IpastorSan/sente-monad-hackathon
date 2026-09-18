import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { privateKeyToAccount } from 'viem/accounts';

import { AgentsController } from '../agents/agents.controller';
import { AgentsService } from '../agents/agents.service';
import { InMemoryAgentEventLog } from '../agents/events/agent-event-log';
import { InMemoryAgentStore } from '../agents/store/agent-store';
import { FakeAgentWalletProvider } from '../agents/testing/fake-agent-wallet.provider';
import { authConfig, resetAuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import { InMemoryChallengeStore } from './challenge';
import { PLACEHOLDER_USER_ID_HEADER } from './placeholder-header';
import { RequestContextAuth, readPrincipal } from './principal';
import { SessionAuthGuard } from './session-auth.guard';
import { mintSessionToken } from './session-token';

/** Anvil account #1. Published key, worthless on purpose (CLAUDE.md gotcha 11). */
const USER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const SECRET = 'ab'.repeat(32);

function request(headers: Record<string, unknown> = {}): { headers: Record<string, unknown> } {
  return { headers };
}

function contextFor(target: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => target }) } as unknown as ExecutionContext;
}

/** The memoised config is process-wide, so each case states the environment it needs. */
function withEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuthConfig();
}

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetAuthConfig();
});

describe('SessionAuthGuard', () => {
  it('attaches the principal a valid bearer token names', () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: undefined });
    const token = mintSessionToken(authConfig().sessionSecret, {
      sub: USER.address.toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const target = request({ authorization: `Bearer ${token}` });

    expect(new SessionAuthGuard().canActivate(contextFor(target))).toBe(true);
    expect(readPrincipal(target)).toEqual({ userId: USER.address.toLowerCase() });
    // And the request-scoped reader hands services exactly that.
    expect(new RequestContextAuth(target).principal()).toEqual({
      userId: USER.address.toLowerCase(),
    });
  });

  it('401s a request carrying only the placeholder header', () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: undefined });
    const target = request({ [PLACEHOLDER_USER_ID_HEADER]: USER.address });

    expect(() => new SessionAuthGuard().canActivate(contextFor(target))).toThrow(
      UnauthorizedException,
    );
    expect(readPrincipal(target)).toBeUndefined();
  });

  it('admits that same header when AUTH_PLACEHOLDER is on, so docs and scripts keep working', () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: '1', NODE_ENV: 'test' });
    const target = request({ [PLACEHOLDER_USER_ID_HEADER]: USER.address });

    expect(new SessionAuthGuard().canActivate(contextFor(target))).toBe(true);
    expect(readPrincipal(target)).toEqual({ userId: USER.address });
  });

  it('refuses a forged or expired token even in placeholder mode — never a silent downgrade', () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: '1', NODE_ENV: 'test' });
    const forged = mintSessionToken(Buffer.alloc(32, 1), {
      sub: USER.address.toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const expired = mintSessionToken(authConfig().sessionSecret, {
      sub: USER.address.toLowerCase(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    for (const token of [forged, expired, 'not-a-token']) {
      const target = request({
        authorization: `Bearer ${token}`,
        // Present, and deliberately ignored: a bad token is a 401.
        [PLACEHOLDER_USER_ID_HEADER]: USER.address,
      });
      expect(() => new SessionAuthGuard().canActivate(contextFor(target))).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('401s an anonymous request', () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: undefined });

    expect(() => new SessionAuthGuard().canActivate(contextFor(request()))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('challenge -> signature -> token -> GET /agents', () => {
  it('carries a signed-in user all the way to a guarded route', async () => {
    withEnv({ AUTH_SESSION_SECRET: SECRET, AUTH_PLACEHOLDER: undefined });
    const config = authConfig();
    const auth = new AuthService(config, new InMemoryChallengeStore());

    // 1. The phone asks for a challenge and signs the message it got back.
    const challenge = await auth.challenge(USER.address);
    const signature = await USER.signMessage({ message: challenge.message });

    // 2. The API verifies it and mints a session token.
    const session = await auth.session(USER.address, signature);

    // 3. The token authenticates a request to an ordinary guarded controller.
    const target = request({ authorization: `Bearer ${session.token}` });
    expect(new SessionAuthGuard().canActivate(contextFor(target))).toBe(true);

    const agents = new AgentsController(
      new AgentsService(new InMemoryAgentStore(), new FakeAgentWalletProvider()),
      new RequestContextAuth(target),
      {} as never,
      new InMemoryAgentEventLog(),
      // Only `GET /agents/:id/events` reads consensus, and this is `GET /agents`.
      {} as never,
    );
    await expect(agents.list()).resolves.toEqual({ agents: [] });

    // …and the same request with the token removed does not reach the route.
    expect(() => new SessionAuthGuard().canActivate(contextFor(request()))).toThrow(
      UnauthorizedException,
    );
  });
});
