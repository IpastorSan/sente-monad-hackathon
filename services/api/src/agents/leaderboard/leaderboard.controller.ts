import { Controller, Get, UseGuards } from '@nestjs/common';

import { PlaceholderGasDripAuthGuard } from '../../gas/auth/gas-drip-auth.guard';
import type { LeaderboardResponseDto } from './leaderboard.dto';
import { LeaderboardService } from './leaderboard.service';

/**
 * `GET /leaderboard` (SEN-26). Read-only, and its own controller so the route
 * lives beside the code that computes it rather than in `agents.controller.ts`
 * — which is about one owner's agents, while a board is about everyone's.
 *
 * AUTH: the same placeholder seam every other route uses —
 * `PlaceholderGasDripAuthGuard` puts a principal on the request from
 * `x-sente-user-id`, and MOV-251's real session guard replaces it in the
 * module. The leaderboard is the first route that will drop the guard
 * entirely: a ranking of agents is public information about agents, not about
 * the caller, and NOTHING in this module reads the principal. It is kept for
 * now so the whole API has one auth story until MOV-251 lands.
 *
 * The ranking is global: every active agent, whichever owner hired it. A
 * per-user board would be a performance review, not a leaderboard.
 */
@Controller('leaderboard')
@UseGuards(PlaceholderGasDripAuthGuard)
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  get(): Promise<LeaderboardResponseDto> {
    return this.leaderboard.leaderboard();
  }
}
