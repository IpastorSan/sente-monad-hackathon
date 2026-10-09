import { Logger, type Provider } from '@nestjs/common';
import { onboardingParams } from '@sente/venues/perpl';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';

import { statePath } from '../../state/json-file';
import { StateDirLease } from '../../state/state.module';
import { cachedPerplContext, type PerplContextSource } from '../../trade/perpl-context';
import { AGENT_WALLETS, type AgentWalletProvider } from '../agent-wallet.provider';
import { AGENT_EVENTS, type AgentEventLog } from '../events/agent-event-log';
import { WriteSpacer } from '../runner/write-spacing';
import { AGENT_STORE, type AgentStore } from '../store/agent-store';
import { AgentTools } from '../tools/context';
import {
  AGENT_SECRETS,
  InMemoryAgentSecretStore,
  type AgentSecretStore,
} from './agent-secret-store';
import { AgentTransactionSender, agentChainClient } from './agent-transactions';
import { AgentVenues } from './agent-venues';
import {
  AGENT_SECRETS_FILE,
  FileAgentSecretStore,
  agentSecretsKey,
} from './file-agent-secret-store';
import { PerplAgentAccounts, perplAccountReader, perplAllowanceReader } from './perpl-agent';
import { AGENT_PERPL_CONTEXT, AgentPerplOnboarder, perplOnboardingChain } from './perpl-onboarding';

/** DI token for the Monad public client the agents' venues read and broadcast through. */
export const AGENT_PUBLIC_CLIENT = Symbol('AGENT_PUBLIC_CLIENT');

/**
 * In memory unless `STATE_DIR` is set; then encrypted on disk (SEN-148), so a
 * restart keeps every agent's enrolled Perpl key instead of burning one of
 * the account's 16 slots on the next use. `agentSecretsKey()` throws without
 * `AGENT_SECRETS_KEY`, and a wrong key fails the load: both stop the boot.
 */
export function agentSecretStore(
  env: Record<string, string | undefined> = process.env,
): AgentSecretStore {
  const path = statePath(AGENT_SECRETS_FILE, env);
  if (!path) return new InMemoryAgentSecretStore();
  const store = new FileAgentSecretStore(path, agentSecretsKey(env));
  Logger.log(`${store.size} agent Perpl key(s) loaded from ${store.path}`, 'AgentSecrets');
  return store;
}

/**
 * Nest wiring for the agents' venue accounts (SEN-6). Kept out of the venue
 * files themselves, which scripts load under node's type stripping.
 *
 * One AgentTransactionSender for the whole process: it is what keeps one
 * transaction in flight per agent wallet across Kuru and Perpl onboarding.
 */
export const agentVenuesProviders: Provider[] = [
  {
    provide: AGENT_PUBLIC_CLIENT,
    // Same override as the gas drip; viem's monadTestnet default otherwise.
    useFactory: (): PublicClient =>
      createPublicClient({
        chain: monadTestnet,
        transport: http(process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined, {
          retryCount: 2,
        }),
      }) as PublicClient,
  },
  {
    provide: AGENT_SECRETS,
    // Injected only so the STATE_DIR lock is held before this file opens (SEN-161).
    inject: [StateDirLease],
    useFactory: (_lease: StateDirLease) => agentSecretStore(),
  },
  {
    provide: AgentTransactionSender,
    inject: [AGENT_WALLETS, AGENT_PUBLIC_CLIENT],
    useFactory: (wallets: AgentWalletProvider, client: PublicClient) =>
      new AgentTransactionSender({ wallets, chain: agentChainClient(client) }),
  },
  {
    provide: PerplAgentAccounts,
    inject: [AgentTransactionSender, AGENT_WALLETS, AGENT_SECRETS, AGENT_PUBLIC_CLIENT],
    useFactory: (
      sender: AgentTransactionSender,
      wallets: AgentWalletProvider,
      secrets: AgentSecretStore,
      client: PublicClient,
    ) =>
      new PerplAgentAccounts({
        sender,
        wallets,
        secrets,
        accountOf: perplAccountReader(client),
        // SEN-187: a resumed opening does not approve twice.
        allowanceOf: perplAllowanceReader(client),
      }),
  },
  {
    // Perpl's live context, for the account-opening minimum (SEN-187).
    provide: AGENT_PERPL_CONTEXT,
    useFactory: (): PerplContextSource => cachedPerplContext(),
  },
  {
    // SEN-187: Sente opens each Perpl agent's account once it is funded.
    provide: AgentPerplOnboarder,
    inject: [
      PerplAgentAccounts,
      AGENT_SECRETS,
      AGENT_PUBLIC_CLIENT,
      AGENT_EVENTS,
      AGENT_STORE,
      AGENT_PERPL_CONTEXT,
      WriteSpacer,
      AgentTools,
    ],
    useFactory: (
      accounts: PerplAgentAccounts,
      secrets: AgentSecretStore,
      client: PublicClient,
      events: AgentEventLog,
      agents: AgentStore,
      context: PerplContextSource,
      spacer: WriteSpacer,
      tools: AgentTools,
    ) =>
      new AgentPerplOnboarder({
        accounts,
        secrets,
        chain: perplOnboardingChain(client),
        events,
        agents,
        minimum: async () => onboardingParams(await context()).minAccountOpenAmount,
        // The order the agent's own signing tools take them in: spacing
        // outside, the per-agent write lock inside (runner/write-spacing.ts).
        exclusive: (agentId, task) => spacer.run(agentId, () => tools.writeLock.run(agentId, task)),
        logger: new Logger('PerplOnboarding'),
      }),
  },
  {
    provide: AgentVenues,
    inject: [AGENT_PUBLIC_CLIENT, AgentTransactionSender, AGENT_SECRETS, PerplAgentAccounts],
    useFactory: (
      publicClient: PublicClient,
      sender: AgentTransactionSender,
      secrets: AgentSecretStore,
      perplAccounts: PerplAgentAccounts,
    ) =>
      new AgentVenues({
        publicClient,
        sender,
        secrets,
        // SEN-148: the first use that needs Perpl enrolls the agent's key.
        perplAccounts,
        logger: new Logger('AgentVenues'),
      }),
  },
];

/** What AgentsModule exports for SEN-7 (the agent runtime). */
export const agentVenuesExports = [
  AGENT_SECRETS,
  AgentVenues,
  PerplAgentAccounts,
  AgentTransactionSender,
  // SEN-187: the deposit webhook kicks it.
  AgentPerplOnboarder,
];
