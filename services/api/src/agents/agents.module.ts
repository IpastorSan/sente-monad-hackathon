import { Logger, Module, type Provider } from '@nestjs/common';

import { GasDripAuth, RequestContextGasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import {
  AGENT_WALLETS,
  UnconfiguredAgentWalletProvider,
  type AgentWalletProvider,
} from './agent-wallet.provider';
import {
  AGENTS_CONFIG,
  describeAgentsConfig,
  loadAgentsConfig,
  type AgentsConfig,
} from './agents.config';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { PrivyAgentWalletProvider } from './privy/privy-agent-wallet.provider';
import { PrivyClient } from './privy/privy.client';
import { AGENT_STORE, InMemoryAgentStore, type AgentStore } from './store/agent-store';

const configProvider: Provider = {
  provide: AGENTS_CONFIG,
  useFactory: (): AgentsConfig => {
    // Throws at boot on a half-configured env, naming variables, never values.
    const config = loadAgentsConfig();
    describeAgentsConfig(config, new Logger('AgentsConfig'));
    return config;
  },
};

/**
 * AGENT_WALLETS: Privy when configured, and an implementation that refuses
 * (typed, `agent_wallets_unconfigured`) when not, so the API still boots
 * without Privy credentials — the same call `wallet/` makes for sponsorship.
 */
const agentWalletsProvider: Provider = {
  provide: AGENT_WALLETS,
  inject: [AGENTS_CONFIG],
  useFactory: ({ privy }: AgentsConfig): AgentWalletProvider => {
    if (!privy) {
      return new UnconfiguredAgentWalletProvider();
    }
    const logger = new Logger('AgentWallets');
    return new PrivyAgentWalletProvider({
      client: new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret }),
      agentKey: privy.agentAuthKey,
      mandateOwnerKey: privy.mandateOwnerKey,
      agentQuorumId: privy.agentQuorumId,
      mandateQuorumId: privy.mandateQuorumId,
      onQuorumsCreated: ({ agentQuorumId, mandateQuorumId }) =>
        logger.warn(
          `Created Privy owner quorums; pin them in .env or every restart registers new ones: ` +
            `PRIVY_AGENT_QUORUM_ID=${agentQuorumId} PRIVY_MANDATE_QUORUM_ID=${mandateQuorumId}`,
        ),
    });
  },
};

/**
 * PERSISTENCE: in memory until the repo has a database (see `store/agent-store.ts`).
 */
const agentStoreProvider: Provider = {
  provide: AGENT_STORE,
  useFactory: (): AgentStore => new InMemoryAgentStore(),
};

/**
 * AUTH: the same placeholder seam `wallet/` and `gas/` use. MOV-251's real
 * session guard rebinds `GasDripAuth` here too.
 */
const authProvider: Provider = {
  provide: GasDripAuth,
  useClass: RequestContextGasDripAuth,
};

/**
 * The agent lifecycle (SEN-5): hire, read, amend mandate, revoke. Each agent
 * trades with an enclave-held key from AGENT_WALLETS, bounded by its compiled
 * mandate (SEN-3).
 */
@Module({
  controllers: [AgentsController],
  providers: [
    configProvider,
    agentWalletsProvider,
    agentStoreProvider,
    authProvider,
    PlaceholderGasDripAuthGuard,
    AgentsService,
  ],
  exports: [AgentsService, AGENT_WALLETS, AGENT_STORE],
})
export class AgentsModule {}
