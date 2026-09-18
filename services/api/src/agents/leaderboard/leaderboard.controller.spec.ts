/**
 * `GET /leaderboard` as a route (SEN-26): the path, the guard that is still on
 * it, and the fact that the controller adds nothing to the service's answer.
 *
 * The route is meant to become public, so the guard is pinned here rather than
 * left to be discovered: whoever drops it should have to change this spec.
 */
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { resetAuthConfig } from '../../auth/auth.config';
import { PLACEHOLDER_USER_ID_HEADER } from '../../auth/placeholder-header';
import { readPrincipal } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import type { LeaderboardResponseDto } from './leaderboard.dto';

const EMPTY: LeaderboardResponseDto = {
  ranked: [],
  tooFewTrades: [],
  formula:
    'n = settled trades (wins + losses) · win rate = wins ÷ n · ROI = realised PnL ÷ capital deployed',
  notes: [],
  minTrades: 3,
  source: { kind: 'unconfigured', message: 'no indexer' },
  generatedAt: '2026-09-17T00:00:00.000Z',
};

function request(headers: Record<string, unknown>): Record<string, unknown> {
  return { headers };
}

function contextFor(target: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => target }) } as unknown as ExecutionContext;
}

describe('LeaderboardController', () => {
  it('is GET /leaderboard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LeaderboardController)).toBe('leaderboard');
    expect(Reflect.getMetadata(PATH_METADATA, LeaderboardController.prototype.get)).toBe('/');
  });

  it('carries the same session guard as every other route, and dropping it is a deliberate change', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LeaderboardController)).toEqual([SessionAuthGuard]);
  });

  it('refuses a caller with no principal, and admits one with the placeholder header', () => {
    // The guard reads its mode from a process-wide memo, so this case states
    // the environment it is FOR rather than trusting whatever the machine
    // running the suite has set — and restores it, because the memo outlives
    // this spec. `session-auth.guard.spec.ts` covers real bearer tokens.
    const previous = process.env.AUTH_PLACEHOLDER;
    process.env.AUTH_PLACEHOLDER = '1';
    resetAuthConfig();
    try {
      const guard = new SessionAuthGuard();

      expect(() => guard.canActivate(contextFor(request({})))).toThrow(UnauthorizedException);

      const known = request({
        [PLACEHOLDER_USER_ID_HEADER]: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      });
      expect(guard.canActivate(contextFor(known))).toBe(true);
      expect(readPrincipal(known)).toEqual({
        userId: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      });
    } finally {
      if (previous === undefined) delete process.env.AUTH_PLACEHOLDER;
      else process.env.AUTH_PLACEHOLDER = previous;
      resetAuthConfig();
    }
  });

  it('answers with the service, verbatim', async () => {
    const service = { leaderboard: () => Promise.resolve(EMPTY) } as unknown as LeaderboardService;

    await expect(new LeaderboardController(service).get()).resolves.toEqual(EMPTY);
  });
});
