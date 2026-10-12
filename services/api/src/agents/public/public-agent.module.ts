import { Module } from '@nestjs/common';

import { IpRateLimiter } from '../../gas/rate-limit/ip-rate-limiter';
import { ProfileModule } from '../../profile/profile.module';
import { AgentsModule } from '../agents.module';
import {
  PUBLIC_AGENT_RATE_LIMITER,
  PUBLIC_AGENT_RATE_MAX,
  PUBLIC_AGENT_RATE_WINDOW_MS,
  PublicAgentController,
} from './public-agent.controller';
import { PublicAgentService } from './public-agent.service';

/**
 * `GET /public/agents/:id` (SEN-193). Imports `AgentsModule` and
 * `ProfileModule` for their EXPORTED singletons (the agent store, the event
 * log, the portfolio, the profiles), like the leaderboard does: re-providing
 * any of them here would read an empty copy.
 */
@Module({
  imports: [AgentsModule, ProfileModule],
  controllers: [PublicAgentController],
  providers: [
    PublicAgentService,
    {
      provide: PUBLIC_AGENT_RATE_LIMITER,
      useFactory: () => new IpRateLimiter(PUBLIC_AGENT_RATE_MAX, PUBLIC_AGENT_RATE_WINDOW_MS),
    },
  ],
})
export class PublicAgentModule {}
