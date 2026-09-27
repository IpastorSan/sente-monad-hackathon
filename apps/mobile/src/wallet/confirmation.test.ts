/**
 * The confirmation race. Plain node, no network — `sleep` is injected so the
 * whole file runs in microseconds rather than in real 300ms ticks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hash } from 'viem';

import { WalletApi } from './api.ts';
import {
  confirmationDelay,
  MONAD_BLOCK_MS,
  readApiStatus,
  readBundlerReceipt,
  waitForUserOperation,
  type BundlerReceiptReader,
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

test('`unknown` from the bundler does not settle the race either', async () => {
  // SEN-127: `unknown` is "no record", never a verdict, from EITHER source. The
  // bundler branch used to settle on anything but `pending`.
  let calls = 0;
  const result = await waitForUserOperation(
    HASH,
    {
      bundler: () =>
        Promise.resolve({ status: calls++ < 2 ? ('unknown' as const) : ('included' as const) }),
      api: () => Promise.resolve(null),
    },
    { sleep: () => Promise.resolve() },
  );
  assert.equal(result.status, 'included');
  assert.equal(result.source, 'bundler');
});

// ---------------------------------------------------------------------------
// The two raw-answer mappings (SEN-127). These are the only places the phone
// decides `included` vs `reverted`; everything else passes their answer on.
// ---------------------------------------------------------------------------

const TX = `0x${'cd'.repeat(32)}` as Hash;

/** A bundler whose `getUserOperationReceipt` answers (or throws) as given. */
const bundlerAnswering = (answer: () => Promise<unknown>): BundlerReceiptReader =>
  ({ getUserOperationReceipt: answer }) as unknown as BundlerReceiptReader;

/** The receipt viem returns, with the two flags that can disagree set apart. */
const receipt = (success: boolean, transactionStatus: 'success' | 'reverted') => ({
  success,
  actualGasCost: 1234n,
  receipt: { transactionHash: TX, blockNumber: 42n, status: transactionStatus },
});

test('a failed user operation inside a successful bundle reads as reverted', async () => {
  // Gotcha 8, observed on Monad testnet: `success: false` inside a bundle whose
  // transaction status is `success`. Reading the transaction's flag instead
  // would tell the user a transfer landed when nothing moved.
  const answer = await readBundlerReceipt(
    bundlerAnswering(() => Promise.resolve(receipt(false, 'success'))),
    HASH,
  );
  assert.deepEqual(answer, {
    status: 'reverted',
    transactionHash: TX,
    blockNumber: 42n,
    actualGasCost: 1234n,
  });
});

test('a successful user operation reads as included, with its transaction', async () => {
  const answer = await readBundlerReceipt(
    bundlerAnswering(() => Promise.resolve(receipt(true, 'success'))),
    HASH,
  );
  assert.equal(answer?.status, 'included');
  assert.equal(answer?.transactionHash, TX);
});

test('a bundler that throws is no answer yet, not a failure', async () => {
  // viem throws `UserOperationReceiptNotFoundError` for as long as the
  // operation sits in the mempool; a transport error looks the same here.
  const answer = await readBundlerReceipt(
    bundlerAnswering(() => Promise.reject(new Error('User Operation receipt not found'))),
    HASH,
  );
  assert.equal(answer, null);
});

/** A real `WalletApi` over a fetch that answers the status route as given. */
const apiAnswering = (answer: () => Promise<Response>) =>
  new WalletApi({
    auth: { token: () => 'token', refresh: () => Promise.resolve('token') },
    baseUrl: 'http://api.test',
    fetchImpl: () => answer(),
  });

test('our API maps its status body, amounts as bigints', async () => {
  const answer = await readApiStatus(
    apiAnswering(() =>
      Promise.resolve(
        Response.json({
          userOpHash: HASH,
          status: 'reverted',
          transactionHash: TX,
          blockNumber: '42',
          actualGasCost: '1234',
        }),
      ),
    ),
    HASH,
  );
  assert.deepEqual(answer, {
    status: 'reverted',
    transactionHash: TX,
    blockNumber: 42n,
    actualGasCost: 1234n,
  });
});

test('a 404 from our API is `unknown`, never a verdict', async () => {
  // The status view is in memory: an API restart mid-poll answers 404 for an
  // operation that may land a block later. Reporting that as failed would
  // invite the user to send the money twice.
  const answer = await readApiStatus(
    apiAnswering(() => Promise.resolve(Response.json({ message: 'not found' }, { status: 404 }))),
    HASH,
  );
  assert.deepEqual(answer, { status: 'unknown' });
});

test('a 5xx or a dropped connection from our API is no answer at all', async () => {
  const answers: [string, () => Promise<Response>][] = [
    ['500', () => Promise.resolve(Response.json({ message: 'boom' }, { status: 500 }))],
    ['502 with an HTML body', () => Promise.resolve(new Response('<html>', { status: 502 }))],
    ['network', () => Promise.reject(new TypeError('Network request failed'))],
  ];
  for (const [label, answer] of answers) {
    assert.equal(await readApiStatus(apiAnswering(answer), HASH), null, label);
  }
});
