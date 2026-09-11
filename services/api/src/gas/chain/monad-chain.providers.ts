import { Logger, type Provider } from '@nestjs/common';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
// viem ships Monad upstream — never hand-roll defineChain for it. Matches
// apps/mobile/src/chain/client.ts.
import { monadTestnet } from 'viem/chains';

import { GAS_DRIP_CONFIG, type GasDripConfig } from '../gas.config';
import { SENDER_POOL, type NonceSource, type TransactionBroadcaster } from '../sender/drip-sender';
import { NonceManagedSender } from '../sender/nonce-managed-sender';
import {
  AGENT_DRIP_DISPATCHER,
  ReserveAwareDispatcher,
  type ReceiptWaiter,
  type TransferSimulator,
} from '../sender/reserve-aware-dispatcher';
import { SenderPool } from '../sender/sender-pool';

/** DI token for the "does this address already have MON?" guard's data source. */
export const BALANCE_READER = Symbol('BALANCE_READER');

/** Narrow slice of a viem public client, so tests fake two lines instead of a client. */
export interface BalanceReader {
  getBalance(args: { address: Address }): Promise<bigint>;
}

/** DI token for the "does this address have code?" read that sizes the gas limit. */
export const CODE_READER = Symbol('CODE_READER');

/**
 * Narrow slice of a viem public client (`eth_getCode`). viem returns
 * `undefined` for an address with no code; some nodes return `0x`.
 */
export interface CodeReader {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
}

const MONAD_PUBLIC_CLIENT = Symbol('MONAD_PUBLIC_CLIENT');

type MonadPublicClient = ReturnType<typeof createMonadPublicClient>;

function createMonadPublicClient(config: GasDripConfig) {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(config.rpcUrl, { retryCount: 2 }),
  });
}

const publicClientProvider: Provider = {
  provide: MONAD_PUBLIC_CLIENT,
  inject: [GAS_DRIP_CONFIG],
  useFactory: (config: GasDripConfig): MonadPublicClient => createMonadPublicClient(config),
};

const balanceReaderProvider: Provider = {
  provide: BALANCE_READER,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: MonadPublicClient): BalanceReader => ({
    getBalance: (args) => client.getBalance(args),
  }),
};

const codeReaderProvider: Provider = {
  provide: CODE_READER,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: MonadPublicClient): CodeReader => ({
    getCode: (args) => client.getCode(args),
  }),
};

/**
 * Dry-run broadcaster: runs every guard for real, never touches the network,
 * and hands back a well-formed but meaningless hash. Local demos and CI only —
 * `loadGasDripConfig` refuses to enable it under NODE_ENV=production.
 */
function dryRunPlumbing(address: Address): {
  nonces: NonceSource;
  broadcaster: TransactionBroadcaster;
} {
  const logger = new Logger('GasDripDryRun');
  return {
    nonces: { getTransactionCount: () => Promise.resolve(0) },
    broadcaster: {
      sendTransaction: (args) => {
        logger.warn(
          `DRY RUN: not broadcasting ${args.value} wei from ${address} to ${args.to} ` +
            `nonce=${args.nonce} gas=${args.gas}`,
        );
        const body = `${address}${args.to}${args.nonce}`.replace(/0x/g, '').padEnd(64, '0');
        return Promise.resolve(`0x${body.slice(0, 64)}` as Hash);
      },
    },
  };
}

function buildSenderPool(config: GasDripConfig, client: MonadPublicClient): SenderPool {
  const logger = new Logger('GasDripSenderPool');

  if (config.senderKeys.length === 0) {
    logger.warn(
      'GAS_DRIP_PRIVATE_KEYS is empty; POST /gas/drip will refuse with faucet_unconfigured',
    );
    return new SenderPool([]);
  }
  if (config.senderKeys.length < 3 && !config.dryRun) {
    logger.warn(
      `Only ${config.senderKeys.length} faucet key(s) configured; 3-5 are recommended so ` +
        'concurrent signups do not serialise behind one nonce sequence',
    );
  }

  const senders = config.senderKeys.map((key) => {
    const account = privateKeyToAccount(key);

    if (config.dryRun) {
      const { nonces, broadcaster } = dryRunPlumbing(account.address);
      return new NonceManagedSender(account.address, nonces, broadcaster);
    }

    const wallet = createWalletClient({
      account,
      chain: monadTestnet,
      transport: http(config.rpcUrl, { retryCount: 2 }),
    });

    const nonces: NonceSource = {
      getTransactionCount: (args) => client.getTransactionCount(args),
    };
    const broadcaster: TransactionBroadcaster = {
      // Explicit `gas` — never estimated. See CLAUDE.md gotcha 4.
      sendTransaction: (args) =>
        wallet.sendTransaction({
          to: args.to,
          value: args.value,
          gas: args.gas,
          nonce: args.nonce,
        }),
    };
    return new NonceManagedSender(account.address, nonces, broadcaster);
  });

  logger.log(`faucet senders: ${senders.map((sender) => sender.address).join(', ')}`);
  return new SenderPool(senders);
}

const senderPoolProvider: Provider = {
  provide: SENDER_POOL,
  inject: [GAS_DRIP_CONFIG, MONAD_PUBLIC_CLIENT],
  useFactory: (config: GasDripConfig, client: MonadPublicClient): SenderPool =>
    buildSenderPool(config, client),
};

/**
 * The agent drip's sends: spaced per key, simulated, confirmed by receipt —
 * see `sender/reserve-aware-dispatcher.ts`. In dry run nothing is broadcast,
 * so there is nothing to simulate or wait for; spacing still runs for real.
 */
const agentDripDispatcherProvider: Provider = {
  provide: AGENT_DRIP_DISPATCHER,
  inject: [GAS_DRIP_CONFIG, MONAD_PUBLIC_CLIENT, SENDER_POOL],
  useFactory: (
    config: GasDripConfig,
    client: MonadPublicClient,
    pool: SenderPool,
  ): ReserveAwareDispatcher => {
    const simulator: TransferSimulator = config.dryRun
      ? { simulateTransfer: () => Promise.resolve() }
      : {
          simulateTransfer: async ({ from, to, value, gas }) => {
            await client.call({ account: from, to, value, gas });
          },
        };
    const receipts: ReceiptWaiter = config.dryRun
      ? { waitForReceipt: () => Promise.resolve('success') }
      : {
          waitForReceipt: async ({ hash, timeoutMs }) =>
            (await client.waitForTransactionReceipt({ hash, timeout: timeoutMs })).status,
        };
    return new ReserveAwareDispatcher(pool, simulator, receipts, {
      spacingMs: config.agent.senderSpacingMs,
      receiptTimeoutMs: config.agent.receiptTimeoutMs,
      logger: new Logger('AgentDripDispatcher'),
    });
  },
};

export const monadChainProviders: Provider[] = [
  publicClientProvider,
  balanceReaderProvider,
  codeReaderProvider,
  senderPoolProvider,
  agentDripDispatcherProvider,
];
