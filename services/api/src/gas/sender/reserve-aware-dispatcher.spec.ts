import type { Address, Hash } from 'viem';

import { GasDripRefusedError } from '../gas.errors';
import type { DripSender } from './drip-sender';
import {
  DripUnconfirmedError,
  ReserveAwareDispatcher,
  ReserveBalanceBusyError,
  type ReceiptWaiter,
  type TransferSimulator,
} from './reserve-aware-dispatcher';
import { SenderPool } from './sender-pool';

const GAS_LIMIT = 21_000n;
const AMOUNT = 150_000_000_000_000_000n;
const SPACING_MS = 5_000;
/** How long each fake receipt takes to arrive. */
const RECEIPT_MS = 1_000;

const to = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;
const RECIPIENT = to(0xa1);

/** A clock `sleep` moves forward instantly, so spacing is tested without real waits. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

function fakeSender(n: number, clock: Clock) {
  const sends: { at: number; hash: Hash }[] = [];
  let nonce = 0;
  let failNext: Error | undefined;
  const sender: DripSender = {
    address: to(n),
    send: () => {
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        return Promise.reject(error);
      }
      const hash =
        `0x${n.toString(16).padStart(2, '0')}${nonce.toString(16).padStart(62, '0')}` as Hash;
      sends.push({ at: clock.now(), hash });
      return Promise.resolve({ hash, nonce: nonce++, sender: to(n) });
    },
  };
  return {
    sender,
    sends,
    failOnce: (error: Error) => {
      failNext = error;
    },
  };
}

type ReceiptStep = 'success' | 'reverted' | Error | 'hang';

function setup(
  keys: number,
  opts: {
    receipts?: ReceiptStep[];
    simulate?: (from: Address) => Error | undefined;
  } = {},
) {
  const clock = fakeClock();
  const senders = Array.from({ length: keys }, (_, i) => fakeSender(i + 1, clock));
  const pool = new SenderPool(
    senders.map((s) => s.sender),
    clock.now,
  );
  const steps = [...(opts.receipts ?? [])];
  const receiptAt: number[] = [];
  const receipts: ReceiptWaiter = {
    waitForReceipt: () => {
      const step = steps.shift() ?? 'success';
      if (step === 'hang') return new Promise(() => undefined);
      clock.advance(RECEIPT_MS);
      receiptAt.push(clock.now());
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  const simulated: Address[] = [];
  const simulator: TransferSimulator = {
    simulateTransfer: ({ from }) => {
      simulated.push(from);
      const error = opts.simulate?.(from);
      return error ? Promise.reject(error) : Promise.resolve();
    },
  };
  const warnings: string[] = [];
  const dispatcher = new ReserveAwareDispatcher(pool, simulator, receipts, {
    spacingMs: SPACING_MS,
    receiptTimeoutMs: 15_000,
    now: clock.now,
    sleep: clock.sleep,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { dispatcher, pool, clock, senders, simulated, receiptAt, warnings };
}

describe('ReserveAwareDispatcher', () => {
  describe('spacing sends per key', () => {
    it('sends through a free key, simulated first, and returns once the receipt is in', async () => {
      const { dispatcher, senders, simulated } = setup(1);

      const sent = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(sent).toMatchObject({ sender: to(1), nonce: 0, reverted: [] });
      expect(simulated).toEqual([to(1)]);
      expect(senders[0]?.sends).toHaveLength(1);
    });

    it('moves to another key instead of sending twice from one inside its window', async () => {
      const { dispatcher, clock } = setup(2);
      const start = clock.now();

      const first = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);
      const second = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect([first.sender, second.sender]).toEqual([to(1), to(2)]);
      // No waiting: only the two receipts took time.
      expect(clock.now() - start).toBe(2 * RECEIPT_MS);
    });

    it('with one key, waits out the spacing counted from the previous receipt', async () => {
      const { dispatcher, senders, receiptAt } = setup(1);

      await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);
      await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      const sends = senders[0]!.sends;
      expect(sends).toHaveLength(2);
      expect(sends[1]!.at).toBeGreaterThanOrEqual(receiptAt[0]! + SPACING_MS);
    });

    it('never hands one key to two concurrent sends', async () => {
      const { dispatcher, senders, receiptAt } = setup(1);

      const results = await Promise.all([
        dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT),
        dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT),
      ]);

      expect(results.map((r) => r.nonce)).toEqual([0, 1]);
      // The second one broadcast only after the first's receipt plus the spacing.
      expect(senders[0]!.sends[1]!.at).toBeGreaterThanOrEqual(receiptAt[0]! + SPACING_MS);
    });

    it('stays clear of a key that has just sent outside the dispatcher', async () => {
      const { dispatcher, pool } = setup(2);

      await pool.send(to(0xb0), AMOUNT, GAS_LIMIT); // the bare SenderPool.send takes key 1

      expect((await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).sender).toBe(to(2));
    });

    it('gives up when no key frees up in time', async () => {
      const { dispatcher } = setup(1, { receipts: ['hang'] });

      void dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT); // holds the only key forever

      await expect(dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).rejects.toBeInstanceOf(
        ReserveBalanceBusyError,
      );
    });
  });

  describe('the reserve-balance revert', () => {
    it('retries a reverted send on another key, and reports the reverted hash', async () => {
      const { dispatcher, senders, warnings } = setup(2, { receipts: ['reverted', 'success'] });

      const sent = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(sent.sender).toBe(to(2));
      expect(sent.reverted).toEqual([senders[0]!.sends[0]!.hash]);
      expect(warnings.join('\n')).toMatch(/reverted .*reserve-balance/);
    });

    it('with one key, retries it only after its window has passed', async () => {
      const { dispatcher, senders, receiptAt } = setup(1, { receipts: ['reverted', 'success'] });

      const sent = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(sent.reverted).toHaveLength(1);
      expect(senders[0]!.sends[1]!.at).toBeGreaterThanOrEqual(receiptAt[0]! + SPACING_MS);
    });

    it('does not broadcast from a key whose simulation reports a reserve-balance violation', async () => {
      const { dispatcher, senders } = setup(2, {
        simulate: (from) =>
          from === to(1) ? new Error('execution reverted: reserve balance violation') : undefined,
      });

      const sent = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(sent).toMatchObject({ sender: to(2), reverted: [] });
      expect(senders[0]!.sends).toHaveLength(0);
    });

    it('recognises the violation in viem’s nested error details', async () => {
      const nested = Object.assign(new Error('Execution reverted for an unknown reason.'), {
        details: 'reserve balance violation',
      });
      const { dispatcher, senders } = setup(2, {
        simulate: (from) => (from === to(1) ? nested : undefined),
      });

      await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(senders[0]!.sends).toHaveLength(0);
    });

    it('ignores any other simulation failure and lets the receipt decide', async () => {
      const { dispatcher, senders, warnings } = setup(1, {
        simulate: () => new Error('HTTP request failed'),
      });

      const sent = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT);

      expect(sent.sender).toBe(to(1));
      expect(senders[0]!.sends).toHaveLength(1);
      expect(warnings.join('\n')).toMatch(/sending anyway/);
    });

    it('gives up after three reverted sends, reporting every hash', async () => {
      const { dispatcher, senders } = setup(2, {
        receipts: ['reverted', 'reverted', 'reverted'],
      });

      const error: unknown = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT).catch((e) => e);

      expect(error).toBeInstanceOf(ReserveBalanceBusyError);
      expect((error as ReserveBalanceBusyError).reverted).toHaveLength(3);
      expect(senders.flatMap((s) => s.sends)).toHaveLength(3);
    });
  });

  describe('failures that are not retried', () => {
    it('does not re-send when the receipt never comes, and frees the key', async () => {
      const { dispatcher, senders } = setup(1, { receipts: [new Error('timed out')] });

      const error: unknown = await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT).catch((e) => e);

      expect(error).toBeInstanceOf(DripUnconfirmedError);
      expect((error as DripUnconfirmedError).sent.hash).toBe(senders[0]!.sends[0]!.hash);
      expect(senders[0]!.sends).toHaveLength(1);
      // The key is usable again, after its spacing.
      expect((await dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).nonce).toBe(1);
    });

    it('does not retry a failed broadcast on another key', async () => {
      const { dispatcher, senders } = setup(2);
      senders[0]!.failOnce(new Error('insufficient funds'));

      await expect(dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).rejects.toThrow(
        'insufficient funds',
      );
      expect(senders[1]!.sends).toHaveLength(0);
    });

    it('refuses when no keys are configured', async () => {
      const { dispatcher } = setup(0);
      await expect(dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).rejects.toMatchObject({
        reason: 'faucet_unconfigured',
      });
      await expect(dispatcher.send(RECIPIENT, AMOUNT, GAS_LIMIT)).rejects.toBeInstanceOf(
        GasDripRefusedError,
      );
    });
  });
});
