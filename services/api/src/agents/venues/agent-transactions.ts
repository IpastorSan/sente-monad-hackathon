/**
 * Transactions from an agent's Privy wallet: sign in the enclave, broadcast
 * ourselves, read the receipt — or, with `AGENT_SPONSORED_SENDS` (SEN-211),
 * a Privy-sponsored send whose USER OPERATION receipt decides the outcome.
 *
 * The agent wallet is a plain EOA, so every call is its own transaction and a
 * call list is NOT atomic — unlike the user's Kernel batch (CLAUDE.md gotcha
 * 8). A list stops at the first revert; what landed before it stays landed.
 *
 * ONE TRANSACTION IN FLIGHT PER WALLET. Sign → broadcast → receipt runs to
 * completion before the wallet's next transaction starts, and a call list is
 * one unit, so nothing from the same wallet interleaves with it. That keeps
 * nonces sane without a nonce manager, and keeps Privy's rolling-cap
 * aggregation as exact as Privy allows (it updates only after a sign lands —
 * docs/privy-policy-enforcement.md).
 *
 * GAS IS NEVER ESTIMATED HERE. Monad charges the gas LIMIT (CLAUDE.md gotcha
 * 4), so each caller supplies a measured, fixed limit per call. A sponsored
 * send ignores it: Privy's bundler sizes the operation, and its credits pay.
 *
 * SPONSORED (SEN-211, `sponsored` option). Each transaction goes to Privy as
 * `eth_sendTransaction` with `sponsor: true`; the agent needs no MON. Success is
 * the user operation's own `success` flag read off `UserOperationEvent`, never
 * the bundle transaction's status (gotcha 8), and the logs returned are that
 * operation's own, cut out of the bundle's receipt. Two fallbacks keep it safe
 * to switch on for agents hired before it:
 *
 * - a `policy_violation` on the sponsored path falls back to the sign path for
 *   that transaction. A policy compiled without the sponsored twins refuses
 *   every sponsored send; the sign path re-asks the SAME mandate, so a call the
 *   mandate forbids is refused there too, and nothing is widened.
 * - "EIP-7702 nonce mismatch" — a send composed before the wallet's first,
 *   delegating operation landed (gotcha 12) — is retried once after
 *   `sponsoredRetryMs`. Every other rejection throws: Privy simulates before
 *   it submits, so it is a call that would revert, and nothing reached chain.
 *
 * Erasable syntax and `.ts` specifiers only: scripts/agent-venues-live.ts loads
 * this file under node's type stripping (CLAUDE.md gotcha 10).
 */
import { formatEther, type Address, type Hex, type PublicClient } from 'viem';

import {
  awaitUserOperation,
  userOperationLogs,
  type UserOperationLogClient,
  type UserOperationOutcome,
} from '../../wallet/confirmation/user-operation-logs.ts';
import type { AgentWalletProvider } from '../agent-wallet.provider.ts';
import { EnclaveRefusedError, SponsoredSendRejectedError } from '../agents.errors.ts';
import { privyTransaction } from '../privy/agent-wallet.ts';

/** Monad testnet. Both venues are testnet-only today. */
export const AGENT_CHAIN_ID = 10143;

/** Who an agent is, as far as its venues care. */
export interface AgentIdentity {
  readonly agentId: string;
  /** Privy's wallet id: what signs. */
  readonly walletId: string;
  /** The wallet's EOA address: what owns the venue accounts. */
  readonly address: Address;
}

/** The part of an {@link AgentIdentity} that sends transactions. */
export type AgentWalletRef = Pick<AgentIdentity, 'walletId' | 'address'>;

/** One contract call with its fixed gas limit. */
export interface AgentTransaction {
  readonly to: Address;
  readonly value?: bigint;
  readonly data?: Hex;
  readonly gas: bigint;
}

export interface AgentLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface AgentReceipt {
  /** The transaction that carried the call: the agent's own, or the bundle a sponsored send rode in. */
  readonly transactionHash: Hex;
  /**
   * Whether the call took effect: the receipt's `status` for the agent's own
   * transaction, the user operation's `success` for a sponsored send (gotcha 8).
   */
  readonly success: boolean;
  /** The call's own logs — for a sponsored send, only its user operation's. */
  readonly logs: readonly AgentLog[];
  /** The block the transaction was confirmed in (SEN-20). */
  readonly blockNumber: bigint;
  /** Present when the call went as a sponsored user operation (SEN-211). */
  readonly userOpHash?: Hex;
}

/** The slice of a Monad RPC client the sender needs, so specs fake six lines, not viem. */
export interface AgentChainClient {
  pendingNonce(address: Address): Promise<number>;
  /** The wallet's MON, in wei. */
  balance(address: Address): Promise<bigint>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(serialized: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<AgentReceipt>;
}

/** {@link AgentChainClient} over a viem public client. */
export function agentChainClient(client: PublicClient): AgentChainClient {
  return {
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: 'pending' }),
    balance: (address) => client.getBalance({ address }),
    fees: async () => {
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
        throw new Error('the RPC returned no EIP-1559 fees');
      }
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    },
    sendRawTransaction: (serializedTransaction) =>
      client.sendRawTransaction({ serializedTransaction }),
    waitForReceipt: async (hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      return {
        transactionHash: receipt.transactionHash,
        success: receipt.status === 'success',
        logs: receipt.logs,
        blockNumber: receipt.blockNumber,
      };
    },
  };
}

/**
 * The wallet's MON cannot cover a call list's gas, so nothing was signed.
 *
 * Monad's RPC refuses a transaction whose sender holds less than
 * `gas × maxFeePerGas + value` with -32000 "Signer had insufficient balance",
 * which viem renders as the bare "Missing or invalid parameters." (SEN-208).
 * Checked for the whole list up front, because the legs are NOT atomic: an
 * approve that lands before its deposit is refused spends MON for nothing.
 */
export class InsufficientGasError extends Error {
  readonly address: Address;
  readonly needWei: bigint;
  readonly haveWei: bigint;

  constructor(address: Address, needWei: bigint, haveWei: bigint, legs: number) {
    super(
      `The agent's wallet ${address} holds ${formatEther(haveWei)} MON, and ` +
        `${legs === 1 ? 'this transaction needs' : `these ${legs} transactions need`} up to ` +
        `${formatEther(needWei)} MON for gas (Monad reserves the whole gas limit at the max fee). ` +
        'Kuru writes wait until its owner funds it with MON; Perpl orders need none. ' +
        'Nothing was signed.',
    );
    this.name = 'InsufficientGasError';
    this.address = address;
    this.needWei = needWei;
    this.haveWei = haveWei;
  }
}

/** Following a sponsored send on chain (SEN-211). */
export interface AgentUserOperationClient {
  headBlock(): Promise<bigint>;
  /** The operation's outcome, or `null` if it did not surface in time. */
  waitForUserOperation(userOpHash: Hex, fromBlock: bigint): Promise<UserOperationOutcome | null>;
}

/** How long a sponsored send may take to surface before the sender gives up on it. */
export const SPONSORED_CONFIRM_TIMEOUT_MS = 60_000;

/** {@link AgentUserOperationClient} over a viem public client, reading `UserOperationEvent`. */
export function agentUserOperationClient(
  client: PublicClient,
  timeoutMs = SPONSORED_CONFIRM_TIMEOUT_MS,
): AgentUserOperationClient {
  return {
    headBlock: () => client.getBlockNumber({ cacheTime: 0 }),
    waitForUserOperation: async (userOpHash, fromBlock) =>
      (
        await awaitUserOperation(client as unknown as UserOperationLogClient, userOpHash, {
          fromBlock,
          timeoutMs,
        })
      ).outcome,
  };
}

/** The wait before retrying a sponsored send refused for a stale EIP-7702 nonce. */
export const SPONSORED_NONCE_RETRY_MS = 4_000;

/**
 * One transaction the sender put on chain, for the logs (SEN-212): which path
 * it took and how long each half took. `signed_after_refusal` is a sponsored
 * send the policy refused and the sign path then carried, paid in the agent's
 * own MON — an agent whose policy predates `AGENT_SPONSORED_SENDS`.
 */
export interface AgentSendReport {
  readonly walletId: string;
  readonly to: Address;
  readonly via: 'sponsored' | 'signed' | 'signed_after_refusal';
  readonly transactionHash: Hex;
  readonly userOpHash?: Hex;
  readonly success: boolean;
  /** From the first request to Privy until it answered (sponsored) or the broadcast returned. */
  readonly submitMs: number;
  /** From that answer until the outcome was read off the chain. */
  readonly confirmMs: number;
}

export interface AgentTransactionSenderOptions {
  readonly wallets: AgentWalletProvider;
  readonly chain: AgentChainClient;
  readonly chainId?: number;
  /**
   * Send through Privy's gas sponsorship (SEN-211, `AGENT_SPONSORED_SENDS`).
   * Absent, every transaction is signed and broadcast as before. Ignored when
   * the wallet provider cannot send sponsored.
   */
  readonly sponsored?: AgentUserOperationClient;
  /** Defaults to {@link SPONSORED_NONCE_RETRY_MS}. */
  readonly sponsoredRetryMs?: number;
  /** Told about every transaction that reached the chain, after its outcome is known. */
  readonly onSent?: (report: AgentSendReport) => void;
}

/** When one send started, and when it was handed over (0 until it is). */
interface SendTiming {
  readonly startedAt: number;
  submittedAt: number;
}

export class AgentTransactionSender {
  readonly #wallets: AgentWalletProvider;
  readonly #chain: AgentChainClient;
  readonly #chainId: number;
  readonly #sponsored: AgentUserOperationClient | undefined;
  readonly #sponsoredRetryMs: number;
  readonly #onSent: ((report: AgentSendReport) => void) | undefined;
  /** The tail of each wallet's queue. */
  readonly #tails = new Map<string, Promise<unknown>>();
  /**
   * The last nonce each wallet broadcast. The public RPC is load-balanced, so
   * a `pending` count read right after a receipt can come from a node that
   * has not seen it yet; never reuse a nonce this process already spent.
   */
  readonly #lastNonce = new Map<string, number>();

  constructor(options: AgentTransactionSenderOptions) {
    this.#wallets = options.wallets;
    this.#chain = options.chain;
    this.#chainId = options.chainId ?? AGENT_CHAIN_ID;
    this.#sponsored = options.wallets.sendSponsoredTransaction ? options.sponsored : undefined;
    this.#sponsoredRetryMs = options.sponsoredRetryMs ?? SPONSORED_NONCE_RETRY_MS;
    this.#onSent = options.onSent;
  }

  /** Whether transactions go out Privy-sponsored (SEN-211). */
  get sponsored(): boolean {
    return this.#sponsored !== undefined;
  }

  /**
   * Whether Privy pays this agent's gas (SEN-212): sends are sponsored AND its
   * live policy carries the sponsored twins. Then the agent's MON decides
   * nothing, and a MON gate in front of a send would refuse what Privy would
   * have paid for. An agent whose policy predates the flag falls back to
   * signing, paid in its own MON, so its gate stays.
   */
  sponsorsGasFor(agent: { readonly sponsoredSends?: boolean }): boolean {
    return this.sponsored && agent.sponsoredSends === true;
  }

  /**
   * Sends `txs` in order, one at a time, as one unit of the wallet's queue.
   * Returns a receipt per transaction that was broadcast; it stops after the
   * first reverted one. A signing refusal (`EnclaveRefusedError`) rejects
   * unchanged, and the refused transaction is never broadcast. A wallet whose
   * MON cannot pay the whole list's gas rejects with `InsufficientGasError`
   * before the first leg is signed — unless sends are sponsored, where Privy
   * pays and the wallet's MON is not what decides it.
   */
  sendAll(wallet: AgentWalletRef, txs: readonly AgentTransaction[]): Promise<AgentReceipt[]> {
    return this.#serial(wallet.walletId, async () => {
      if (!this.#sponsored) await this.#gasGate(wallet, txs);
      const receipts: AgentReceipt[] = [];
      for (const tx of txs) {
        const receipt = await this.#sendOne(wallet, tx);
        receipts.push(receipt);
        if (!receipt.success) break;
      }
      return receipts;
    });
  }

  /** Every leg priced at the limit and today's max fee, against the wallet's MON. */
  async #gasGate(wallet: AgentWalletRef, txs: readonly AgentTransaction[]): Promise<void> {
    const [have, fees] = await Promise.all([
      this.#chain.balance(wallet.address),
      this.#chain.fees(),
    ]);
    const need = txs.reduce((sum, tx) => sum + tx.gas * fees.maxFeePerGas + (tx.value ?? 0n), 0n);
    if (have < need) throw new InsufficientGasError(wallet.address, need, have, txs.length);
  }

  async #sendOne(wallet: AgentWalletRef, tx: AgentTransaction): Promise<AgentReceipt> {
    const timing = { startedAt: Date.now(), submittedAt: 0 };
    let via: AgentSendReport['via'] = 'signed';
    let receipt: AgentReceipt | null = null;
    if (this.#sponsored) {
      receipt = await this.#sendSponsored(wallet, tx, this.#sponsored, timing);
      via = receipt ? 'sponsored' : 'signed_after_refusal';
    }
    // A fallback skipped the up-front gas gate (sponsored lists are not gated),
    // so its one leg is gated between the enclave's yes and the broadcast.
    receipt ??= await this.#signAndBroadcast(wallet, tx, timing, via === 'signed_after_refusal');
    this.#report(wallet, tx, via, receipt, timing);
    return receipt;
  }

  #report(
    wallet: AgentWalletRef,
    tx: AgentTransaction,
    via: AgentSendReport['via'],
    receipt: AgentReceipt,
    timing: SendTiming,
  ): void {
    if (!this.#onSent) return;
    const submittedAt = timing.submittedAt || timing.startedAt;
    try {
      this.#onSent({
        walletId: wallet.walletId,
        to: tx.to,
        via,
        transactionHash: receipt.transactionHash,
        ...(receipt.userOpHash ? { userOpHash: receipt.userOpHash } : {}),
        success: receipt.success,
        submitMs: submittedAt - timing.startedAt,
        confirmMs: Date.now() - submittedAt,
      });
    } catch {
      // A report is for the logs; it never fails a transaction that landed.
    }
  }

  /**
   * One sponsored send, followed to its user operation's receipt. `null` when
   * the policy refused it — the cue to fall back to the sign path.
   */
  async #sendSponsored(
    wallet: AgentWalletRef,
    tx: AgentTransaction,
    userOps: AgentUserOperationClient,
    timing: SendTiming,
  ): Promise<AgentReceipt | null> {
    const send = this.#wallets.sendSponsoredTransaction!.bind(this.#wallets);
    const call = {
      to: tx.to,
      ...(tx.data === undefined ? {} : { data: tx.data }),
      value: tx.value ?? 0n,
    };
    // Logs are read from here on: an operation lands within a second or so.
    const fromBlock = await userOps.headBlock();
    let sent;
    try {
      sent = await send(wallet.walletId, this.#chainId, call).catch(async (error: unknown) => {
        if (!(error instanceof SponsoredSendRejectedError) || !error.nonceMismatch) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.#sponsoredRetryMs));
        return send(wallet.walletId, this.#chainId, call);
      });
    } catch (error) {
      if (error instanceof EnclaveRefusedError) return null;
      throw error;
    }
    timing.submittedAt = Date.now();
    if (!sent.userOpHash) {
      // Privy broadcast a plain transaction instead of bundling one: follow it.
      if (sent.transactionHash) return this.#chain.waitForReceipt(sent.transactionHash);
      throw new Error(`Privy answered a sponsored send from ${wallet.walletId} with no hash`);
    }
    const outcome = await userOps.waitForUserOperation(sent.userOpHash, fromBlock);
    if (!outcome) {
      throw new Error(
        `sponsored send ${sent.userOpHash} from ${wallet.walletId} did not surface on chain; ` +
          'it may still land',
      );
    }
    const bundle = await this.#chain.waitForReceipt(outcome.transactionHash);
    return {
      transactionHash: outcome.transactionHash,
      success: outcome.success,
      logs: userOperationLogs(bundle.logs, sent.userOpHash),
      blockNumber: outcome.blockNumber,
      userOpHash: sent.userOpHash,
    };
  }

  async #signAndBroadcast(
    wallet: AgentWalletRef,
    tx: AgentTransaction,
    timing: SendTiming,
    gateGas = false,
  ): Promise<AgentReceipt> {
    const [pending, fees] = await Promise.all([
      this.#chain.pendingNonce(wallet.address),
      this.#chain.fees(),
    ]);
    const last = this.#lastNonce.get(wallet.walletId);
    const nonce = last === undefined ? pending : Math.max(pending, last + 1);

    // Every integer goes to Privy as 0x-hex (privyTransaction): a decimal
    // string is rejected, and fee values overflow a JSON-safe number.
    const request = privyTransaction({
      to: tx.to,
      data: tx.data ?? '0x',
      value: tx.value ?? 0n,
      chainId: this.#chainId,
      nonce,
      gas: tx.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    // A refusal throws here, before anything reaches the chain.
    const signed = await this.#wallets.signTransaction(wallet.walletId, request);
    // After the sign, so a call the mandate forbids is still reported as that,
    // not as a gas shortfall; a signature that is never broadcast costs nothing.
    if (gateGas) await this.#gasGate(wallet, [tx]);
    const hash = await this.#chain.sendRawTransaction(signed);
    timing.submittedAt = Date.now();
    this.#lastNonce.set(wallet.walletId, nonce);
    return this.#chain.waitForReceipt(hash);
  }

  #serial<T>(walletId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(walletId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.#tails.set(walletId, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.#tails.get(walletId) === next) this.#tails.delete(walletId);
      });
    return next;
  }
}
