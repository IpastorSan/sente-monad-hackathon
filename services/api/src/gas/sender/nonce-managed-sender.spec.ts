import type { Address, Hash } from 'viem';

import { GasDripRefusedError } from '../gas.errors';
import type { NonceSource, TransactionBroadcaster } from './drip-sender';
import { NonceManagedSender } from './nonce-managed-sender';
import { SenderPool } from './sender-pool';

const GAS_LIMIT = 21_000n;
const CONTRACT_GAS_LIMIT = 46_000n;
const ONE_TENTH_MON = 100_000_000_000_000_000n;

const to = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

/**
 * A broadcaster that records every call and hands back a hash encoding the
 * nonce, so a test can assert on nonces without reaching into private state.
 */
function fakeBroadcaster() {
  const calls: { to: Address; value: bigint; gas: bigint; nonce: number }[] = [];
  let failNext: Error | null = null;
  const broadcaster: TransactionBroadcaster = {
    sendTransaction: async (args) => {
      if (failNext) {
        const err = failNext;
        failNext = null;
        throw err;
      }
      // Yield, so concurrent sends genuinely interleave rather than running to
      // completion synchronously — without this the test cannot fail.
      await new Promise((resolve) => setTimeout(resolve, 1));
      calls.push(args);
      return `0x${args.nonce.toString(16).padStart(64, '0')}` as Hash;
    },
  };
  return {
    broadcaster,
    calls,
    failOnce: (err: Error) => {
      failNext = err;
    },
  };
}

function fakeNonces(start: number) {
  let reads = 0;
  const nonces: NonceSource = {
    getTransactionCount: async () => {
      reads += 1;
      return start;
    },
  };
  return { nonces, reads: () => reads };
}

describe('NonceManagedSender', () => {
  it('reads the chain nonce once, then counts locally', async () => {
    const { nonces, reads } = fakeNonces(7);
    const { broadcaster, calls } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    await sender.send(to(2), ONE_TENTH_MON, GAS_LIMIT);
    await sender.send(to(3), ONE_TENTH_MON, GAS_LIMIT);
    await sender.send(to(4), ONE_TENTH_MON, GAS_LIMIT);

    // Asking the node again mid-flight would re-read a stale value, because the
    // previous transaction is not mined yet.
    expect(reads()).toBe(1);
    expect(calls.map((c) => c.nonce)).toEqual([7, 8, 9]);
  });

  it('gives ten concurrent sends distinct consecutive nonces', async () => {
    const { nonces } = fakeNonces(100);
    const { broadcaster, calls } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => sender.send(to(i + 10), ONE_TENTH_MON, GAS_LIMIT)),
    );

    const used = results.map((r) => r.nonce).sort((a, b) => a - b);
    expect(new Set(used).size).toBe(10);
    expect(used).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(calls).toHaveLength(10);
  });

  it('always sends the explicit gas limit, never an estimate', async () => {
    const { nonces } = fakeNonces(0);
    const { broadcaster, calls } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    await sender.send(to(2), ONE_TENTH_MON, GAS_LIMIT);

    // Monad charges value + gas_bid * gas_limit, so an over-estimate is money
    // spent rather than reserved.
    expect(calls[0]?.gas).toBe(GAS_LIMIT);
    expect(calls[0]?.value).toBe(ONE_TENTH_MON);
  });

  it('takes the gas limit per send, so one key serves EOAs and contracts alike', async () => {
    const { nonces } = fakeNonces(0);
    const { broadcaster, calls } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    await Promise.all([
      sender.send(to(2), ONE_TENTH_MON, GAS_LIMIT),
      sender.send(to(3), ONE_TENTH_MON, CONTRACT_GAS_LIMIT),
      sender.send(to(4), ONE_TENTH_MON, GAS_LIMIT),
    ]);

    expect(calls.map((c) => [c.to, c.gas, c.nonce])).toEqual([
      [to(2), GAS_LIMIT, 0],
      [to(3), CONTRACT_GAS_LIMIT, 1],
      [to(4), GAS_LIMIT, 2],
    ]);
  });

  it('resyncs from the node after a failed broadcast', async () => {
    const { nonces, reads } = fakeNonces(5);
    const { broadcaster, failOnce } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    failOnce(new Error('rpc down'));
    await expect(sender.send(to(2), ONE_TENTH_MON, GAS_LIMIT)).rejects.toThrow('rpc down');

    // We cannot tell "rejected, nonce unused" from "accepted, response lost",
    // so the only safe move is to drop the local counter and re-read.
    const after = await sender.send(to(3), ONE_TENTH_MON, GAS_LIMIT);
    expect(reads()).toBe(2);
    expect(after.nonce).toBe(5);
  });

  it('does not let one failure poison the queue', async () => {
    const { nonces } = fakeNonces(0);
    const { broadcaster, failOnce } = fakeBroadcaster();
    const sender = new NonceManagedSender(to(1), nonces, broadcaster);

    failOnce(new Error('boom'));
    const settled = await Promise.allSettled([
      sender.send(to(2), ONE_TENTH_MON, GAS_LIMIT),
      sender.send(to(3), ONE_TENTH_MON, GAS_LIMIT),
      sender.send(to(4), ONE_TENTH_MON, GAS_LIMIT),
    ]);

    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
  });
});

describe('SenderPool', () => {
  const build = (keys: number) => {
    const senders = Array.from({ length: keys }, (_, i) => {
      const { nonces } = fakeNonces(0);
      const { broadcaster, calls } = fakeBroadcaster();
      return {
        sender: new NonceManagedSender(to(i + 1), nonces, broadcaster),
        calls,
      };
    });
    return { pool: new SenderPool(senders.map((s) => s.sender)), senders };
  };

  it('refuses when no keys are configured', async () => {
    const pool = new SenderPool([]);
    await expect(pool.send(to(2), ONE_TENTH_MON, GAS_LIMIT)).rejects.toBeInstanceOf(
      GasDripRefusedError,
    );
    await expect(pool.send(to(2), ONE_TENTH_MON, GAS_LIMIT)).rejects.toMatchObject({
      reason: 'faucet_unconfigured',
    });
  });

  it('round-robins across keys', async () => {
    const { pool } = build(3);
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await pool.send(to(i + 20), ONE_TENTH_MON, GAS_LIMIT));
    }
    expect(results.map((r) => r.sender)).toEqual([to(1), to(2), to(3), to(1), to(2), to(3)]);
  });

  it('forwards the per-send gas limit to whichever key it picks', async () => {
    const { pool, senders } = build(2);

    await pool.send(to(20), ONE_TENTH_MON, CONTRACT_GAS_LIMIT);
    await pool.send(to(21), ONE_TENTH_MON, GAS_LIMIT);

    expect(senders[0]?.calls.map((c) => c.gas)).toEqual([CONTRACT_GAS_LIMIT]);
    expect(senders[1]?.calls.map((c) => c.gas)).toEqual([GAS_LIMIT]);
  });

  it('spreads ten concurrent drips over three keys with no nonce collision', async () => {
    const { pool } = build(3);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => pool.send(to(i + 30), ONE_TENTH_MON, GAS_LIMIT)),
    );

    expect(results).toHaveLength(10);

    // The invariant that matters: (sender, nonce) is unique. A shared sequence
    // would hand the same nonce to several sends and they would replace each
    // other on chain.
    const pairs = results.map((r) => `${r.sender}:${r.nonce}`);
    expect(new Set(pairs).size).toBe(10);

    // And each key's own nonces are gapless from its starting point.
    for (const address of new Set(results.map((r) => r.sender))) {
      const mine = results
        .filter((r) => r.sender === address)
        .map((r) => r.nonce)
        .sort((a, b) => a - b);
      expect(mine).toEqual(mine.map((_, i) => i));
    }
  });
});
