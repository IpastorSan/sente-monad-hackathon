/**
 * The confirmation race. Plain node, no network — `sleep` is injected so the
 * whole file runs in microseconds rather than in real 300ms ticks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hash } from 'viem';

import {
  confirmationDelay,
  MONAD_BLOCK_MS,
  waitForUserOperation,
  type ConfirmationSources,
} from './confirmation.ts';

const HASH = '0xabc' as Hash;

/** Records every requested delay instead of waiting. */
const recordingSleep = () => {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

/** Answers `null` for `silentFor` calls, then the given result. */
const answersAfter = <T>(silentFor: number, value: T) => {
  let calls = 0;
  return () => Promise.resolve(calls++ < silentFor ? null : value);
};

test('the poll cadence is Monad block time, then backs off', () => {
  assert.equal(MONAD_BLOCK_MS, 300, 'Monad blocks, not Base flash blocks');
  assert.equal(confirmationDelay(0), 0, 'first check is immediate');
  assert.equal(confirmationDelay(1), 300);
  assert.equal(confirmationDelay(10), 300);
  assert.ok(confirmationDelay(11) > 300, 'backs off past ~3 seconds');
  assert.ok(confirmationDelay(50) >= confirmationDelay(11));
});

test('the bundler answer wins when both sources answer', async () => {
  const sources: ConfirmationSources = {
    bundler: () => Promise.resolve({ status: 'reverted', transactionHash: '0xtx' as Hash }),
    api: () => Promise.resolve({ status: 'included' }),
  };
  const result = await waitForUserOperation(HASH, sources, { sleep: () => Promise.resolve() });
  // The bundler reports the UserOperation's OWN success flag. Our status view
  // can only be as good as what it last polled, so on a tie the bundler wins —
  // otherwise a reverted operation inside a successful bundle reads as included.
  assert.equal(result.source, 'bundler');
  assert.equal(result.status, 'reverted');
  assert.equal(result.transactionHash, '0xtx');
});

test('our API settles the race when the bundler indexer is lagging', async () => {
  const result = await waitForUserOperation(
    HASH,
    {
      bundler: () => Promise.resolve(null),
      api: () => Promise.resolve({ status: 'included', transactionHash: '0xtx' as Hash }),
    },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(result.source, 'api');
  assert.equal(result.status, 'included');
});

test('a throwing source does not cancel the other one', async () => {
  const result = await waitForUserOperation(
    HASH,
    {
      bundler: () => Promise.reject(new Error('bundler down')),
      api: () => Promise.resolve({ status: 'included' }),
    },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(result.source, 'api');
  assert.equal(result.status, 'included');
});

test('runs with no bundler configured at all', async () => {
  const result = await waitForUserOperation(
    HASH,
    { api: answersAfter(3, { status: 'included' as const }) },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(result.source, 'api');
});

test('keeps polling while both sources say pending', async () => {
  const { delays, sleep } = recordingSleep();
  const result = await waitForUserOperation(
    HASH,
    {
      bundler: answersAfter(4, { status: 'included' as const, transactionHash: '0xtx' as Hash }),
      api: () => Promise.resolve({ status: 'pending' as const }),
    },
    { sleep },
  );
  assert.equal(result.status, 'included');
  assert.equal(result.source, 'bundler');
  // First tick is immediate, then one 300ms delay per retry.
  assert.deepEqual(delays, [300, 300, 300, 300]);
});

test('`unknown` from our API does not settle the race on its own', async () => {
  // A hash our API has no record of is not a verdict: the bundler may still
  // have it, and a restart wipes the in-memory status view.
  const result = await waitForUserOperation(
    HASH,
    {
      bundler: answersAfter(2, { status: 'included' as const }),
      api: () => Promise.resolve({ status: 'unknown' as const }),
    },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(result.status, 'included');
  assert.equal(result.source, 'bundler');
});

test('a timeout reports pending, never failed', async () => {
  // An operation that has not surfaced may still land minutes later. Calling it
  // failed would be a lie the UI would act on.
  const result = await waitForUserOperation(
    HASH,
    { api: () => Promise.resolve({ status: 'pending' }) },
    { timeoutMs: 1, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  assert.equal(result.status, 'pending');
  assert.equal(result.source, 'timeout');
});
