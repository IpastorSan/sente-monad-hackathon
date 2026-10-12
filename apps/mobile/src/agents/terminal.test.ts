/** The agent terminal's polling, merging and line formatting (SEN-178). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyFailure,
  applyPage,
  describeRun,
  EMPTY_VIEW,
  formatEntries,
  formatEntry,
  formatElapsed,
  formatWait,
  IDLE_POLL_MS,
  LIVE_POLL_MS,
  nextPollDelay,
  pollRun,
  refusalReason,
  runsPollDelay,
  type RunSummary,
  type RunTranscriptPage,
  type Scheduler,
  type TranscriptEntry,
  waitingFor,
} from './terminal.ts';

const RUN: RunSummary = {
  runId: 'run-1',
  agentId: 'agent-1',
  trigger: 'manual',
  model: 'moonshotai/kimi-k2.6',
  status: 'running',
  startedAt: 1_000,
  iterations: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastSeq: 0,
  droppedEntries: 0,
};

const note = (seq: number, text = `n${seq}`): TranscriptEntry => ({
  kind: 'note',
  text,
  seq,
  at: 1_000 + seq * 100,
});

const page = (entries: TranscriptEntry[], run: Partial<RunSummary> = {}): RunTranscriptPage => ({
  run: { ...RUN, ...run },
  entries,
  nextSeq: entries.at(-1)?.seq ?? 0,
});

test('applyPage merges by seq: overlap adds nothing twice, order holds, the cursor only moves forward', () => {
  let view = applyPage(EMPTY_VIEW, page([note(1), note(2)]));
  assert.equal(view.nextSeq, 2);
  view = applyPage(view, page([note(2), note(3)]));
  assert.deepEqual(
    view.entries.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(view.nextSeq, 3);
  // An empty page keeps the cursor where it was.
  view = applyPage(view, { ...page([]), nextSeq: 0 });
  assert.equal(view.nextSeq, 3);
  // Out of order arrivals are sorted in.
  view = applyPage(view, page([note(5), note(4)]));
  assert.deepEqual(
    view.entries.map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
});

test('nextPollDelay: live while running, stops once ended, gone or interrupted, backs off on failure', () => {
  assert.equal(nextPollDelay(EMPTY_VIEW), LIVE_POLL_MS);
  const live = applyPage(EMPTY_VIEW, page([note(1)]));
  assert.equal(nextPollDelay(live), LIVE_POLL_MS);
  assert.equal(nextPollDelay(applyPage(live, page([], { status: 'ended' }))), null);
  assert.equal(nextPollDelay(applyPage(live, page([], { status: 'interrupted' }))), null);
  const failed = applyFailure(live, 'offline');
  assert.equal(nextPollDelay(failed), LIVE_POLL_MS * 2);
  assert.equal(nextPollDelay(applyFailure(failed, 'offline')), LIVE_POLL_MS * 4);
  assert.equal(nextPollDelay(applyFailure(live, 'gone', true)), null);
  // A good poll clears the failure and the backoff.
  assert.equal(nextPollDelay(applyPage(failed, page([note(2)]))), LIVE_POLL_MS);
});

test('runsPollDelay: fast while any run is live, slow otherwise', () => {
  assert.equal(runsPollDelay([{ ...RUN, status: 'running' }], 0), LIVE_POLL_MS);
  assert.equal(runsPollDelay([{ ...RUN, status: 'ended' }], 0), IDLE_POLL_MS);
  assert.equal(runsPollDelay(null, 0), IDLE_POLL_MS);
  assert.ok(runsPollDelay(null, 2) > IDLE_POLL_MS);
});

/** A scheduler the test steps by hand. */
function manualScheduler() {
  const queue: { fn: () => void; ms: number }[] = [];
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    clearTimeout: () => {
      queue.length = 0;
    },
  };
  return { scheduler, queue };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('pollRun reads with the cursor, polls while live, and stops when the run ends', async () => {
  const { scheduler, queue } = manualScheduler();
  const asked: number[] = [];
  const pages = [
    page([note(1), note(2)]),
    page([]),
    page([note(3)], { status: 'ended', stopReason: 'end_turn' }),
  ];
  const views: number[][] = [];
  pollRun({
    scheduler,
    fetchPage: (after) => {
      asked.push(after);
      return Promise.resolve(pages.shift()!);
    },
    onView: (view) => views.push(view.entries.map((e) => e.seq)),
  });
  await settle();
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.ms, LIVE_POLL_MS);
  queue.shift()!.fn();
  await settle();
  queue.shift()!.fn();
  await settle();
  assert.deepEqual(asked, [0, 2, 2]);
  assert.deepEqual(views.at(-1), [1, 2, 3]);
  assert.equal(queue.length, 0, 'an ended run is not polled again');
});

test('pollRun stops on stop(), and a 404 ends polling for good', async () => {
  const { scheduler, queue } = manualScheduler();
  let calls = 0;
  const stop = pollRun({
    scheduler,
    fetchPage: () => {
      calls += 1;
      return Promise.resolve(page([note(calls)]));
    },
    onView: () => {},
  });
  await settle();
  stop();
  assert.equal(queue.length, 0);

  const gone = manualScheduler();
  let last: { gone: boolean; error: string | null } | undefined;
  pollRun({
    scheduler: gone.scheduler,
    fetchPage: () => Promise.reject(new Error('run_not_found')),
    isGone: () => true,
    onView: (view) => {
      last = view;
    },
  });
  await settle();
  assert.equal(last?.gone, true);
  assert.equal(last?.error, 'run_not_found');
  assert.equal(gone.queue.length, 0);
});

test('formatEntry: each kind reads as its own line, refusals by layer, never as an error', () => {
  const at = { seq: 1, at: 0 };
  assert.deepEqual(
    formatEntry({
      ...at,
      kind: 'start',
      trigger: 'schedule',
      model: 'moonshotai/kimi-k2.6',
      instruction: 'Only MON',
      thinkingRequested: false,
    })[0],
    {
      key: '1',
      seq: 1,
      elapsed: '',
      tone: 'meta',
      glyph: '▸',
      text: 'Scheduled run started · Kimi K2.6',
      detail: '“Only MON”',
    },
  );
  const thinking = (visibility: 'visible' | 'omitted' | 'redacted', text?: string) =>
    formatEntry({
      ...at,
      kind: 'thinking',
      turn: 1,
      visibility,
      source: 'thinking',
      ...(text ? { text } : {}),
    })[0]!;
  assert.equal(thinking('visible', 'spread is wide').text, 'spread is wide');
  assert.equal(thinking('visible', 'spread is wide').tone, 'thinking');
  assert.match(thinking('omitted').text, /hidden by the provider/);
  assert.match(thinking('redacted').text, /redacted by the provider/);

  const call = formatEntry({
    ...at,
    kind: 'tool_call',
    turn: 1,
    toolUseId: 'tu',
    tool: 'place_limit',
    market: 'MON-USDC',
    input: 'venue=kuru market=MON-USDC side=buy size=10',
  })[0]!;
  assert.deepEqual(
    [call.tone, call.glyph, call.text, call.detail],
    ['call', '→', 'place_limit', 'venue=kuru market=MON-USDC side=buy size=10'],
  );

  const result = (status: 'ok' | 'refused' | 'error', layer?: 'sente' | 'enclave') =>
    formatEntry({
      ...at,
      kind: 'tool_result',
      tool: 'place_limit',
      status,
      ...(layer
        ? { layer, code: layer === 'sente' ? 'notional_over_cap' : 'policy_violation' }
        : {}),
      summary: 's',
    })[0]!;
  assert.equal(result('ok').tone, 'ok');
  assert.equal(
    result('refused', 'sente').text,
    'place_limit refused by the mandate check (notional_over_cap)',
  );
  assert.equal(result('refused', 'sente').tone, 'refused');
  assert.equal(
    result('refused', 'enclave').text,
    'place_limit refused by the enclave (policy_violation)',
  );
  assert.equal(result('error').tone, 'error');

  assert.equal(
    formatEntry({
      ...at,
      kind: 'usage',
      turn: 2,
      inputTokens: 12_345,
      outputTokens: 880,
      costUsd: 0.00123,
      stopReason: 'tool_use',
    })[0]!.text,
    'turn 2 · 12.3k in · 880 out · $0.0012',
  );
});

test('refusalReason drops the prefix the line head already says', () => {
  assert.equal(
    refusalReason('Refused by Sente mandate: notional_over_cap. 350 USDC is over the cap.'),
    '350 USDC is over the cap.',
  );
  assert.equal(
    refusalReason(
      'Refused by the Privy enclave (policy_violation): the signing key would not sign this',
    ),
    'the signing key would not sign this',
  );
  assert.equal(refusalReason('venue down'), 'venue down');
});

test('formatEntry: an end says how the run stopped, and when no reasoning came back', () => {
  const end = (thinkingTurns: number, error?: string) =>
    formatEntry({
      seq: 9,
      at: 0,
      kind: 'end',
      stopReason: error ? 'model_error' : 'end_turn',
      iterations: 3,
      toolCalls: 1,
      inputTokens: 900,
      outputTokens: 100,
      costUsd: 0.0035,
      durationMs: 12_400,
      thinkingTurns,
      ...(error ? { error } : {}),
    });
  const [line, quiet] = end(0);
  assert.equal(line!.text, 'Run finished · 3 turns · 1 tool call · 1,000 tokens · $0.0035 · 12.4s');
  assert.equal(line!.tone, 'end');
  assert.equal(quiet!.text, 'The model returned no reasoning on this run.');
  assert.equal(end(2).length, 1);
  const [failed] = end(0, 'APIError: 400');
  assert.equal(failed!.tone, 'error');
  assert.equal(failed!.detail, 'APIError: 400');
});

test('formatEntries marks each new turn once and stamps the elapsed gutter', () => {
  const entries: TranscriptEntry[] = [
    { seq: 1, at: 1_000, kind: 'note', text: 'snapshot' },
    { seq: 2, at: 2_500, kind: 'text', turn: 1, text: 'hi' },
    {
      seq: 3,
      at: 2_600,
      kind: 'usage',
      turn: 1,
      inputTokens: 1,
      outputTokens: 1,
      stopReason: null,
    },
    {
      seq: 4,
      at: 2_700,
      kind: 'tool_result',
      tool: 'get_balances',
      status: 'ok',
      summary: '[]',
    },
    { seq: 5, at: 75_000, kind: 'text', turn: 2, text: 'again' },
  ];
  const lines = formatEntries(entries, 1_000);
  assert.deepEqual(
    lines.map((l) => l.turnStart),
    [undefined, 1, undefined, undefined, 2],
  );
  assert.deepEqual(
    lines.map((l) => l.elapsed),
    ['+0.0s', '+1.5s', '+1.6s', '+1.7s', '+1m14s'],
  );
  assert.equal(formatElapsed(59_940), '+59.9s');
});

test('describeRun: a row for the history list', () => {
  const row = describeRun(
    {
      ...RUN,
      status: 'ended',
      stopReason: 'max_iterations',
      iterations: 12,
      toolCalls: 1,
      costUsd: 0.02,
    },
    1_000 + 3 * 60_000,
  );
  assert.deepEqual(row, {
    title: 'Manual run · 3m ago',
    caption: 'hit the turn limit · 12 turns · 1 call · $0.020',
    live: false,
  });
  assert.equal(
    describeRun({ ...RUN, status: 'interrupted' }, 1_000).caption.split(' · ')[0],
    'cut off by a server restart',
  );
  assert.equal(describeRun(RUN, 1_000).live, true);
});

// ─── Waiting (SEN-198) ─────────────────────────────────────────────────────

const at = (seq: number) => 1_000 + seq * 100;
const start: TranscriptEntry = {
  kind: 'start',
  trigger: 'manual',
  model: RUN.model,
  thinkingRequested: false,
  seq: 1,
  at: at(1),
};
const call = (seq: number, tool: string, id = `tu-${seq}`): TranscriptEntry => ({
  kind: 'tool_call',
  turn: 1,
  toolUseId: id,
  tool,
  input: '{}',
  seq,
  at: at(seq),
});
const usage = (seq: number, stopReason = 'tool_use'): TranscriptEntry => ({
  kind: 'usage',
  turn: 1,
  inputTokens: 10,
  outputTokens: 5,
  stopReason,
  seq,
  at: at(seq),
});
const result = (seq: number, tool: string, id?: string): TranscriptEntry => ({
  kind: 'tool_result',
  tool,
  ...(id ? { toolUseId: id } : {}),
  status: 'ok',
  summary: 'ok',
  seq,
  at: at(seq),
});
const waiting = (entries: TranscriptEntry[], run: Partial<RunSummary> = {}) =>
  waitingFor({ run: { ...RUN, ...run }, entries });

test('the model is thinking after the snapshot, and after its tools answer', () => {
  assert.deepEqual(waiting([start]), {
    kind: 'thinking',
    label: 'Kimi K2.6 is thinking',
    since: at(1),
  });
  const snapshot = note(2, 'Snapshot sent: balances and open orders (no market books)');
  assert.deepEqual(waiting([start, snapshot]), {
    kind: 'thinking',
    label: 'Kimi K2.6 is thinking',
    since: at(2),
  });
  const answered = [
    start,
    snapshot,
    call(3, 'get_depth', 'a'),
    usage(4),
    result(5, 'get_depth', 'a'),
  ];
  assert.equal(waiting(answered)?.kind, 'thinking');
  assert.equal(waiting(answered)?.since, at(5));
});

test('between a turn and its results, the tools are what runs', () => {
  const turn = [start, call(2, 'get_depth', 'a'), call(3, 'get_balances', 'b'), usage(4)];
  assert.deepEqual(waiting(turn), {
    kind: 'tool',
    label: 'Running get_depth, get_balances',
    since: at(4),
  });
  assert.deepEqual(waiting([...turn, result(5, 'get_depth', 'a')])?.label, 'Running get_balances');
  // A result with no id still counts against the calls, oldest first.
  assert.deepEqual(waiting([...turn, result(5, 'get_depth')])?.label, 'Running get_balances');
});

test('no waiting line once the run ends, when it is not live, or mid-write', () => {
  const end: TranscriptEntry = {
    kind: 'end',
    stopReason: 'end_turn',
    iterations: 1,
    toolCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 30_000,
    thinkingTurns: 0,
    seq: 3,
    at: at(3),
  };
  assert.equal(waiting([start, end]), null);
  assert.equal(waiting([start], { status: 'ended' }), null);
  assert.equal(waiting([start], { status: 'interrupted' }), null);
  assert.equal(waiting([]), null);
  assert.equal(waitingFor({ run: null, entries: [start] }), null);
  // A turn that ended without calls: the end entry is next, not another wait.
  assert.equal(waiting([start, usage(2, 'end_turn')]), null);
});

test('formatWait counts whole seconds and never goes negative', () => {
  assert.equal(formatWait(-2_000), '0s');
  assert.equal(formatWait(12_900), '12s');
  assert.equal(formatWait(65_000), '1m05s');
});
