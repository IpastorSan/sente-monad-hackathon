/**
 * The agent's own Perpl account: onboarding and API-key enrollment done BY
 * the agent's EOA, signed in Privy's enclave under its mandate policy.
 *
 * Perpl enrolls keys by `ecrecover` only (CLAUDE.md gotcha 9), and a Privy
 * wallet is a plain secp256k1 EOA, so the agent's wallet can own a Perpl
 * account the same way the user's passkey EOA does. The enclave sees only
 * onboarding (three transactions) and enrollment (one EIP-712 signature);
 * orders are signed with the enrolled Ed25519 key and never touch Privy.
 *
 * Erasable syntax and `.ts` specifiers only (scripts load this file).
 */
import {
  enrollApiKey,
  onboardingParams,
  PERPL_EXCHANGE_ABI,
  PERPL_NETWORKS,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
  type PerplContext,
  type PerplCredentials,
  type PerplNetwork,
} from '@sente/venues/perpl';
import {
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider.ts';
import type { AgentSecretStore } from './agent-secret-store.ts';
import type { AgentIdentity, AgentTransactionSender } from './agent-transactions.ts';

/**
 * Fixed gas limits for the three onboarding transactions. `approve` gets the
 * shared 80,000 (measured 71,099); the other two are the measurements in
 * docs/monad-testnet-assets.md (202,237 and 71,363), rounded up to the next
 * thousand. Monad charges the limit (CLAUDE.md gotcha 4).
 */
export const PERPL_ONBOARDING_GAS = {
  approve: 80_000n,
  createAccount: 203_000n,
  allowOrderForwarding: 72_000n,
} as const;

/** Resolves a Perpl account id for an address; `null` when it has none. */
export type PerplAccountReader = (address: Address) => Promise<bigint | null>;

/** {@link PerplAccountReader} over `Exchange.getAccountByAddr`, which reverts for no account. */
export function perplAccountReader(
  client: PublicClient,
  exchange: Address = PERPL_TESTNET_CONTRACTS.exchange,
): PerplAccountReader {
  return async (address) => {
    try {
      const account = await client.readContract({
        address: exchange,
        abi: PERPL_EXCHANGE_ABI,
        functionName: 'getAccountByAddr',
        args: [address],
      });
      return account.accountId === 0n ? null : account.accountId;
    } catch {
      return null;
    }
  };
}

export class PerplOnboardingError extends Error {
  readonly transactionHash: Hex;

  constructor(step: string, transactionHash: Hex) {
    super(`Perpl onboarding: ${step} reverted in ${transactionHash}`);
    this.name = 'PerplOnboardingError';
    this.transactionHash = transactionHash;
  }
}

export class PerplNotOnboardedError extends Error {
  readonly address: Address;

  constructor(address: Address) {
    super(`${address} has no Perpl account yet; onboard it before enrolling an API key`);
    this.name = 'PerplNotOnboardedError';
    this.address = address;
  }
}

export interface PerplOnboarding {
  readonly accountId: bigint;
  /** False when the account already existed and nothing was sent. */
  readonly onboarded: boolean;
  readonly transactions: readonly Hex[];
}

export interface PerplAgentAccountsOptions {
  readonly sender: AgentTransactionSender;
  readonly wallets: AgentWalletProvider;
  readonly secrets: AgentSecretStore;
  readonly accountOf: PerplAccountReader;
  /** Defaults to testnet. */
  readonly network?: PerplNetwork;
  readonly fetchImpl?: typeof fetch;
}

const STEPS = ['approve', 'createAccount', 'allowOrderForwarding'] as const;

export class PerplAgentAccounts {
  readonly #sender: AgentTransactionSender;
  readonly #wallets: AgentWalletProvider;
  readonly #secrets: AgentSecretStore;
  readonly #accountOf: PerplAccountReader;
  readonly #network: PerplNetwork;
  readonly #fetch: typeof fetch;
  /** One enrollment per agent at a time: concurrent callers share it. */
  readonly #enrolling = new Map<string, Promise<PerplCredentials>>();

  constructor(options: PerplAgentAccountsOptions) {
    this.#sender = options.sender;
    this.#wallets = options.wallets;
    this.#secrets = options.secrets;
    this.#accountOf = options.accountOf;
    this.#network = options.network ?? PERPL_NETWORKS.testnet;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  accountId(agent: AgentIdentity): Promise<bigint | null> {
    return this.#accountOf(agent.address);
  }

  /**
   * Opens the agent's Perpl account: approve → createAccount(amount) →
   * allowOrderForwarding(true), three Privy-signed transactions through the
   * wallet's queue. `amount` defaults to the venue minimum (100 AUSD on
   * testnet) and must fit the mandate's `perpl.maxCollateralAtoms`, or the
   * enclave refuses the approve and nothing is sent.
   *
   * A no-op when the account exists. Caveat: if a previous run died between
   * `createAccount` and `allowOrderForwarding`, the account exists with
   * forwarding OFF and every order fails with `sr: 34`; that is visible on the
   * trading socket (`accountState().fw`), not from this read.
   */
  async onboard(agent: AgentIdentity, amount?: bigint): Promise<PerplOnboarding> {
    const existing = await this.accountId(agent);
    if (existing !== null) return { accountId: existing, onboarded: false, transactions: [] };

    const params = onboardingParams(await this.#context());
    // The mandate policy was compiled against PERPL_TESTNET_CONTRACTS; if the
    // live context moved, the enclave would refuse anyway — say why instead.
    if (
      !isAddressEqual(params.exchange, PERPL_TESTNET_CONTRACTS.exchange) ||
      !isAddressEqual(params.collateral, PERPL_TESTNET_CONTRACTS.collateral)
    ) {
      throw new Error(
        'Perpl context names a different Exchange or collateral than PERPL_TESTNET_CONTRACTS; ' +
          'mandate policies are stale',
      );
    }

    const calls = perplOnboardingCalls(params, amount);
    const receipts = await this.#sender.sendAll(
      agent,
      calls.map((call, i) => ({ ...call, gas: PERPL_ONBOARDING_GAS[STEPS[i]!] })),
    );
    const failed = receipts.findIndex((receipt) => !receipt.success);
    if (failed >= 0)
      throw new PerplOnboardingError(STEPS[failed]!, receipts[failed]!.transactionHash);

    const accountId = await this.accountId(agent);
    if (accountId === null)
      throw new Error(`Perpl onboarding landed but ${agent.address} has no account`);
    return { accountId, onboarded: true, transactions: receipts.map((r) => r.transactionHash) };
  }

  /**
   * The agent's Perpl API credentials: from the secret store if held,
   * otherwise enrolled once (a Privy-signed EIP-712 message) and stored.
   * Never enrolls for an address without a Perpl account.
   */
  async credentials(agent: AgentIdentity): Promise<PerplCredentials> {
    const held = await this.#secrets.getPerplCredentials(agent.agentId);
    if (held) return held;

    let enrolling = this.#enrolling.get(agent.agentId);
    if (!enrolling) {
      enrolling = this.#enroll(agent).finally(() => this.#enrolling.delete(agent.agentId));
      this.#enrolling.set(agent.agentId, enrolling);
    }
    return enrolling;
  }

  async #enroll(agent: AgentIdentity): Promise<PerplCredentials> {
    if ((await this.accountId(agent)) === null) throw new PerplNotOnboardedError(agent.address);
    const { credentials } = await enrollApiKey({
      restUrl: this.#network.restUrl,
      chainId: this.#network.chainId,
      signer: {
        address: agent.address,
        signTypedData: (typedData) =>
          this.#wallets.signTypedData(agent.walletId, typedData as unknown as TypedDataDefinition),
      },
      label: `sente-agent-${agent.agentId}`.slice(0, 40),
      fetchImpl: this.#fetch,
    });
    await this.#secrets.putPerplCredentials(agent.agentId, credentials);
    credentials.secretKey.fill(0); // the store holds its own copy
    return (await this.#secrets.getPerplCredentials(agent.agentId))!;
  }

  async #context(): Promise<PerplContext> {
    const response = await this.#fetch(
      `${this.#network.restUrl.replace(/\/+$/, '')}/v1/pub/context`,
    );
    if (!response.ok) throw new Error(`Perpl context: HTTP ${response.status}`);
    return (await response.json()) as PerplContext;
  }
}
