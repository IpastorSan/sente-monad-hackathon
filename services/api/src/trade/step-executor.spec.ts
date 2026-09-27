import { Logger } from '@nestjs/common';
import type { AuthorizationPayload } from '@sente/mandate';
import { getAddress, type Hash, type Hex } from 'viem';
import type { UserOperationReceipt } from 'viem/account-abstraction';

import { PrivyError } from '../agents/privy/privy.client';
import { WriteSpacer } from '../spacing/write-spacer';
import type { SponsoredSendOutcome } from '../wallet/send/sponsored-send';
import type { SendRequest } from '../wallet/user-wallet.provider';
import { StepExecutor, type StepExecutorDeps } from './step-executor';
import { TradeStore, type StepKind, type Trade, type TradeStep } from './trade-store';

// The executor logs every refusal and timeout; the assertions below cover them.
beforeAll(() => Logger.overrideLogger(false));

const T0 = new Date('2026-09-27T12:00:00Z');
const WALLET = 'wallet00000000000000test';

function hash(n: number): Hash {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function step(index: number, kind: StepKind): TradeStep {
  const request: SendRequest = {
    method: 'POST',
    path: `/v1/wallets/${WALLET}/rpc`,
    body: { step: index },
    subject: WALLET,
    idempotencyKey: `sente-trade:c:${index}`,
  };
  return {
    index,
    kind,
    title: kind,
    request,
    payload: {} as AuthorizationPayload,
    status: 'awaiting_signature',
  };
}

function claimedTrade(store: TradeStore, patch: Partial<Trade> = {}): Trade {
  store.put({
    id: 'trade-1',
    userId: 'alice',
    clientTradeId: 'c',
    intentHash: 'h',
    kind: 'kuru.place',
    walletId: WALLET,
    address: getAddress(`0x${'9'.repeat(40)}`),
    steps: [step(0, 'approve'), step(1, 'deposit'), step(2, 'place')],
    status: 'prepared',
    createdAt: T0,
    updatedAt: T0,
    expiresAt: new Date(T0.getTime() + 60_000),
    ...patch,
  });
  const claimed = store.claimForCommit('alice', patch.id ?? 'trade-1', T0);
  if (typeof claimed !== 'object') throw new Error(`claim failed: ${String(claimed)}`);
  return claimed;
}

function receipt(userOpHash: Hash, success: boolean): UserOperationReceipt {
  return {
    userOpHash,
    success,
    ...(success ? {} : { reason: 'boom' }),
    logs: [],
    receipt: { transactionHash: hash(0xbeef), blockNumber: 42n },
  } as unknown as UserOperationReceipt;
}

/**
 * A fake Privy + bundler. Step `i` gets user-op hash `i + 1`; `sends` answers
 * each commit (a throw or an outcome), `receipts` decides what the bundler says
 * for each hash (`'never'` = still pending forever).
 */
function harness(
  opts: {
    sends?: Record<number, () => SponsoredSendOutcome>;
    receipts?: Record<number, boolean | 'never'>;
  } = {},
) {
  const store = new TradeStore();
  const events: string[] = [];
  const committed: { request: SendRequest; signature: string }[] = [];
  let clock = 0;

  const deps: StepExecutorDeps = {
    store,
    wallets: {
      commitSend: (request: SendRequest, { signature }) => {
        const index = (request.body as { step: number }).step;
        events.push(`send ${index}`);
        committed.push({ request, signature });
        const answer = opts.sends?.[index];
        return Promise.resolve().then(() => answer?.() ?? { userOpHash: hash(index + 1) });
      },
    },
    bundler: {
      receipt: (userOpHash: Hash) => {
        const index = Number(BigInt(userOpHash)) - 1;
        const verdict = opts.receipts?.[index] ?? true;
        if (verdict === 'never') return Promise.resolve(null);
        events.push(`landed ${index}`);
        return Promise.resolve(receipt(userOpHash, verdict));
      },
    },
    spacer: new WriteSpacer({ spacingMs: 0 }),
    options: {
      pollMs: 100,
      timeoutMs: 1_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  };
  return { store, deps, events, committed };
}

function statuses(store: TradeStore): string[] {
  return store.get('alice', 'trade-1')!.steps.map((s) => s.status);
}

describe('StepExecutor', () => {
  it('sends every step in order and completes when all are included', async () => {
    const { store, deps, events, committed } = harness();
    const trade = claimedTrade(store);

    await new StepExecutor(deps).execute(trade, ['s0', 's1', 's2']);

    const done = store.get('alice', 'trade-1')!;
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => s.status)).toEqual(['included', 'included', 'included']);
    expect(done.steps[2]).toMatchObject({
      userOpHash: hash(3),
      transactionHash: hash(0xbeef),
      blockNumber: '42',
    });
    // Strictly sequential: step n+1 is sent only after step n's receipt.
    expect(events).toEqual(['send 0', 'landed 0', 'send 1', 'landed 1', 'send 2', 'landed 2']);
    // Each signature goes with its own step's stored request, idempotency key intact.
    expect(committed.map((c) => [c.signature, c.request.idempotencyKey])).toEqual([
      ['s0', 'sente-trade:c:0'],
      ['s1', 'sente-trade:c:1'],
      ['s2', 'sente-trade:c:2'],
    ]);
  });

  it('stops at a reverted step and leaves the rest not_sent', async () => {
    const { store, deps, events } = harness({ receipts: { 1: false } });

    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);

    const done = store.get('alice', 'trade-1')!;
    expect(done.status).toBe('failed');
    expect(statuses(store)).toEqual(['included', 'reverted', 'not_sent']);
    expect(done.steps[1].error).toBe('boom');
    expect(events).not.toContain('send 2');
  });

  it('decides from the user operation success flag, not the carrying transaction', async () => {
    // The fake receipt's transaction exists either way; only `success` differs.
    const { store, deps } = harness({ receipts: { 0: false } });
    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);
    expect(statuses(store)).toEqual(['reverted', 'not_sent', 'not_sent']);
  });

  it('marks a step unknown on timeout, never failed, and sends nothing after it', async () => {
    const { store, deps, events } = harness({ receipts: { 0: 'never' } });

    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);

    const done = store.get('alice', 'trade-1')!;
    expect(statuses(store)).toEqual(['unknown', 'not_sent', 'not_sent']);
    expect(done.steps[0].userOpHash).toBe(hash(1));
    expect(done.status).toBe('executing');
    expect(events).toEqual(['send 0']);
  });

  it('maps a refused signature to invalid_authorization', async () => {
    const { store, deps } = harness({
      sends: {
        0: () => {
          throw new PrivyError('POST', '/v1/wallets/w/rpc', 401, { error: 'bad signature' });
        },
      },
    });

    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);

    const done = store.get('alice', 'trade-1')!;
    expect(done.status).toBe('failed');
    expect(statuses(store)).toEqual(['not_sent', 'not_sent', 'not_sent']);
    expect(done.steps[0].error).toBe('invalid_authorization');
  });

  it('maps a broadcast failure to send_broadcast_failed', async () => {
    const { store, deps } = harness({
      sends: {
        1: () => {
          throw new PrivyError('POST', '/p', 400, { code: 'transaction_broadcast_failure' });
        },
      },
    });
    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);
    expect(statuses(store)).toEqual(['included', 'not_sent', 'not_sent']);
    expect(store.get('alice', 'trade-1')!.steps[1].error).toBe('send_broadcast_failed');
  });

  it('calls a send that failed without an answer unknown: it may have reached Privy', async () => {
    const { store, deps } = harness({
      sends: {
        0: () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);
    expect(statuses(store)).toEqual(['unknown', 'not_sent', 'not_sent']);
    expect(store.get('alice', 'trade-1')!.status).toBe('executing');
  });

  it('calls a send with no user-operation hash unknown', async () => {
    const tx: Hex = hash(7);
    const { store, deps } = harness({ sends: { 0: () => ({ transactionHash: tx }) } });
    await new StepExecutor(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);
    expect(store.get('alice', 'trade-1')!.steps[0]).toMatchObject({
      status: 'unknown',
      transactionHash: tx,
    });
    expect(statuses(store)).toEqual(['unknown', 'not_sent', 'not_sent']);
  });

  it('refuses a signature count that does not match before sending anything', async () => {
    const { store, deps, events } = harness();
    await expect(new StepExecutor(deps).execute(claimedTrade(store), ['s0'])).rejects.toThrow(
      RangeError,
    );
    expect(events).toEqual([]);
  });

  it('hands every landed step and its receipt to onStepLanded, and survives it throwing', async () => {
    const landed: [number, string, boolean][] = [];
    class Hooked extends StepExecutor {
      protected override onStepLanded(s: TradeStep, r: UserOperationReceipt): void {
        landed.push([s.index, s.status, r.success]);
        throw new Error('decode failed');
      }
    }
    const { store, deps } = harness({ receipts: { 1: false } });
    await new Hooked(deps).execute(claimedTrade(store), ['s0', 's1', 's2']);
    expect(landed).toEqual([
      [0, 'included', true],
      [1, 'reverted', false],
    ]);
    expect(statuses(store)).toEqual(['included', 'reverted', 'not_sent']);
  });

  it('runs two trades for one wallet one after the other, never interleaved', async () => {
    const { store, deps, events } = harness();
    const first = claimedTrade(store);
    const second = claimedTrade(store, { id: 'trade-2', clientTradeId: 'd' });
    const executor = new StepExecutor(deps);

    await Promise.all([
      executor.execute(first, ['a0', 'a1', 'a2']),
      executor.execute(second, ['b0', 'b1', 'b2']),
    ]);

    expect(events.slice(0, 6)).toEqual([
      'send 0',
      'landed 0',
      'send 1',
      'landed 1',
      'send 2',
      'landed 2',
    ]);
    expect(store.get('alice', 'trade-2')!.status).toBe('completed');
  });
});
