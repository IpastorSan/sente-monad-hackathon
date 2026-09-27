import { getAddress, type Hash } from 'viem';
import type { UserOperationReceipt } from 'viem/account-abstraction';

import type { Bundler } from '../bundler/bundler';
import { type OperationTrackerOptions, PollingOperationTracker } from './operation-tracker';
import type { UserOperationOutcome } from './user-operation-logs';

const USER_OP_HASH = `0x${'11'.repeat(32)}` as Hash;
const SENDER = getAddress(`0x${'22'.repeat(20)}`);
const TX = `0x${'33'.repeat(32)}` as Hash;
const POLL_MS = 300;
const TIMEOUT_MS = 3_000;

/** One bundler answer: a receipt, "not yet", or a transport failure. */
type BundlerAnswer = UserOperationReceipt | null | Error;

/**
 * A bundler that answers `receipt` (the only method the tracker uses) from a
 * script, one entry per poll; the last entry repeats. Counts the calls so a
 * test can see how many poll loops are running.
 */
function scriptedBundler(...answers: BundlerAnswer[]) {
  let calls = 0;
  const fake = {
    name: 'fake',
    receipt: () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as Bundler;
  return { bundler: fake, calls: () => calls };
}

/**
 * Gotcha 8 as the bundler reports it: the carrying transaction's receipt says
 * `status: 'success'` whatever the operation did, and only the operation's own
 * `success` flag says whether it worked. Modelled on the observed Monad testnet
 * tx 0x164e7b1c…ea0 (CLAUDE.md gotcha 8).
 */
function bundlerReceipt(success: boolean): UserOperationReceipt {
  return {
    success,
    actualGasCost: 7n,
    receipt: { transactionHash: TX, blockNumber: 99n, status: 'success' },
  } as unknown as UserOperationReceipt;
}

function chainOutcome(success: boolean): UserOperationOutcome {
  return {
    userOpHash: USER_OP_HASH,
    success,
    sender: SENDER,
    paymaster: getAddress(`0x${'00'.repeat(20)}`),
    transactionHash: TX,
    blockNumber: 101n,
    actualGasCost: 0n,
    actualGasUsed: 133_989n,
  };
}

function tracker(bundler: Bundler, options: Partial<OperationTrackerOptions> = {}) {
  return new PollingOperationTracker(bundler, {
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    ...options,
  });
}

const track = (subject: PollingOperationTracker) =>
  subject.track({ userOpHash: USER_OP_HASH, sender: SENDER, sponsored: true });

/** Runs exactly `n` poll ticks, letting each tick's awaited reads settle. */
const polls = (n: number) => jest.advanceTimersByTimeAsync(POLL_MS * n);

describe('PollingOperationTracker', () => {
  let subject: PollingOperationTracker | undefined;

  beforeEach(() => {
    // SEN-126: fake timers, so no test depends on how fast the machine is and
    // no poll loop outlives its test.
    jest.useFakeTimers({ now: 1_800_000_000_000 });
  });

  afterEach(() => {
    subject?.onModuleDestroy();
    subject = undefined;
    jest.useRealTimers();
  });

  it('settles from the bundler, on the OPERATION’s own success flag', async () => {
    subject = tracker(scriptedBundler(bundlerReceipt(true)).bundler);
    track(subject);
    await polls(1);

    expect(subject.status(USER_OP_HASH)).toMatchObject({
      status: 'included',
      transactionHash: TX,
      blockNumber: 99n,
      actualGasCost: 7n,
    });
  });

  it('calls a reverted operation reverted although its bundle transaction succeeded (gotcha 8)', async () => {
    // SEN-126: the receipt carries `receipt.status: 'success'`, exactly as a real
    // bundle that carried a reverted operation does. Kills a tracker that reads
    // `success || receipt.status === 'success'`, or the transaction status alone.
    const receipt = bundlerReceipt(false);
    expect(receipt.receipt.status).toBe('success');
    subject = tracker(scriptedBundler(receipt).bundler);
    track(subject);
    await polls(1);

    expect(subject.status(USER_OP_HASH)).toMatchObject({ status: 'reverted', transactionHash: TX });
  });

  it('falls back to the chain when the bundler has nothing (SEN-42)', async () => {
    // A Privy-sponsored send is bundled by somebody else's bundler, so ours can
    // legitimately know nothing about an operation that has landed.
    const asked: Hash[] = [];
    subject = tracker(scriptedBundler(null).bundler, {
      chainReceipts: (hash) => {
        asked.push(hash);
        return Promise.resolve(chainOutcome(true));
      },
    });
    track(subject);
    await polls(1);

    expect(subject.status(USER_OP_HASH)).toMatchObject({
      status: 'included',
      transactionHash: TX,
      blockNumber: 101n,
    });
    expect(asked).toEqual([USER_OP_HASH]);
  });

  it('calls a reverted operation reverted when only the chain has it', async () => {
    // SEN-126: the EntryPoint emits UserOperationEvent for a reverted operation
    // too — the event being there means "included in a bundle", not "worked".
    // Kills a fallback that returns `included` whenever the event is found.
    subject = tracker(scriptedBundler(null).bundler, {
      chainReceipts: () => Promise.resolve(chainOutcome(false)),
    });
    track(subject);
    await polls(1);

    expect(subject.status(USER_OP_HASH)).toMatchObject({
      status: 'reverted',
      transactionHash: TX,
      blockNumber: 101n,
    });
  });

  it('does not ask the chain while the bundler is answering', async () => {
    let askedChain = 0;
    subject = tracker(scriptedBundler(bundlerReceipt(true)).bundler, {
      chainReceipts: () => {
        askedChain += 1;
        return Promise.resolve(null);
      },
    });
    track(subject);
    await polls(1);

    expect(subject.status(USER_OP_HASH)?.status).toBe('included');
    expect(askedChain).toBe(0);
  });

  it('treats a failing bundler as "not yet", never as a verdict, and settles once it answers', async () => {
    // SEN-126: a bundler outage says nothing about the operation. Kills a catch
    // that marks the operation reverted (or stops polling) on the first error.
    const bundler = scriptedBundler(
      new Error('bundler down'),
      new Error('bundler down'),
      bundlerReceipt(true),
    );
    subject = tracker(bundler.bundler);
    track(subject);
    const seen: (string | undefined)[] = [];

    for (let tick = 0; tick < 3; tick += 1) {
      await polls(1);
      seen.push(subject.status(USER_OP_HASH)?.status);
    }

    expect(seen).toEqual(['pending', 'pending', 'included']);
    expect(bundler.calls()).toBe(3);
  });

  it('stays pending when neither source has it — "not yet" is not "failed"', async () => {
    const bundler = scriptedBundler(null);
    subject = tracker(bundler.bundler, { chainReceipts: () => Promise.resolve(null) });
    track(subject);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 2);

    expect(subject.status(USER_OP_HASH)?.status).toBe('pending');
    // And it did give up: no poll after the deadline.
    const callsAtDeadline = bundler.calls();
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(bundler.calls()).toBe(callsAtDeadline);
  });

  it('ignores a second track() of the same hash while it is pending', async () => {
    // SEN-126: `track` is called on every submit path and may be called twice
    // for one hash. Kills a `track` without the idempotency guard, which would
    // start a second poll loop (two bundler reads per tick) and reset the record.
    const bundler = scriptedBundler(null);
    subject = tracker(bundler.bundler);
    track(subject);
    const first = subject.status(USER_OP_HASH);
    await jest.advanceTimersByTimeAsync(POLL_MS / 2);
    subject.track({
      userOpHash: USER_OP_HASH.toUpperCase() as Hash,
      sender: SENDER,
      sponsored: false,
    });

    await polls(4);

    expect(bundler.calls()).toBe(4);
    expect(subject.status(USER_OP_HASH)).toBe(first);
    expect(subject.status(USER_OP_HASH)).toMatchObject({ sponsored: true });
  });

  it('keeps a settled verdict when the hash is tracked again', async () => {
    // SEN-126: re-tracking after settlement must not reset it to `pending`.
    const bundler = scriptedBundler(bundlerReceipt(false));
    subject = tracker(bundler.bundler);
    track(subject);
    await polls(1);
    expect(subject.status(USER_OP_HASH)?.status).toBe('reverted');

    track(subject);
    await polls(3);

    expect(subject.status(USER_OP_HASH)?.status).toBe('reverted');
    expect(bundler.calls()).toBe(1);
  });
});
