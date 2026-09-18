import { Logger, Module, type Provider } from '@nestjs/common';

import { ChainModule } from '../chain/chain.module';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { GasModule } from '../gas/gas.module';
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
import {
  agentRunnerExports,
  agentRunnerImports,
  agentRunnerProviders,
} from './runner/agent-runner.providers';
import { AGENT_STORE, InMemoryAgentStore, type AgentStore } from './store/agent-store';
import {
  agentToolsControllers,
  agentToolsExports,
  agentToolsProviders,
} from './tools/agent-tools.providers';
import { agentVenuesExports, agentVenuesProviders } from './venues/agent-venues.providers';

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
 * AUTH: the same seam `wallet/` and `gas/` use — `Auth` reads back the
 * principal `SessionAuthGuard` verified for this request.
 */
const authProvider: Provider = {
  provide: Auth,
  useClass: RequestContextAuth,
};

/**
 * The agent lifecycle (SEN-5): hire, read, amend mandate, revoke. Each agent
 * trades with an enclave-held key from AGENT_WALLETS, bounded by its compiled
 * mandate (SEN-3), on venue accounts its own wallet owns (SEN-6), through the
 * gated tools and the `/mcp` server (SEN-7).
 */
@Module({
  // GasDripService: the MON gas drip to each hired agent's wallet (SEN-14).
  // CreditsService: the owner's OpenRouter key the runner bills (SEN-8).
  // ChainModule: ConsensusService, which `GET /agents/:id/events` decorates
  // its order and fill events with (SEN-21).
  imports: [GasModule, ChainModule, ...agentRunnerImports],
  // AgentsController, plus the MCP controller serving the gated tools (SEN-7).
  controllers: [AgentsController, ...agentToolsControllers],
  providers: [
    configProvider,
    agentWalletsProvider,
    agentStoreProvider,
    authProvider,
    SessionAuthGuard,
    AgentsService,
    ...agentVenuesProviders,
    ...agentToolsProviders,
    // The Tool Runner loop, POST /agents/:id/run and AGENT_TICK_SECONDS (SEN-8).
    ...agentRunnerProviders,
  ],
  exports: [
    AgentsService,
    AGENT_WALLETS,
    AGENT_STORE,
    ...agentVenuesExports,
    ...agentToolsExports,
    ...agentRunnerExports,
  ],
})
export class AgentsModule {}
