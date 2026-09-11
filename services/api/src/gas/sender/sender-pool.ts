import type { Address } from 'viem';

import { GasDripRefusedError } from '../gas.errors';
import type { DripSendResult, DripSender } from './drip-sender';

/**
 * Round-robin over independent faucet keys. See `nonce-managed-sender.ts` for
 * why more than one key is needed at all.
 *
 * Rotation is a plain cursor rather than least-loaded: with a single writer per
 * key the queues drain at the same rate, and a cursor is trivially fair and has
 * no state to get wrong. A send is NOT retried on a different key — a failure
 * here is almost always "faucet is out of MON" or "RPC is down", and both keys
 * would fail identically while the retry burned a second nonce.
 *
 * The pool also remembers when each key last sent, whoever sent it.
 * `ReserveAwareDispatcher`, which every drip goes through since SEN-16, reads
 * that to keep its sends clear of a key's previous one (Monad's reserve
 * balance, CLAUDE.md gotcha 12). `send` here is the bare, unspaced path: it
 * only records the send, and no drip uses it any more.
 */
export class SenderPool {
  private cursor = 0;
  private readonly lastUsed = new Map<Address, number>();

  constructor(
    private readonly senders: readonly DripSender[],
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.senders.length;
  }

  addresses(): Address[] {
    return this.senders.map((sender) => sender.address);
  }

  /** Every key, in configuration order. */
  members(): readonly DripSender[] {
    return this.senders;
  }

  /** When `address` last sent (epoch ms), from any caller; `undefined` if never. */
  lastUsedAt(address: Address): number | undefined {
    return this.lastUsed.get(address);
  }

  markUsed(address: Address, at: number = this.clock()): void {
    this.lastUsed.set(address, at);
  }

  send(to: Address, valueWei: bigint, gasLimit: bigint): Promise<DripSendResult> {
    if (this.senders.length === 0) {
      return Promise.reject(
        new GasDripRefusedError(
          'faucet_unconfigured',
          'No faucet senders configured; set GAS_DRIP_PRIVATE_KEYS',
        ),
      );
    }
    const sender = this.senders[this.cursor] as DripSender;
    this.cursor = (this.cursor + 1) % this.senders.length;
    this.markUsed(sender.address);
    return sender.send(to, valueWei, gasLimit);
  }
}
