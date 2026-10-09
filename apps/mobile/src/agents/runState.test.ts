/**
 * Run state before the 409 (SEN-177): what the header says while a run is
 * open, how the refusal is worded, and when a Run now counts as started.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alreadyRunning, liveRun, runningLine, waitForRunStart } from './runState.ts';
import type { RunSummary } from './terminal.ts';

const NOW = 1_789_000_000_000;

function run(patch: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-1',
    agentId: 'a-1',
    trigger: 'manual',
    model: 'm',
    status: 'running',
    startedAt: NOW - 12_000,
    iterations: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastSeq: 0,
    droppedEntries: 0,
    ...patch,
  };
}

test('liveRun finds the open run, and nothing once it ended', () => {
  assert.equal(liveRun(null), null);
  assert.equal(liveRun([run({ status: 'ended' })]), null);
  assert.equal(liveRun([run({ runId: 'b', status: 'ended' }), run()])?.runId, 'run-1');
});

test('runningLine says when it started and how far it got', () => {
  assert.equal(runningLine(run(), NOW), 'Started 12 s ago');
  assert.equal(
    runningLine(run({ iterations: 2, toolCalls: 1, trigger: 'schedule' }), NOW),
    'Started 12 s ago on its schedule · 2 turns · 1 tool call',
  );
  assert.equal(runningLine(run({ startedAt: NOW - 185_000 }), NOW), 'Started 3m ago');
});

test('the 409 is worded with the name and the start, never an id', () => {
  assert.deepEqual(alreadyRunning('Crazy', run({ startedAt: NOW - 40_000 }), NOW), {
    title: 'Crazy is already running',
    detail: 'It started 40 s ago. You can ask again when it’s done.',
  });
  assert.equal(
    alreadyRunning('Crazy', null, NOW).detail,
    'One run at a time. You can ask again when it’s done.',
  );
});

/** A clock the fake sleep advances, so nothing waits for real. */
function clock() {
  let t = NOW;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test('a Run now counts as started once its run shows up as running', async () => {
  const c = clock();
  const answers: (RunSummary[] | null)[] = [
    [run({ status: 'ended', startedAt: NOW - 600_000 })],
    [run({ runId: 'new', startedAt: NOW + 500 })],
  ];
  const result = await waitForRunStart({
    since: NOW,
    settled: new Promise(() => undefined),
    runs: async () => answers.shift() ?? null,
    ...c,
  });
  assert.equal(result, 'started');
});

test('an older run still open does not count as this one starting', async () => {
  const c = clock();
  const result = await waitForRunStart({
    since: NOW,
    settled: new Promise(() => undefined),
    runs: async () => [run({ startedAt: NOW - 60_000 })],
    timeoutMs: 3_000,
    ...c,
  });
  assert.equal(result, 'timeout');
});

test('a request that settles first (a 409, a refusal) wins', async () => {
  const c = clock();
  const result = await waitForRunStart({
    since: NOW,
    settled: Promise.reject(new Error('run_in_progress')),
    runs: async () => [],
    ...c,
  });
  assert.equal(result, 'settled');
});
