/**
 * The runner as production wires it, minus the network: the real
 * AgentsService, AgentTools (gate included), event log, CreditsService over a
 * fake OpenRouter management API, and the real Anthropic SDK over a fake
 * `/v1/messages`.
 */
import { createOpenRouterKeys, CreditsService } from '../../../credits/credits.service';
import type { CreditsConfig } from '../../../credits/credits.config';
import { InMemoryCreditKeyStore } from '../../../credits/store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from '../../../credits/testing/fake-openrouter';
import { AgentsService } from '../../agents.service';
import { InMemoryAgentEventLog } from '../../events/agent-event-log';
import { InMemoryAgentStore, type AgentRecord } from '../../store/agent-store';
import { FakeAgentWalletProvider } from '../../testing/fake-agent-wallet.provider';
import { AgentTools } from '../../tools/context';
import { testAgent } from '../../tools/testing/agent-fixture';
import { fakeVenues } from '../../tools/testing/fake-venues';
import { AgentRunnerService, type RunOptions } from '../agent-runner.service';
import { createOpenRouterClient } from '../openrouter-client';
import { AGENT_RUNNER_DEFAULTS, type AgentRunnerConfig } from '../runner.config';
import { WriteSpacer } from '../write-spacing';
import { fakeMessagesApi, type Responder } from './fake-messages';

/** The first key `fakeOpenRouter` mints. */
export const FIRST_USER_KEY = 'sk-or-v1-PLAINTEXT-1';

export async function runnerHarness(
  options: {
    responses?: readonly Responder[];
    agent?: Partial<AgentRecord>;
    config?: Partial<AgentRunnerConfig>;
    creditsConfigured?: boolean;
    precheck?: boolean;
  } = {},
) {
  const store = new InMemoryAgentStore();
  const agent = testAgent(options.agent);
  await store.insert(agent);
  const events = new InMemoryAgentEventLog();
  const venueFakes = fakeVenues();
  const tools = new AgentTools({
    store,
    events,
    precheck: options.precheck ?? true,
    venuesFor: () => Promise.resolve(venueFakes.venues),
  });

  const openrouter = fakeOpenRouter();
  const creditsConfig: CreditsConfig = {
    managementKey: options.creditsConfigured === false ? undefined : FAKE_MANAGEMENT_KEY,
    defaultLimitUsd: 5,
  };
  const credits = new CreditsService(
    creditsConfig,
    createOpenRouterKeys(creditsConfig, openrouter.fetch),
    new InMemoryCreditKeyStore(),
  );

  const api = fakeMessagesApi(options.responses ?? []);
  const config: AgentRunnerConfig = {
    ...AGENT_RUNNER_DEFAULTS,
    tickSeconds: undefined,
    thinking: false,
    writeSpacingMs: 0,
    ...options.config,
  };
  const agents = new AgentsService(store, new FakeAgentWalletProvider());
  const runner = new AgentRunnerService(
    agents,
    store,
    tools,
    events,
    credits,
    config,
    (key, { timeoutMs }) => createOpenRouterClient(key, { timeoutMs, fetch: api.fetch }),
    new WriteSpacer({ spacingMs: config.writeSpacingMs }),
  );
  const principal = { userId: agent.userId };

  return {
    ...venueFakes,
    store,
    agent,
    agents,
    events,
    tools,
    openrouter,
    credits,
    api,
    config,
    runner,
    principal,
    run: (runOptions?: RunOptions) => runner.run(principal, agent.id, runOptions),
  };
}

/** Polls until `condition` holds (a few hundred macrotask turns at most). */
export async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error('waitFor: condition never held');
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
