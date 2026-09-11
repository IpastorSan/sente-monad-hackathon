import { Logger, type Provider } from '@nestjs/common';

import { CreditsModule } from '../../credits/credits.module';
import { AgentRunScheduler } from './agent-run.scheduler';
import { AgentRunnerService } from './agent-runner.service';
import { ANTHROPIC_CLIENT_FACTORY, defaultAnthropicClientFactory } from './openrouter-client';
import {
  AGENT_RUNNER_CONFIG,
  describeAgentRunnerConfig,
  loadAgentRunnerConfig,
  type AgentRunnerConfig,
} from './runner.config';
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
  { provide: ANTHROPIC_CLIENT_FACTORY, useValue: defaultAnthropicClientFactory },
  {
    // One per process: the spacing is per agent across every run.
    provide: WriteSpacer,
    inject: [AGENT_RUNNER_CONFIG],
    useFactory: (config: AgentRunnerConfig) =>
      new WriteSpacer({ spacingMs: config.writeSpacingMs }),
  },
  AgentRunnerService,
  AgentRunScheduler,
];

/** CreditsService: the owner's OpenRouter key (`keyFor`) and its usage. */
export const agentRunnerImports = [CreditsModule];

export const agentRunnerExports = [AgentRunnerService];
