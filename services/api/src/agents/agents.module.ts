import { Logger, Module, type Provider } from '@nestjs/common';

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
 * TODO(MOV-250): the lifecycle routes (hire, mandate issuance, revoke) are
 * still a stub. What is real: AGENT_WALLETS, the enclave-held key an agent
 * trades with, bounded by its compiled mandate (SEN-3).
 */
@Module({
  controllers: [AgentsController],
  providers: [configProvider, agentWalletsProvider, AgentsService, ...agentVenuesProviders],
  exports: [AgentsService, AGENT_WALLETS, ...agentVenuesExports],
})
export class AgentsModule {}
