import type { Address } from 'viem';

import type {
  DripSendResult,
  DripSender,
  NonceSource,
  TransactionBroadcaster,
} from './drip-sender';

/**
 * ---------------------------------------------------------------------------
 * NONCE CONTENTION
 *
 * A hot wallet has one nonce sequence. Fire N concurrent drips at it and every
 * one of them reads the same `pending` nonce from the node, so N-1 transactions
 * are replacements of the first — they either bounce with "nonce too low" or
 * silently evict each other, and under load the faucet appears to deadlock.
 *
 * The fix has two halves, and this class is the second:
 *
 *   1. `SenderPool` spreads load round-robin over 3-5 independent keys, so
 *      throughput is not bounded by one sequence.
 *   2. Each key has exactly ONE writer. Every send for an address queues behind
 *      the previous one on `tail`, so nonce assignment and broadcast happen in a
 *      critical section: read local counter, broadcast, increment. The node is
 *      asked for the nonce once (lazily, `pending`), then the counter is
 *      authoritative — asking again mid-flight would re-read a stale value
 *      because the previous transaction is not mined yet.
 *
 * On a failed broadcast the local counter is dropped so the next send resyncs
 * from the chain. That is the only safe move: we cannot tell "rejected, nonce
 * unused" from "accepted, response lost" locally.
 * ---------------------------------------------------------------------------
 */
export class NonceManagedSender implements DripSender {
  /** Next nonce to use. `null` means "resync from the node before sending". */
  private nextNonce: number | null = null;
  /** Tail of the per-key serialisation chain. Never rejects. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly address: Address,
    private readonly nonces: NonceSource,
    private readonly broadcaster: TransactionBroadcaster,
    /**
     * Explicit gas limit. Monad charges `value + gas_bid * gas_limit`, so an
     * over-estimate is money spent, not reserved — never pass an estimateGas
     * result here. See CLAUDE.md gotcha 4.
     */
    private readonly gasLimit: bigint,
  ) {}

  send(to: Address, valueWei: bigint): Promise<DripSendResult> {
    return this.enqueue(() => this.sendSerialised(to, valueWei));
  }

  /** Appends `task` to this key's single-writer chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // `.then(task, task)` so one failed send does not poison the queue.
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendSerialised(to: Address, valueWei: bigint): Promise<DripSendResult> {
    if (this.nextNonce === null) {
      this.nextNonce = await this.nonces.getTransactionCount({
        address: this.address,
        blockTag: 'pending',
      });
    }

    const nonce = this.nextNonce;
    try {
      const hash = await this.broadcaster.sendTransaction({
        to,
        value: valueWei,
        gas: this.gasLimit,
        nonce,
      });
      this.nextNonce = nonce + 1;
      return { hash, nonce, sender: this.address };
    } catch (error) {
      this.nextNonce = null;
      throw error;
    }
  }
}
