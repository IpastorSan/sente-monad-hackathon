import { Logger, Module, type Provider } from '@nestjs/common';

import { ChainModule } from '../chain/chain.module';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { GasModule } from '../gas/gas.module';
import {
  USER_WALLET_REGISTRY,
  type UserWalletRegistry,
} from '../wallet/store/user-wallet-registry';
import { WalletModule } from '../wallet/wallet.module';
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
import {
  DeviceMandateOwners,
  MANDATE_OWNERS,
  ServerMandateOwners,
  type MandateOwners,
} from './mandate-owner';
import { PrivyAgentWalletProvider } from './privy/privy-agent-wallet.provider';
import { PrivyClient } from './privy/privy.client';
import {
  agentRunnerExports,
  agentRunnerImports,
  agentRunnerProviders,
} from './runner/agent-runner.providers';
import { AlchemyModule } from '../webhooks/alchemy.module';
import { AgentStoreModule } from './store/agent-store.module';
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
 * MANDATE_OWNERS: who owns each new agent's policy and wallet (SEN-43).
 *
 * `device` (the default) reads the hirer's device-key quorum out of the SAME
 * `USER_WALLET_REGISTRY` that `POST /wallet/register` writes — hence the
 * `WalletModule` import. `AGENT_MANDATE_OWNER=server` keeps the pre-Phase-3
 * shape for the scripted demo, and `agents.config.ts` refuses it in production.
 */
const mandateOwnersProvider: Provider = {
  provide: MANDATE_OWNERS,
  inject: [AGENTS_CONFIG, USER_WALLET_REGISTRY],
  useFactory: (config: AgentsConfig, registry: UserWalletRegistry): MandateOwners =>
    config.mandateOwner === 'server'
      ? new ServerMandateOwners()
      : new DeviceMandateOwners(registry),
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
  // WalletModule: for USER_WALLET_REGISTRY, the device-key quorum that owns a
  // hired agent's mandate (SEN-43). One-way — `wallet/` does not import this.
  // AlchemyModule: ALCHEMY_NOTIFY, the webhook address list a hire adds the new
  // agent's wallet to (SEN-30). Imported, not provided, so `WebhooksModule` can
  // import the same config without importing this module back.
  // AgentStoreModule: the agent records, shared with WalletModule rather than
  // provided here, so the SEN-42 send allowlist reads the SAME agents hiring
  // writes. See that module for why it sits below both.
  imports: [
    GasModule,
    ChainModule,
    WalletModule,
    AgentStoreModule,
    AlchemyModule,
    ...agentRunnerImports,
  ],
  // AgentsController, plus the MCP controller serving the gated tools (SEN-7).
  controllers: [AgentsController, ...agentToolsControllers],
  providers: [
    configProvider,
    agentWalletsProvider,
    mandateOwnersProvider,
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
    // Re-exported as the MODULE, so `leaderboard/` and `webhooks/` keep
    // resolving AGENT_STORE through this one import and get the same instance.
    AgentStoreModule,
    ...agentVenuesExports,
    ...agentToolsExports,
    ...agentRunnerExports,
  ],
})
export class AgentsModule {}
