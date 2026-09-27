import { Logger, Module, type Provider } from '@nestjs/common';

import type { WriteSpacer } from '../spacing/write-spacer';
import { BUNDLER, type Bundler } from '../wallet/bundler/bundler';
import { USER_WALLETS, type UserWalletProvider } from '../wallet/user-wallet.provider';
import { SEND_SPACER } from '../wallet/user-wallet.service';
import { WALLET_CONFIG, type WalletConfig } from '../wallet/wallet.config';
import { WalletModule } from '../wallet/wallet.module';
import { StepExecutor } from './step-executor';
import { loadTradeConfig, TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeStore } from './trade-store';

const configProvider: Provider = {
  provide: TRADE_CONFIG,
  useFactory: (): TradeConfig => {
    const config = loadTradeConfig();
    // Said once at boot so "why is /trade 404?" is answered by the log.
    new Logger('TradeConfig').log(
      `manual trading ${config.enabled ? 'on' : 'off'}` +
        (config.enabled ? `, atomic batch ${config.atomicBatch ? 'on' : 'off'}` : ''),
    );
    return config;
  },
};

/**
 * One executor for the process: its per-wallet mutex only keeps two trades
 * from interleaving if every trade goes through the same instance. Its sends go
 * through the wallet module's own SEND_SPACER, never a second one (SEN-83).
 */
const stepExecutorProvider: Provider = {
  provide: StepExecutor,
  inject: [TradeStore, USER_WALLETS, BUNDLER, SEND_SPACER, WALLET_CONFIG],
  useFactory: (
    store: TradeStore,
    wallets: UserWalletProvider,
    bundler: Bundler,
    spacer: WriteSpacer,
    config: WalletConfig,
  ): StepExecutor =>
    new StepExecutor({
      store,
      wallets,
      bundler,
      spacer,
      options: { pollMs: config.confirmationPollMs, timeoutMs: config.confirmationTimeoutMs },
    }),
};

/**
 * The user's own manual trades (SEN-83, plan M-T1): the feature flag, the
 * in-memory trade store and the step executor. No controller yet — the routes,
 * and the `trading_disabled` 404 they answer with the flag off, are M-T14.
 *
 * TradeStore is a plain class provided as a singleton for the same reason the
 * executor is: prepare and commit must see the same trades.
 */
@Module({
  imports: [WalletModule],
  providers: [
    configProvider,
    { provide: TradeStore, useFactory: () => new TradeStore() },
    stepExecutorProvider,
  ],
  exports: [TRADE_CONFIG, TradeStore, StepExecutor],
})
export class TradeModule {}
