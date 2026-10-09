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
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
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

/** An address's Perpl account as the Exchange holds it: collateral atoms (AUSD, 6 dp). */
export interface PerplAccountInfo {
  readonly accountId: bigint;
  /** `balanceCNS`: the account's collateral, resting-order reservations included. */
  readonly balance: bigint;
  /** `lockedBalanceCNS`: what resting orders reserve out of `balance`. */
  readonly locked: bigint;
}

/**
 * The full `getAccountByAddr` tuple, for reading an account WITHOUT API
 * credentials (SEN-78, plan finding #1): almost no agent has an enrolled key,
 * so the portfolio falls back to this for a balance. Positions are not
 * readable from it (they are packed into opaque bank words). `null` for no
 * account, which the Exchange signals by reverting or by id 0; any other read
 * failure throws.
 */
export async function perplAccountInfo(
  client: PublicClient,
  address: Address,
  exchange: Address = PERPL_TESTNET_CONTRACTS.exchange,
): Promise<PerplAccountInfo | null> {
  let account;
  try {
    account = await client.readContract({
      address: exchange,
      abi: PERPL_EXCHANGE_ABI,
      functionName: 'getAccountByAddr',
      args: [address],
    });
  } catch (error) {
    // Only a revert means "no account". An RPC failure must surface as one,
    // or a flaky node would show a funded account as never opened.
    if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError))
      return null;
    throw error;
  }
  if (account.accountId === 0n) return null;
  return {
    accountId: account.accountId,
    balance: account.balanceCNS,
    locked: account.lockedBalanceCNS,
  };
}

export class PerplOnboardingError extends Error {
  readonly step: string;
  readonly transactionHash: Hex;

  constructor(step: string, transactionHash: Hex) {
    super(`Perpl onboarding: ${step} reverted in ${transactionHash}`);
    this.name = 'PerplOnboardingError';
    this.step = step;
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

export type PerplOnboardingStep = 'approve' | 'createAccount' | 'allowOrderForwarding';

export interface PerplOnboarding {
  readonly accountId: bigint;
  /** True when this call opened the account (`createAccount` was sent). */
  readonly onboarded: boolean;
  /** One hash per transaction sent, in the order of `steps`. */
  readonly transactions: readonly Hex[];
  /** What was sent, in order. Empty when nothing was. */
  readonly steps: readonly PerplOnboardingStep[];
  /** AUSD atoms the new account was opened with; absent unless `onboarded`. */
  readonly amount?: bigint;
}

/** What {@link PerplAgentAccounts.onboard} is about to send, for a caller's last check. */
export interface PerplOnboardingPlan {
  readonly steps: readonly PerplOnboardingStep[];
  /** The sum of the steps' fixed limits: what Monad charges (gotcha 4). */
  readonly gas: bigint;
  /** The account that already exists, when only forwarding is left to grant. */
  readonly accountId: bigint | null;
}

export interface PerplOnboardOptions {
  /**
   * Whether the account is known to forward orders. `true` (the default) leaves
   * an existing account alone, as `onboard` always did. `false` or `null`
   * (unknown) re-grants forwarding on an existing account — the resume after a
   * run that died between `createAccount` and `allowOrderForwarding`. The
   * Exchange's `getAccountByAddr` does not say, and re-granting is harmless.
   */
  readonly forwarding?: boolean | null;
  /**
   * Called with what is about to be sent, before anything is signed. Throw to
   * send nothing — the gas gate (SEN-187) lives here, so it sees the exact legs.
   */
  readonly beforeSend?: (plan: PerplOnboardingPlan) => void | Promise<void>;
}

/** Resolves the AUSD an address has approved to the Exchange. */
export type PerplAllowanceReader = (owner: Address) => Promise<bigint>;

/** {@link PerplAllowanceReader} over `AUSD.allowance(owner, Exchange)`. */
export function perplAllowanceReader(
  client: PublicClient,
  contracts: { exchange: Address; collateral: Address } = PERPL_TESTNET_CONTRACTS,
): PerplAllowanceReader {
  return (owner) =>
    client.readContract({
      address: contracts.collateral,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, contracts.exchange],
    });
}

/** The gas Monad will charge for these onboarding steps: their fixed limits, summed. */
export function perplOnboardingGas(steps: readonly PerplOnboardingStep[]): bigint {
  return steps.reduce((sum, step) => sum + PERPL_ONBOARDING_GAS[step], 0n);
}

export interface PerplAgentAccountsOptions {
  readonly sender: AgentTransactionSender;
  readonly wallets: AgentWalletProvider;
  readonly secrets: AgentSecretStore;
  readonly accountOf: PerplAccountReader;
  /**
   * The wallet's AUSD allowance to the Exchange. With it, an approve that
   * already landed (a run that died before `createAccount`) is not sent again;
   * without it, every opening approves.
   */
  readonly allowanceOf?: PerplAllowanceReader;
  /** Defaults to testnet. */
  readonly network?: PerplNetwork;
  readonly fetchImpl?: typeof fetch;
}

export class PerplAgentAccounts {
  readonly #sender: AgentTransactionSender;
  readonly #wallets: AgentWalletProvider;
  readonly #secrets: AgentSecretStore;
  readonly #accountOf: PerplAccountReader;
  readonly #allowanceOf: PerplAllowanceReader | undefined;
  readonly #network: PerplNetwork;
  readonly #fetch: typeof fetch;
  /** One enrollment per agent at a time: concurrent callers share it. */
  readonly #enrolling = new Map<string, Promise<PerplCredentials>>();

  constructor(options: PerplAgentAccountsOptions) {
    this.#sender = options.sender;
    this.#wallets = options.wallets;
    this.#secrets = options.secrets;
    this.#accountOf = options.accountOf;
    this.#allowanceOf = options.allowanceOf;
    this.#network = options.network ?? PERPL_NETWORKS.testnet;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  accountId(agent: AgentIdentity): Promise<bigint | null> {
    return this.#accountOf(agent.address);
  }

  /**
   * Opens the agent's Perpl account: approve → createAccount(amount) →
   * allowOrderForwarding(true), Privy-signed transactions through the wallet's
   * queue. `amount` defaults to the venue minimum (100 AUSD on testnet) and
   * must fit the mandate's `perpl.maxCollateralAtoms`, or the enclave refuses
   * the approve and nothing is sent.
   *
   * It RESUMES (SEN-187): an approve that already covers `amount` is not sent
   * again (with `allowanceOf`), and an existing account gets only the
   * forwarding grant when `options.forwarding` is not `true`. With an account
   * and forwarding known on, it sends nothing.
   */
  async onboard(
    agent: AgentIdentity,
    amount?: bigint,
    options: PerplOnboardOptions = {},
  ): Promise<PerplOnboarding> {
    const existing = await this.accountId(agent);
    const forwarding = options.forwarding ?? true;
    if (existing !== null && forwarding === true) {
      return { accountId: existing, onboarded: false, transactions: [], steps: [] };
    }

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

    const opening = amount ?? params.minAccountOpenAmount;
    const [approve, create, forward] = perplOnboardingCalls(params, opening);
    const legs: { step: PerplOnboardingStep; call: typeof approve }[] = [];
    if (existing === null) {
      const approved = this.#allowanceOf ? await this.#allowanceOf(agent.address) : 0n;
      if (approved < opening) legs.push({ step: 'approve', call: approve });
      legs.push({ step: 'createAccount', call: create });
    }
    legs.push({ step: 'allowOrderForwarding', call: forward });
    const steps = legs.map((leg) => leg.step);
    await options.beforeSend?.({ steps, gas: perplOnboardingGas(steps), accountId: existing });

    const receipts = await this.#sender.sendAll(
      agent,
      legs.map(({ step, call }) => ({ ...call, gas: PERPL_ONBOARDING_GAS[step] })),
    );
    const failed = receipts.findIndex((receipt) => !receipt.success);
    if (failed >= 0)
      throw new PerplOnboardingError(steps[failed]!, receipts[failed]!.transactionHash);

    const accountId = existing ?? (await this.accountId(agent));
    if (accountId === null)
      throw new Error(`Perpl onboarding landed but ${agent.address} has no account`);
    const opened = existing === null;
    return {
      accountId,
      onboarded: opened,
      transactions: receipts.map((r) => r.transactionHash),
      steps,
      ...(opened ? { amount: opening } : {}),
    };
  }

  /**
   * The agent's Perpl API credentials: from the secret store if held,
   * otherwise enrolled once (a Privy-signed EIP-712 message) and stored.
   * Never enrolls for an address without a Perpl account.
   */
  credentials(agent: AgentIdentity): Promise<PerplCredentials> {
    // The store read happens INSIDE the single flight (SEN-148). Read outside
    // it, a caller whose read resolved just before a finishing enrollment
    // stored its key would find the flight already gone and enroll a second
    // key: a burnt slot out of the account's 16.
    let pending = this.#enrolling.get(agent.agentId);
    if (!pending) {
      pending = this.#heldOrEnroll(agent).finally(() => this.#enrolling.delete(agent.agentId));
      this.#enrolling.set(agent.agentId, pending);
    }
    return pending;
  }

  async #heldOrEnroll(agent: AgentIdentity): Promise<PerplCredentials> {
    return (await this.#secrets.getPerplCredentials(agent.agentId)) ?? this.#enroll(agent);
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
