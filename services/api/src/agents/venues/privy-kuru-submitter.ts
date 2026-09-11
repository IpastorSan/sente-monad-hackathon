/**
 * `KuruSubmitter` for an agent's Privy wallet.
 *
 * The agent's EOA is its own AccountCore root (`userId = 0` resolves to the
 * caller), so the adapter's call lists go out as plain transactions, one per
 * call, through the wallet's {@link AgentTransactionSender} queue. Every
 * signature is checked against the agent's mandate policy inside Privy's
 * enclave; a refusal rejects with `EnclaveRefusedError` and nothing is sent.
 *
 * NOT ATOMIC. The Kernel submitter lands `approve` + `deposit` as one batch;
 * here they are two transactions, and a deposit that reverts leaves its
 * exact-amount approval standing. `success` is false in that case and `hash`
 * names the transaction that reverted.
 */
import {
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_FAUCET,
  KURU_MEASURED_GAS,
  KURU_ORDERBOOK_BATCH_ABI,
  type KuruCall,
  type KuruExecution,
  type KuruSubmitter,
} from '@sente/venues/kuru';
import { decodeFunctionData, type Abi, type Address } from 'viem';

import type { AgentTransactionSender, AgentWalletRef } from './agent-transactions.ts';

/**
 * ERC-20 `approve`, for USDC and AUSD alike. Measured 52,089 (USDC to
 * AccountCore) and 71,099 (AUSD to a fresh spender); one limit for both.
 */
export const AGENT_APPROVE_GAS = 80_000n;

const APPROVE_SELECTOR = '0x095ea7b3';

/** A call this module has no measured gas limit for. Refused before anything is signed. */
export class UnmeasuredCallError extends Error {
  readonly to: Address;
  readonly selector: string;

  constructor(call: KuruCall) {
    const selector = call.data?.slice(0, 10) ?? '0x';
    super(
      `no measured gas limit for ${selector} on ${call.to}; refusing to guess one ` +
        '(Monad charges the whole limit, CLAUDE.md gotcha 4)',
    );
    this.name = 'UnmeasuredCallError';
    this.to = call.to;
    this.selector = selector;
  }
}

function decode(abi: Abi, call: KuruCall) {
  if (!call.data) return undefined;
  try {
    return decodeFunctionData({ abi, data: call.data });
  } catch {
    return undefined;
  }
}

/**
 * The fixed gas limit for one call the Kuru adapter emits, from
 * `KURU_MEASURED_GAS` (measured from an EOA on Monad testnet).
 *
 * A placement is given the one-level TAKING limit, which also covers a GTC
 * order that rests (404,204 < 425,430). An IOC that sweeps several levels can
 * need more; pass a `gasLimit` override to the submitter for that.
 */
export function kuruGasLimit(call: KuruCall): bigint {
  const selector = call.data?.slice(0, 10).toLowerCase();
  if (selector === APPROVE_SELECTOR) return AGENT_APPROVE_GAS;
  if (selector === KURU_FAUCET.claimSelector) return KURU_FAUCET.claimGas;
  // The first deposit also registers the account; later ones cost less.
  if (decode(KURU_ACCOUNT_CORE_DEPOSIT_ABI, call)) return KURU_MEASURED_GAS.firstDeposit;

  const batch = decode(KURU_ORDERBOOK_BATCH_ABI, call);
  if (batch?.functionName === 'batch') {
    const [, orders, cancels] = batch.args as readonly [
      unknown,
      readonly unknown[],
      readonly unknown[],
    ];
    if (orders.length === 1 && cancels.length === 0) return KURU_MEASURED_GAS.placeTakingOneLevel;
    if (orders.length === 0 && cancels.length === 1) return KURU_MEASURED_GAS.cancelOne;
  }
  throw new UnmeasuredCallError(call);
}

export interface PrivyKuruSubmitterOptions {
  readonly wallet: AgentWalletRef;
  /** Shared across every venue of the wallet, so they all use one queue. */
  readonly sender: AgentTransactionSender;
  /** Defaults to {@link kuruGasLimit}. */
  readonly gasLimit?: (call: KuruCall) => bigint;
}

export class PrivyKuruSubmitter implements KuruSubmitter {
  readonly address: Address;
  readonly #wallet: AgentWalletRef;
  readonly #sender: AgentTransactionSender;
  readonly #gasLimit: (call: KuruCall) => bigint;

  constructor(options: PrivyKuruSubmitterOptions) {
    this.address = options.wallet.address;
    this.#wallet = options.wallet;
    this.#sender = options.sender;
    this.#gasLimit = options.gasLimit ?? kuruGasLimit;
  }

  async submit(calls: readonly KuruCall[]): Promise<KuruExecution> {
    if (calls.length === 0) throw new Error('PrivyKuruSubmitter: no calls to submit');
    // Every limit is resolved first, so an unmeasured call refuses the whole
    // list before its first leg is signed.
    const txs = calls.map((call) => ({ ...call, gas: this.#gasLimit(call) }));
    const receipts = await this.#sender.sendAll(this.#wallet, txs);
    const last = receipts[receipts.length - 1]!;
    return {
      hash: last.transactionHash,
      transactionHash: last.transactionHash,
      success: receipts.length === calls.length && last.success,
      logs: receipts.flatMap((receipt) => receipt.logs),
    };
  }
}
