/**
 * Transactions from an agent's Privy wallet: sign in the enclave, broadcast
 * ourselves, read the receipt.
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
 * 4), so each caller supplies a measured, fixed limit per call.
 *
 * Erasable syntax and `.ts` specifiers only: scripts/agent-venues-live.ts loads
 * this file under node's type stripping (CLAUDE.md gotcha 10).
 */
import type { Address, Hex, PublicClient } from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider.ts';
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
  readonly transactionHash: Hex;
  /** From the receipt's `status`: for an EOA the transaction IS the operation. */
  readonly success: boolean;
  readonly logs: readonly AgentLog[];
  /** The block the transaction was confirmed in (SEN-20). */
  readonly blockNumber: bigint;
}

/** The slice of a Monad RPC client the sender needs, so specs fake five lines, not viem. */
export interface AgentChainClient {
  pendingNonce(address: Address): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(serialized: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<AgentReceipt>;
}

/** {@link AgentChainClient} over a viem public client. */
export function agentChainClient(client: PublicClient): AgentChainClient {
  return {
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: 'pending' }),
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

export interface AgentTransactionSenderOptions {
  readonly wallets: AgentWalletProvider;
  readonly chain: AgentChainClient;
  readonly chainId?: number;
}

export class AgentTransactionSender {
  readonly #wallets: AgentWalletProvider;
  readonly #chain: AgentChainClient;
  readonly #chainId: number;
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
  }

  /**
   * Sends `txs` in order, one at a time, as one unit of the wallet's queue.
   * Returns a receipt per transaction that was broadcast; it stops after the
   * first reverted one. A signing refusal (`EnclaveRefusedError`) rejects
   * unchanged, and the refused transaction is never broadcast.
   */
  sendAll(wallet: AgentWalletRef, txs: readonly AgentTransaction[]): Promise<AgentReceipt[]> {
    return this.#serial(wallet.walletId, async () => {
      const receipts: AgentReceipt[] = [];
      for (const tx of txs) {
        const receipt = await this.#sendOne(wallet, tx);
        receipts.push(receipt);
        if (!receipt.success) break;
      }
      return receipts;
    });
  }

  async #sendOne(wallet: AgentWalletRef, tx: AgentTransaction): Promise<AgentReceipt> {
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
      ...(tx.value !== undefined && tx.value > 0n ? { value: tx.value } : {}),
      chainId: this.#chainId,
      nonce,
      gas: tx.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });

    // A refusal throws here, before anything reaches the chain.
    const signed = await this.#wallets.signTransaction(wallet.walletId, request);
    const hash = await this.#chain.sendRawTransaction(signed);
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
