import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { AGENT_STORE, type AgentStore } from '../../agents/store/agent-store';
import {
  RUN_TRANSCRIPTS,
  type RunTranscriptStore,
} from '../../agents/runner/transcript/run-transcript-store';
import { Auth } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { CREDITS_CONFIG, type CreditsConfig } from '../credits.config';
import { guard } from '../credits.controller';
import { CreditsService } from '../credits.service';
import { creditsOverview, type CreditsOverview } from './overview';
import { aggregateUsage } from './usage';

/**
 * `GET /credits` (SEN-183): the caller's free tier — limit, used, remaining,
 * how it resets — and an estimated breakdown by agent and by run, read from
 * the run transcripts (SEN-178).
 *
 * Kept apart from `CreditsController` because it reads the agent store and the
 * transcripts, and `AgentsModule` already imports `CreditsModule`.
 *
 * Reading never mints: a user with no key yet gets the untouched free tier
 * (`provisioned: false`); the first run mints it.
 */
@Controller('credits')
@UseGuards(SessionAuthGuard)
export class CreditsOverviewController {
  constructor(
    private readonly credits: CreditsService,
    private readonly auth: Auth,
    @Inject(CREDITS_CONFIG) private readonly config: CreditsConfig,
    @Inject(AGENT_STORE) private readonly agents: AgentStore,
    @Inject(RUN_TRANSCRIPTS) private readonly transcripts: RunTranscriptStore,
  ) {}

  @Get()
  async overview(): Promise<CreditsOverview> {
    return guard(async () => {
      const principal = this.auth.principal();
      const now = new Date();
      const standing = await this.credits.standing(principal, now);
      const agents = await this.agents.listByUser(principal.userId);
      const usage = aggregateUsage({
        agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
        runsOf: (agentId) => this.transcripts.list(agentId),
        // A shared dev key's meter is everyone's spend: nothing to attribute against.
        usedUsd: standing.mode === 'shared' ? null : standing.view.usageMonthUsd,
        reset: standing.limitReset,
        now,
      });
      return creditsOverview(standing, usage, this.config.defaultLimitUsd);
    });
  }
}
