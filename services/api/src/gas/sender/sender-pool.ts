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
 */
export class SenderPool {
  private cursor = 0;

  constructor(private readonly senders: readonly DripSender[]) {}

  get size(): number {
    return this.senders.length;
  }

  addresses(): Address[] {
    return this.senders.map((sender) => sender.address);
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
    return sender.send(to, valueWei, gasLimit);
  }
}
