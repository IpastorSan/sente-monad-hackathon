import { getAddress, type Hash } from 'viem';
import type { UserOperationReceipt } from 'viem/account-abstraction';

import type { Bundler } from '../bundler/bundler';
import { PollingOperationTracker } from './operation-tracker';
import type { UserOperationOutcome } from './user-operation-logs';

const USER_OP_HASH = `0x${'11'.repeat(32)}` as Hash;
const SENDER = getAddress(`0x${'22'.repeat(20)}`);
const TX = `0x${'33'.repeat(32)}` as Hash;

/** A bundler that answers `receipt` and nothing else — the only method used. */
function bundler(receipt: UserOperationReceipt | null | (() => never)): Bundler {
  return {
    name: 'fake',
    receipt: () =>
      typeof receipt === 'function'
        ? Promise.reject(new Error('bundler down'))
        : Promise.resolve(receipt),
  } as unknown as Bundler;
}

function bundlerReceipt(success: boolean): UserOperationReceipt {
  return {
    success,
    actualGasCost: 7n,
    receipt: { transactionHash: TX, blockNumber: 99n },
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

/** Waits for the tracker to leave `pending`, or gives up. */
async function settled(tracker: PollingOperationTracker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = tracker.status(USER_OP_HASH)?.status;
    if (status !== undefined && status !== 'pending') return tracker.status(USER_OP_HASH);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return tracker.status(USER_OP_HASH);
}

const track = (tracker: PollingOperationTracker) =>
  tracker.track({ userOpHash: USER_OP_HASH, sender: SENDER, sponsored: true });

describe('PollingOperationTracker', () => {
  it('settles from the bundler, on the OPERATION’s own success flag', async () => {
    const tracker = new PollingOperationTracker(bundler(bundlerReceipt(true)), {
      pollMs: 1,
      timeoutMs: 500,
    });
    track(tracker);

    expect(await settled(tracker)).toMatchObject({
      status: 'included',
      transactionHash: TX,
      blockNumber: 99n,
      actualGasCost: 7n,
    });
    tracker.onModuleDestroy();
  });

  it('calls a reverted operation reverted, however the transaction went', async () => {
    const tracker = new PollingOperationTracker(bundler(bundlerReceipt(false)), {
      pollMs: 1,
      timeoutMs: 500,
    });
    track(tracker);

    expect(await settled(tracker)).toMatchObject({ status: 'reverted', transactionHash: TX });
    tracker.onModuleDestroy();
  });

  it('falls back to the chain when the bundler has nothing (SEN-42)', async () => {
    // A Privy-sponsored send is bundled by somebody else's bundler, so ours can
    // legitimately know nothing about an operation that has landed.
    const asked: Hash[] = [];
    const tracker = new PollingOperationTracker(bundler(null), {
      pollMs: 1,
      timeoutMs: 500,
      chainReceipts: (hash) => {
        asked.push(hash);
        return Promise.resolve(chainOutcome(true));
      },
    });
    track(tracker);

    expect(await settled(tracker)).toMatchObject({
      status: 'included',
      transactionHash: TX,
      blockNumber: 101n,
    });
    expect(asked).toContain(USER_OP_HASH);
    tracker.onModuleDestroy();
  });

  it('does not ask the chain while the bundler is answering', async () => {
    let askedChain = 0;
    const tracker = new PollingOperationTracker(bundler(bundlerReceipt(true)), {
      pollMs: 1,
      timeoutMs: 500,
      chainReceipts: () => {
        askedChain += 1;
        return Promise.resolve(null);
      },
    });
    track(tracker);
    await settled(tracker);

    expect(askedChain).toBe(0);
    tracker.onModuleDestroy();
  });

  it('stays pending when neither source has it — "not yet" is not "failed"', async () => {
    const tracker = new PollingOperationTracker(bundler(null), {
      pollMs: 1,
      timeoutMs: 20,
      chainReceipts: () => Promise.resolve(null),
    });
    track(tracker);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(tracker.status(USER_OP_HASH)?.status).toBe('pending');
    tracker.onModuleDestroy();
  });
});
