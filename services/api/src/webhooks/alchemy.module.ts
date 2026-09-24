import { Logger, Module, type Provider } from '@nestjs/common';

import {
  ALCHEMY_CONFIG,
  describeAlchemyConfig,
  loadAlchemyConfig,
  type AlchemyConfig,
} from './alchemy.config';
import { ALCHEMY_NOTIFY, AlchemyNotifyClient, type AlchemyNotifyAddresses } from './alchemy-notify';

const configProvider: Provider = {
  provide: ALCHEMY_CONFIG,
  useFactory: (): AlchemyConfig => {
    // Cannot throw (see `loadAlchemyConfig`); the summary says what is enabled.
    const config = loadAlchemyConfig();
    describeAlchemyConfig(config, new Logger('AlchemyConfig'));
    return config;
  },
};

/**
 * ALCHEMY_NOTIFY (SEN-30): the webhook address list a hire adds its new wallet
 * to. Unconfigured is a valid state — the client then refuses every
 * call with `notify_unconfigured`, which `AgentsService.watchForDeposits` logs
 * and ignores.
 */
const notifyProvider: Provider = {
  provide: ALCHEMY_NOTIFY,
  inject: [ALCHEMY_CONFIG],
  useFactory: (config: AlchemyConfig): AlchemyNotifyAddresses => new AlchemyNotifyClient(config),
};

/**
 * The Alchemy configuration, on its own, because TWO modules need it and the
 * dependency between them has to stay one-way.
 *
 * `WebhooksModule` needs the signing key to verify a delivery, and it imports
 * `AgentsModule` for `AGENT_STORE` and `AGENT_EVENTS`. `AgentsModule` needs
 * `ALCHEMY_NOTIFY` to register a wallet at hire. Had either provided the config,
 * the other would have to import it and the two would be a cycle; a third module
 * that imports nothing of ours breaks that, and `describeAlchemyConfig` then logs
 * its boot summary once rather than once per importer.
 *
 * Nothing in here touches an agent or a request, so it is safe to import from
 * anywhere.
 */
@Module({
  providers: [configProvider, notifyProvider],
  exports: [ALCHEMY_CONFIG, ALCHEMY_NOTIFY],
})
export class AlchemyModule {}
