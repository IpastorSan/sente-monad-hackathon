import { Logger, type Provider } from '@nestjs/common';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';

import { statePath } from '../../state/json-file';
import { AGENT_WALLETS, type AgentWalletProvider } from '../agent-wallet.provider';
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
import { PerplAgentAccounts, perplAccountReader } from './perpl-agent';

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
  { provide: AGENT_SECRETS, useFactory: () => agentSecretStore() },
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
      new PerplAgentAccounts({ sender, wallets, secrets, accountOf: perplAccountReader(client) }),
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
];
