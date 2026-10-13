import { Logger, type Provider } from '@nestjs/common';
import { onboardingParams } from '@sente/venues/perpl';
import { createPublicClient, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';

import { monadReadTransport } from '../../chain/monad-rpc';
import { SenteDbLease } from '../../state/state.module';
import { selectStore, type StoreSelector } from '../../state/store-backend';
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
import { agentSponsoredSends } from '../agents.config';
import {
  AgentTransactionSender,
  agentChainClient,
  agentUserOperationClient,
} from './agent-transactions';
import { AgentVenues } from './agent-venues';
import {
  AGENT_SECRETS_FILE,
  FileAgentSecretStore,
  agentSecretsKey,
} from './file-agent-secret-store';
import { PerplAgentAccounts, perplAccountReader, perplAllowanceReader } from './perpl-agent';
import { AGENT_PERPL_CONTEXT, AgentPerplOnboarder, perplOnboardingChain } from './perpl-onboarding';
import { SqliteAgentSecretStore } from './sqlite-agent-secret-store';

/** DI token for the Monad public client the agents' venues read and broadcast through. */
export const AGENT_PUBLIC_CLIENT = Symbol('AGENT_PUBLIC_CLIENT');

/**
 * In memory unless `STATE_DIR` is set; then encrypted on disk (SEN-148), in
 * `agent-secrets.json` or, under `STORE_BACKEND=sqlite`, a table in
 * `sente.db` (SEN-205), so a restart keeps every agent's enrolled Perpl key
 * instead of burning one of the account's 16 slots on the next use.
 * `agentSecretsKey()` throws without `AGENT_SECRETS_KEY`, and a wrong key
 * fails the load: both stop the boot.
 */
export function agentSecretStore(
  lease: StoreSelector,
  env: Record<string, string | undefined> = process.env,
): AgentSecretStore {
  return selectStore<AgentSecretStore>(lease, `${AGENT_SECRETS_FILE}.json`, 'agent Perpl key(s)', {
    memory: () => new InMemoryAgentSecretStore(),
    file: (path) => new FileAgentSecretStore(path, agentSecretsKey(env)),
    sqlite: (db) => new SqliteAgentSecretStore(db, agentSecretsKey(env)),
  });
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
        transport: monadReadTransport(process.env['MONAD_TESTNET_RPC_URL'], { retryCount: 2 }),
      }) as PublicClient,
  },
  {
    provide: AGENT_SECRETS,
    // Injected so the STATE_DIR lock and the database are held before this store opens (SEN-161).
    inject: [SenteDbLease],
    useFactory: (lease: SenteDbLease) => agentSecretStore(lease),
  },
  {
    provide: AgentTransactionSender,
    inject: [AGENT_WALLETS, AGENT_PUBLIC_CLIENT],
    useFactory: (wallets: AgentWalletProvider, client: PublicClient) => {
      // SEN-211: Privy's gas credits pay for the agents' transactions.
      const sponsored = agentSponsoredSends();
      new Logger('AgentsConfig').log(
        `agents: transactions ${sponsored ? 'Privy-sponsored (AGENT_SPONSORED_SENDS)' : 'signed and broadcast, agent pays gas'}`,
      );
      const logger = new Logger('AgentTransactions');
      return new AgentTransactionSender({
        wallets,
        chain: agentChainClient(client),
        ...(sponsored ? { sponsored: agentUserOperationClient(client) } : {}),
        // SEN-212: which path each transaction took, and how long it took.
        onSent: (sent) =>
          logger.log(
            `${sent.via} ${sent.success ? 'ok' : 'FAILED'} wallet ${sent.walletId} to ${sent.to}: ` +
              `tx ${sent.transactionHash}${sent.userOpHash ? ` userOp ${sent.userOpHash}` : ''}, ` +
              `submit ${sent.submitMs} ms, confirm ${sent.confirmMs} ms`,
          ),
      });
    },
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
