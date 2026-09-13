import { Logger, Module, type Provider } from '@nestjs/common';

import { GasDripAuth, RequestContextGasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import {
  CREDITS_CONFIG,
  describeCreditsConfig,
  loadCreditsConfig,
  type CreditsConfig,
} from './credits.config';
import { CreditsController } from './credits.controller';
import {
  createOpenRouterKeys,
  createSharedKey,
  CreditsService,
  OPENROUTER_KEYS,
  OPENROUTER_SHARED,
} from './credits.service';
import type { OpenRouterKeyApi, SharedKeyApi } from './openrouter.client';
import { CREDIT_KEYS, InMemoryCreditKeyStore } from './store/credit-key-store';

const configProvider: Provider = {
  provide: CREDITS_CONFIG,
  useFactory: (): CreditsConfig => {
    // Throws at boot on a bad env rather than on the first provision.
    const config = loadCreditsConfig();
    describeCreditsConfig(config, new Logger('CreditsConfig'));
    return config;
  },
};

const openRouterProvider: Provider = {
  provide: OPENROUTER_KEYS,
  inject: [CREDITS_CONFIG],
  useFactory: (config: CreditsConfig): OpenRouterKeyApi => createOpenRouterKeys(config),
};

/** Shared-key dev mode (SEN-18): the one inference key's `GET /key`; null in other modes. */
const sharedKeyProvider: Provider = {
  provide: OPENROUTER_SHARED,
  inject: [CREDITS_CONFIG],
  useFactory: (config: CreditsConfig): SharedKeyApi | null => createSharedKey(config),
};

/** PERSISTENCE: in memory until the repo has a database — see `store/credit-key-store.ts`. */
const storeProvider: Provider = {
  provide: CREDIT_KEYS,
  useClass: InMemoryCreditKeyStore,
};

/** AUTH: reuses `gas/`'s seam, exactly as `WalletModule` does. MOV-251 rebinds both. */
const authProvider: Provider = {
  provide: GasDripAuth,
  useClass: RequestContextGasDripAuth,
};

/**
 * Inference credits: one OpenRouter API key per user, with a hard monthly USD
 * limit that OpenRouter enforces. `CreditsService.keyFor` is how the agent
 * runner gets the key; nothing over HTTP ever does.
 */
@Module({
  controllers: [CreditsController],
  providers: [
    configProvider,
    openRouterProvider,
    sharedKeyProvider,
    storeProvider,
    authProvider,
    PlaceholderGasDripAuthGuard,
    CreditsService,
  ],
  exports: [CreditsService],
})
export class CreditsModule {}
