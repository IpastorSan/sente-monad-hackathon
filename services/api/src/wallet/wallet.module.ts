import { Logger, Module, type Provider } from '@nestjs/common';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';

import { GasDripAuth, RequestContextGasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import { BUNDLER, type Bundler } from './bundler/bundler';
import { PimlicoBundler } from './bundler/pimlico-bundler';
import {
  KERNEL_ACCOUNTS,
  PermissionlessKernelAccountFactory,
  type KernelAccountFactory,
} from './chain/kernel-account.factory';
import {
  OPERATION_TRACKER,
  PollingOperationTracker,
  type OperationTracker,
} from './confirmation/operation-tracker';
import { Erc7677Sponsorship, UnconfiguredSponsorship } from './paymaster/erc7677-sponsorship';
import { SPONSORSHIP, type Sponsorship } from './paymaster/sponsorship';
import {
  InMemoryPreparedOperationStore,
  PREPARED_OPERATION_STORE,
} from './store/prepared-operation-store';
import {
  InMemorySmartAccountRegistry,
  SMART_ACCOUNT_REGISTRY,
} from './store/smart-account-registry';
import {
  describeWalletConfig,
  loadWalletConfig,
  WALLET_CONFIG,
  type WalletConfig,
} from './wallet.config';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

const MONAD_PUBLIC_CLIENT = Symbol('WALLET_MONAD_PUBLIC_CLIENT');

type MonadPublicClient = ReturnType<typeof createMonadPublicClient>;

function createMonadPublicClient(config: WalletConfig) {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(config.rpcUrl, { retryCount: 2 }),
  });
}

const configProvider: Provider = {
  provide: WALLET_CONFIG,
  useFactory: (): WalletConfig => {
    // Throws at boot on a bad env rather than on the first UserOperation.
    const config = loadWalletConfig();
    describeWalletConfig(config, new Logger('WalletConfig'));
    return config;
  },
};

const publicClientProvider: Provider = {
  provide: MONAD_PUBLIC_CLIENT,
  inject: [WALLET_CONFIG],
  useFactory: (config: WalletConfig): MonadPublicClient => createMonadPublicClient(config),
};

const kernelAccountsProvider: Provider = {
  provide: KERNEL_ACCOUNTS,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: MonadPublicClient): KernelAccountFactory =>
    new PermissionlessKernelAccountFactory(client),
};

const bundlerProvider: Provider = {
  provide: BUNDLER,
  inject: [WALLET_CONFIG],
  useFactory: (config: WalletConfig): Bundler => new PimlicoBundler(config.bundlerUrl),
};

/**
 * PAYMASTER: bound to the ERC-7677 client when a policy is configured, and to
 * an implementation that refuses (and says so) when one is not. Swapping
 * Pimlico for Alchemy's Gas Manager is `WALLET_PAYMASTER_PROVIDER=alchemy` plus
 * `ALCHEMY_RPC_URL`/`ALCHEMY_GAS_POLICY_ID` — no code change, because both
 * speak ERC-7677. See `paymaster/sponsorship.ts`.
 */
const sponsorshipProvider: Provider = {
  provide: SPONSORSHIP,
  inject: [WALLET_CONFIG],
  useFactory: ({ paymaster }: WalletConfig): Sponsorship => {
    if (paymaster.provider === 'none' || !paymaster.url || !paymaster.policyId) {
      return new UnconfiguredSponsorship();
    }
    return new Erc7677Sponsorship(paymaster.provider, paymaster.url, paymaster.policyId);
  },
};

const trackerProvider: Provider = {
  provide: OPERATION_TRACKER,
  inject: [BUNDLER, WALLET_CONFIG],
  useFactory: (bundler: Bundler, config: WalletConfig): OperationTracker =>
    new PollingOperationTracker(bundler, {
      pollMs: config.confirmationPollMs,
      timeoutMs: config.confirmationTimeoutMs,
    }),
};

/**
 * PERSISTENCE: both stores are in memory because this repo has no database yet
 * — the same call `gas/ledger` made. Point these two tokens at a real store and
 * nothing else in `wallet/` changes.
 */
const registryProvider: Provider = {
  provide: SMART_ACCOUNT_REGISTRY,
  useClass: InMemorySmartAccountRegistry,
};

const preparedStoreProvider: Provider = {
  provide: PREPARED_OPERATION_STORE,
  useClass: InMemoryPreparedOperationStore,
};

/**
 * AUTH: reuses `gas/`'s seam rather than inventing a second one. MOV-251 swaps
 * `PlaceholderGasDripAuthGuard` for the real Mera session guard and rebinds
 * `GasDripAuth`; this module and `GasModule` change in the same way at the same
 * time.
 */
const authProvider: Provider = {
  provide: GasDripAuth,
  useClass: RequestContextGasDripAuth,
};

/**
 * Gas-sponsored ERC-7579 Kernel smart accounts owned by the user's Mera key.
 *
 * Privy is deliberately absent: it cannot sponsor gas for an external EOA (its
 * smart wallets are driven by Privy's own embedded signers, and its 7702
 * sponsorship is embedded-wallet-only), so the account is built with
 * `permissionless` where the sole owner is an ordinary viem `LocalAccount`.
 */
@Module({
  controllers: [WalletController],
  providers: [
    configProvider,
    publicClientProvider,
    kernelAccountsProvider,
    bundlerProvider,
    sponsorshipProvider,
    trackerProvider,
    registryProvider,
    preparedStoreProvider,
    authProvider,
    PlaceholderGasDripAuthGuard,
    WalletService,
  ],
  exports: [WalletService],
})
export class WalletModule {}
