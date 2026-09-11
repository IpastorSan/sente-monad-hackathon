import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { AgentRefusedError } from '../agents.errors';
import { AGENT_STORE, type AgentStore } from '../store/agent-store';
import { AgentRunnerService, type RunStopReason } from './agent-runner.service';
import { errorText } from './openrouter-client';
import { AGENT_RUNNER_CONFIG, type AgentRunnerConfig } from './runner.config';

export type TickOutcome =
  | { readonly agentId: string; readonly ran: true; readonly stopReason: RunStopReason }
  | { readonly agentId: string; readonly ran: false; readonly reason: string };

/**
 * `AGENT_TICK_SECONDS`: every active agent runs once per interval. Off by
 * default — it spends users' credits without anyone pressing a button.
 * Chainlink CRE replaces this timer in Phase 5.
 *
 * Agents run concurrently within a tick. An agent whose previous run is still
 * open is skipped (`run_in_progress`), so a slow run never stacks up behind
 * itself. In-process only, like the rest of the agent state.
 */
@Injectable()
export class AgentRunScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(AGENT_RUNNER_CONFIG) private readonly config: AgentRunnerConfig,
    @Inject(AGENT_STORE) private readonly store: Pick<AgentStore, 'listActive'>,
    private readonly runner: AgentRunnerService,
  ) {}

  get enabled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    const seconds = this.config.tickSeconds;
    if (seconds === undefined) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.logger.warn(`scheduler on: every active agent runs every ${seconds} s`);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every active agent. Never throws. */
  async tick(): Promise<TickOutcome[]> {
    let agents;
    try {
      agents = await this.store.listActive();
    } catch (error) {
      this.logger.error(`tick: could not list agents: ${errorText(error)}`);
      return [];
    }
    return Promise.all(
      agents.map(async (agent): Promise<TickOutcome> => {
        if (this.runner.isRunning(agent.id)) {
          return { agentId: agent.id, ran: false, reason: 'run_in_progress' };
        }
        try {
          const result = await this.runner.run({ userId: agent.userId }, agent.id, {
            trigger: 'schedule',
          });
          return { agentId: agent.id, ran: true, stopReason: result.stopReason };
        } catch (error) {
          const reason =
            error instanceof AgentRefusedError || hasReason(error) ? error.reason : 'error';
          if (reason !== 'run_in_progress') {
            this.logger.warn(`tick: agent ${agent.id} did not run: ${errorText(error)}`);
          }
          return { agentId: agent.id, ran: false, reason };
        }
      }),
    );
  }
}

function hasReason(error: unknown): error is { reason: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { reason?: unknown }).reason === 'string'
  );
}
