import { Logger, Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
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
import { CREDIT_PAYMENTS, NoCreditPayments } from './purchase/credit-payments';
import {
  CREDITS_PURCHASE_CONFIG,
  CreditsPurchaseService,
  loadCreditsPurchaseConfig,
  type CreditsPurchaseConfig,
} from './purchase/credits-purchase.service';
import { agentSecretsKey } from '../agents/venues/file-agent-secret-store';
import { statePath } from '../state/json-file';
import { StateDirLease, StateModule } from '../state/state.module';
import { CREDIT_KEYS, InMemoryCreditKeyStore, type CreditKeyStore } from './store/credit-key-store';
import { CREDIT_KEYS_FILE, FileCreditKeyStore } from './store/file-credit-key-store';

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

/** SEN-183: `CREDITS_PURCHASES_ENABLED`, off unless set. */
const purchaseConfigProvider: Provider = {
  provide: CREDITS_PURCHASE_CONFIG,
  useFactory: (): CreditsPurchaseConfig => {
    const config = loadCreditsPurchaseConfig();
    new Logger('CreditsConfig').log(
      config.purchasesEnabled
        ? 'credit purchases ON, but no payment rail is bound: each is refused payments_unavailable'
        : 'credit purchases off (CREDITS_PURCHASES_ENABLED)',
    );
    return config;
  },
};

/** SEN-183: no payment rail yet. `purchase/credit-payments.ts` describes the one it is shaped for. */
const paymentsProvider: Provider = {
  provide: CREDIT_PAYMENTS,
  useClass: NoCreditPayments,
};

/**
 * `credit-keys.json` under `STATE_DIR`, sealed under `AGENT_SECRETS_KEY`
 * (SEN-204); in memory otherwise. In memory, every restart let every user mint
 * a second funded key.
 */
export function creditKeyStore(
  env: Record<string, string | undefined> = process.env,
): CreditKeyStore {
  const path = statePath(CREDIT_KEYS_FILE, env);
  if (!path) return new InMemoryCreditKeyStore();
  const store = new FileCreditKeyStore(path, agentSecretsKey(env));
  new Logger('CreditKeyStore').log(`${store.size} OpenRouter key(s) loaded from ${store.path}`);
  return store;
}

const storeProvider: Provider = {
  provide: CREDIT_KEYS,
  // Injected only so the STATE_DIR lock is held before this file opens (SEN-161).
  inject: [StateDirLease],
  useFactory: (_lease: StateDirLease): CreditKeyStore => creditKeyStore(),
};

/** AUTH: the shared seam, exactly as `WalletModule` binds it. */
const authProvider: Provider = {
  provide: Auth,
  useClass: RequestContextAuth,
};

/**
 * Inference credits: one OpenRouter API key per user, with a hard one-off USD
 * limit that OpenRouter enforces. `CreditsService.keyFor` is how the agent
 * runner gets the key; nothing over HTTP ever does.
 */
@Module({
  imports: [StateModule],
  controllers: [CreditsController],
  providers: [
    configProvider,
    openRouterProvider,
    sharedKeyProvider,
    storeProvider,
    authProvider,
    SessionAuthGuard,
    CreditsService,
    purchaseConfigProvider,
    paymentsProvider,
    CreditsPurchaseService,
  ],
  exports: [CreditsService, CREDITS_CONFIG],
})
export class CreditsModule {}
