import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';

import { FileRunTranscriptStore } from './file-run-transcript-store';
import {
  entriesOfTurn,
  MAX_SUMMARY,
  MAX_TEXT,
  MAX_THINKING,
  redact,
  startInstruction,
  summariseInput,
  summariseOutcome,
} from './run-transcript';
import { InMemoryRunTranscriptStore, TRANSCRIPT_FULL_NOTE } from './run-transcript-store';

const quiet = { warn: () => {}, error: () => {} };

function message(content: unknown[], extra: Record<string, unknown> = {}): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.0001 },
    ...extra,
  } as unknown as BetaMessage;
}

const START = {
  runId: 'run-1',
  agentId: 'agent-1',
  trigger: 'manual' as const,
  model: 'moonshotai/kimi-k2.6',
  startedAt: 1_000,
};

describe('entriesOfTurn', () => {
  it('records Kimi-style thinking blocks, an omitted one, and a loose `reasoning` field', () => {
    const entries = entriesOfTurn(
      message(
        [
          { type: 'thinking', thinking: '  weighing the spread ', signature: '' },
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'reasoning', reasoning: 'chat-style block' },
          { type: 'text', text: '   ' },
        ],
        { reasoning: 'top-level reasoning' },
      ),
      3,
    );
    expect(entries).toEqual([
      {
        kind: 'thinking',
        turn: 3,
        visibility: 'visible',
        source: 'reasoning',
        text: 'top-level reasoning',
      },
      {
        kind: 'thinking',
        turn: 3,
        visibility: 'visible',
        source: 'thinking',
        text: 'weighing the spread',
      },
      { kind: 'thinking', turn: 3, visibility: 'omitted', source: 'thinking' },
      {
        kind: 'thinking',
        turn: 3,
        visibility: 'visible',
        source: 'reasoning',
        text: 'chat-style block',
      },
      {
        kind: 'usage',
        turn: 3,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.0001,
        stopReason: 'end_turn',
      },
    ]);
  });

  it('truncates long text and thinking, and says so', () => {
    const [thinking, said] = entriesOfTurn(
      message([
        { type: 'thinking', thinking: 'x'.repeat(MAX_THINKING + 50), signature: '' },
        { type: 'text', text: 'y'.repeat(MAX_TEXT + 50) },
      ]),
      1,
    );
    expect(thinking).toMatchObject({ truncated: true });
    expect((thinking as { text: string }).text).toHaveLength(MAX_THINKING + 1);
    expect(said).toMatchObject({ kind: 'text', truncated: true });
    expect((said as { text: string }).text).toHaveLength(MAX_TEXT + 1);
  });

  it('summarises a tool call by its trading fields, with the market lifted out', () => {
    const [call] = entriesOfTurn(
      message([
        {
          type: 'tool_use',
          id: 'tu_9',
          name: 'place_limit',
          input: {
            price: '3.5',
            size: '10',
            side: 'buy',
            market: 'MON-USDC',
            venue: 'kuru',
            timeInForce: 'GTC',
          },
        },
      ]),
      2,
    );
    expect(call).toEqual({
      kind: 'tool_call',
      turn: 2,
      toolUseId: 'tu_9',
      tool: 'place_limit',
      market: 'MON-USDC',
      input: 'venue=kuru market=MON-USDC side=buy size=10 price=3.5 timeInForce=GTC',
    });
  });
});

describe('redaction', () => {
  const KEY = 'sk-or-v1-0123456789abcdef';

  it('removes the run key, key shapes, bearer tokens and MCP tokens', () => {
    const out = redact(
      `k=${KEY} other=sk-ant-api03-zzz auth: Bearer eyJhbGciOi.x.y mcp=sente_mcp_AbC-123 custom=hunter2-long-secret`,
      ['hunter2-long-secret'],
    );
    expect(out).not.toMatch(/0123456789abcdef|zzz|eyJhbGciOi|AbC-123|hunter2/);
  });

  it('masks secret-named keys in tool inputs and results', () => {
    expect(summariseInput({ market: 'MON-USDC', apiKey: 'abc', nested: { token: 't' } })).toBe(
      'market=MON-USDC apiKey=[redacted] nested={"token":"[redacted]"}',
    );
    const { summary } = summariseOutcome({ ok: true, result: { authorization: 'Bearer z', n: 1 } });
    expect(summary).not.toContain('Bearer z');
  });

  it('caps a summary and an instruction', () => {
    expect(
      summariseInput({ thesis: 'z'.repeat(1_000), a: 'b'.repeat(500), c: 'c'.repeat(500) }).length,
    ).toBeLessThanOrEqual(MAX_SUMMARY + 1);
    expect(startInstruction('  ', [])).toBeUndefined();
    expect(startInstruction(`use ${KEY}`, [KEY])).toBe('use [redacted]');
  });
});

describe('summariseOutcome', () => {
  it('names the layer of a refusal and reads an order result by its fields', () => {
    expect(
      summariseOutcome({
        ok: false,
        message: 'Refused by the Privy enclave (policy_violation)',
        refusal: { layer: 'enclave', code: 'policy_violation' },
      }),
    ).toMatchObject({ status: 'refused', layer: 'enclave', code: 'policy_violation' });
    expect(summariseOutcome({ ok: false, message: 'venue down' })).toEqual({
      status: 'error',
      summary: 'venue down',
    });
    expect(
      summariseOutcome({
        ok: true,
        result: {
          id: 'o1',
          status: 'filled',
          symbol: 'MON-USDC',
          side: 'buy',
          filledSize: '10',
          extra: [1, 2],
        },
      }).summary,
    ).toBe('status=filled symbol=MON-USDC side=buy filledSize=10');
    expect(summariseOutcome({ ok: true, result: [1, 2, 3] }).summary).toBe('3 items: [1,2,3]');
  });
});

describe('InMemoryRunTranscriptStore', () => {
  it('caps a run: one note when full, usage still counted, the end always kept', () => {
    const store = new InMemoryRunTranscriptStore(10, 6);
    store.start(START);
    for (let i = 0; i < 6; i++) {
      store.append('run-1', {
        kind: 'usage',
        turn: i + 1,
        inputTokens: 1,
        outputTokens: 1,
        stopReason: null,
      });
    }
    store.append('run-1', {
      kind: 'end',
      stopReason: 'end_turn',
      iterations: 6,
      toolCalls: 0,
      inputTokens: 6,
      outputTokens: 6,
      durationMs: 5,
      thinkingTurns: 0,
    });
    const page = store.read('agent-1', 'run-1')!;
    expect(page.entries.map((e) => e.kind)).toEqual([
      'usage',
      'usage',
      'usage',
      'usage',
      'note',
      'end',
    ]);
    expect(page.entries[4]).toMatchObject({ text: TRANSCRIPT_FULL_NOTE });
    expect(page.run).toMatchObject({
      status: 'ended',
      iterations: 6,
      droppedEntries: 2,
      lastSeq: 6,
    });
    // Nothing is appended after the end.
    store.append('run-1', { kind: 'note', text: 'late' });
    expect(store.read('agent-1', 'run-1')!.entries).toHaveLength(6);
  });

  it('reads a run only under its own agent', () => {
    const store = new InMemoryRunTranscriptStore();
    store.start(START);
    expect(store.read('agent-2', 'run-1')).toBeUndefined();
    expect(store.list('agent-2')).toEqual([]);
  });
});

describe('FileRunTranscriptStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-runs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads its runs back after a restart; an open run comes back interrupted', () => {
    const path = join(dir, 'agent-runs.jsonl');
    const first = new FileRunTranscriptStore(path, { logger: quiet });
    first.start(START);
    first.append('run-1', { kind: 'note', text: 'hello' }, 2_000);
    first.append('run-1', {
      kind: 'end',
      stopReason: 'end_turn',
      iterations: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
      thinkingTurns: 0,
    });
    first.start({ ...START, runId: 'run-2', startedAt: 3_000 });
    first.append('run-2', {
      kind: 'usage',
      turn: 1,
      inputTokens: 7,
      outputTokens: 3,
      stopReason: 'tool_use',
    });
    first.close();

    const second = new FileRunTranscriptStore(path, { logger: quiet });
    expect(second.list('agent-1')).toMatchObject([
      { runId: 'run-2', status: 'interrupted', iterations: 1, inputTokens: 7, lastSeq: 1 },
      { runId: 'run-1', status: 'ended', stopReason: 'end_turn', lastSeq: 2 },
    ]);
    expect(second.read('agent-1', 'run-1')!.entries[0]).toMatchObject({
      seq: 1,
      at: 2_000,
      text: 'hello',
    });
    second.close();
  });

  it('compacts evicted runs away at boot and skips a torn line', () => {
    const path = join(dir, 'agent-runs.jsonl');
    const first = new FileRunTranscriptStore(path, { maxRuns: 2, logger: quiet });
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      first.start({ ...START, runId });
      first.append(runId, { kind: 'note', text: runId });
    }
    first.close();
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"runId":"run-c","entr`);

    const second = new FileRunTranscriptStore(path, { maxRuns: 2, logger: quiet });
    expect(second.list('agent-1').map((r) => r.runId)).toEqual(['run-c', 'run-b']);
    second.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).not.toContain('run-a');
  });
});
