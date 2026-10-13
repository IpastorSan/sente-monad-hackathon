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
import { SenteDbLease, StateModule } from '../state/state.module';
import { selectStore, type StoreSelector } from '../state/store-backend';
import { CREDIT_KEYS, InMemoryCreditKeyStore, type CreditKeyStore } from './store/credit-key-store';
import { CREDIT_KEYS_FILE, FileCreditKeyStore } from './store/file-credit-key-store';
import { SqliteCreditKeyStore } from './store/sqlite-credit-key-store';

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
 * (SEN-204), or a sealed table in `sente.db` under `STORE_BACKEND=sqlite`
 * (SEN-205); in memory otherwise. In memory, every restart let every user mint
 * a second funded key.
 */
export function creditKeyStore(
  lease: StoreSelector,
  env: Record<string, string | undefined> = process.env,
): CreditKeyStore {
  return selectStore<CreditKeyStore>(lease, `${CREDIT_KEYS_FILE}.json`, 'OpenRouter key(s)', {
    memory: () => new InMemoryCreditKeyStore(),
    file: (path) => new FileCreditKeyStore(path, agentSecretsKey(env)),
    sqlite: (db) => new SqliteCreditKeyStore(db, agentSecretsKey(env)),
  });
}

const storeProvider: Provider = {
  provide: CREDIT_KEYS,
  // Injected so the STATE_DIR lock and the database are held before this store opens (SEN-161).
  inject: [SenteDbLease],
  useFactory: (lease: SenteDbLease): CreditKeyStore => creditKeyStore(lease),
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
