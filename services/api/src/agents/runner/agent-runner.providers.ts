import { join } from 'node:path';

import { Logger, type Provider } from '@nestjs/common';

import { CreditsModule } from '../../credits/credits.module';
import { StateDirLease } from '../../state/state.module';
import { AgentRunScheduler } from './agent-run.scheduler';
import { AgentRunnerService } from './agent-runner.service';
import { ANTHROPIC_CLIENT_FACTORY, defaultAnthropicClientFactory } from './openrouter-client';
import {
  AGENT_RUNNER_CONFIG,
  AGENT_SCHEDULE_CONFIG,
  describeAgentRunnerConfig,
  describeAgentScheduleConfig,
  loadAgentRunnerConfig,
  loadAgentScheduleConfig,
  type AgentRunnerConfig,
  type AgentScheduleConfig,
} from './runner.config';
import { ScheduleGuard } from './schedule-guard';
import { AgentRunsController } from './transcript/agent-runs.controller';
import {
  FileRunTranscriptStore,
  RUN_TRANSCRIPTS_FILE,
} from './transcript/file-run-transcript-store';
import {
  InMemoryRunTranscriptStore,
  RUN_TRANSCRIPTS,
  type RunTranscriptStore,
} from './transcript/run-transcript-store';
import { WriteSpacer } from './write-spacing';

/**
 * Nest wiring for the agent runner (SEN-8), kept out of `agents.module.ts` so
 * that file only spreads these in.
 */
export const agentRunnerProviders: Provider[] = [
  {
    provide: AGENT_RUNNER_CONFIG,
    useFactory: (): AgentRunnerConfig => {
      const config = loadAgentRunnerConfig();
      describeAgentRunnerConfig(config, new Logger('AgentRunner'));
      return config;
    },
  },
  {
    // SEN-71: the scheduler's cadence, concurrency and credits-guard knobs.
    provide: AGENT_SCHEDULE_CONFIG,
    inject: [AGENT_RUNNER_CONFIG],
    useFactory: (runner: AgentRunnerConfig): AgentScheduleConfig => {
      const config = loadAgentScheduleConfig();
      describeAgentScheduleConfig(runner, config, new Logger('AgentRunScheduler'));
      return config;
    },
  },
  { provide: ANTHROPIC_CLIENT_FACTORY, useValue: defaultAnthropicClientFactory },
  {
    // One per process: the spacing is per agent across every run.
    provide: WriteSpacer,
    inject: [AGENT_RUNNER_CONFIG],
    useFactory: (config: AgentRunnerConfig) =>
      new WriteSpacer({ spacingMs: config.writeSpacingMs }),
  },
  {
    // SEN-178: the run transcripts behind the agent page's terminal. On disk
    // under STATE_DIR, opened only once this process holds its lock (SEN-161).
    provide: RUN_TRANSCRIPTS,
    inject: [StateDirLease],
    useFactory: (lease: StateDirLease): RunTranscriptStore => {
      if (!lease.dir) return new InMemoryRunTranscriptStore();
      const store = new FileRunTranscriptStore(join(lease.dir, RUN_TRANSCRIPTS_FILE));
      Logger.log(`${store.size} run transcript(s) loaded from ${store.path}`, 'RunTranscripts');
      return store;
    },
  },
  AgentRunnerService,
  ScheduleGuard,
  AgentRunScheduler,
];

/** CreditsService: the owner's OpenRouter key (`keyFor`) and its usage. */
export const agentRunnerImports = [CreditsModule];

/** RUN_TRANSCRIPTS: also read by `GET /credits` for the per-run cost breakdown (SEN-183). */
export const agentRunnerExports = [AgentRunnerService, RUN_TRANSCRIPTS];

/** `GET /agents/:id/runs` and `GET /agents/:id/runs/:runId` (SEN-178). */
export const agentRunnerControllers = [AgentRunsController];
