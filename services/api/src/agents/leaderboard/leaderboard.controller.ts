import { Controller, Get, UseGuards } from '@nestjs/common';

import { SessionAuthGuard } from '../../auth/session-auth.guard';
import type { LeaderboardResponseDto } from './leaderboard.dto';
import { LeaderboardService } from './leaderboard.service';

/**
 * `GET /leaderboard` (SEN-26). Read-only, and its own controller so the route
 * lives beside the code that computes it rather than in `agents.controller.ts`
 * — which is about one owner's agents, while a board is about everyone's.
 *
 * AUTH: `SessionAuthGuard`, the same guard every other route carries (SEN-37).
 * It was the last route left on the placeholder guard — SEN-37 could not edit
 * this directory — so until SEN-36 the API had two auth stories and the weaker
 * one was reachable here.
 *
 * The leaderboard is still the first route that will drop the guard entirely: a
 * ranking of agents is public information about agents, not about the caller,
 * and NOTHING in this module reads the principal. Dropping it is the intended
 * change, not an oversight, which is why `leaderboard.controller.spec.ts` pins
 * the guard: whoever makes the route public has to say so there.
 *
 * The ranking is global: every active agent, whichever owner hired it. A
 * per-user board would be a performance review, not a leaderboard.
 */
@Controller('leaderboard')
@UseGuards(SessionAuthGuard)
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  get(): Promise<LeaderboardResponseDto> {
    return this.leaderboard.leaderboard();
  }
}
