import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PresetsController } from './presets.controller';

/**
 * The preset catalog and its cohort stats (SEN-76, plan B-T16b).
 *
 * `AgentsModule` is imported for its exported `AGENT_STORE` and `AGENT_EVENTS`
 * singletons, as `LeaderboardModule` does: re-providing either here would read
 * an empty store. `SessionAuthGuard` is provided per module, like there.
 */
@Module({
  imports: [AgentsModule],
  controllers: [PresetsController],
  providers: [SessionAuthGuard],
})
export class PresetsModule {}
