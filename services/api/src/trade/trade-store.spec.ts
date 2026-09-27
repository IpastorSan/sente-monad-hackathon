import type { AuthorizationPayload } from '@sente/mandate';
import { getAddress } from 'viem';

import { TRADE_RETENTION_MS, TradeStore, type Trade } from './trade-store';

const T0 = new Date('2026-09-27T12:00:00Z');
const TTL_MS = 5 * 60 * 1000;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function trade(patch: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    userId: 'alice',
    clientTradeId: '6f1c1f0e-8a4b-4c1e-9d7a-0b3c2e1f4a5b',
    intentHash: 'hash-a',
    kind: 'kuru.place',
    walletId: 'wallet00000000000000test',
    address: getAddress(`0x${'9'.repeat(40)}`),
    steps: [
      {
        index: 0,
        kind: 'place',
        title: 'Place order',
        request: { method: 'POST', path: '/v1/wallets/w/rpc', body: {}, subject: 'w' },
        payload: {} as AuthorizationPayload,
        status: 'awaiting_signature',
      },
    ],
    status: 'prepared',
    createdAt: T0,
    updatedAt: T0,
    expiresAt: at(TTL_MS),
    ...patch,
  };
}

let store: TradeStore;
beforeEach(() => {
  store = new TradeStore();
});

describe('put and byClientId (idempotency)', () => {
  it('finds a stored trade by its client id', () => {
    const t = trade();
    expect(store.put(t)).toBe(t);
    expect(store.byClientId('alice', t.clientTradeId, T0)).toBe(t);
  });

  it('returns the stored trade when a racing retry carries the same intent', () => {
    const first = trade();
    store.put(first);
    expect(store.put(trade({ id: 'trade-2' }))).toBe(first);
    expect(store.get('alice', 'trade-2', T0)).toBeUndefined();
  });

  it('refuses a different intent under the same client id', () => {
    store.put(trade());
    expect(store.put(trade({ id: 'trade-2', intentHash: 'hash-b' }))).toBe('conflict');
    expect(store.byClientId('alice', trade().clientTradeId, T0)?.id).toBe('trade-1');
  });

  it('still conflicts once the first trade is committed', () => {
    store.put(trade());
    store.claimForCommit('alice', 'trade-1', at(1000));
    expect(store.put(trade({ id: 'trade-2', intentHash: 'hash-b' }), at(TTL_MS * 2))).toBe(
      'conflict',
    );
  });

  it('lets an expired, never-committed trade give its client id up', () => {
    store.put(trade());
    const retry = trade({ id: 'trade-2', intentHash: 'hash-b', createdAt: at(TTL_MS) });
    expect(store.put(retry)).toBe(retry);
    expect(store.get('alice', 'trade-1', at(TTL_MS))).toBeUndefined();
  });

  it('keeps client ids per user', () => {
    store.put(trade());
    const bobs = trade({ id: 'trade-2', userId: 'bob', intentHash: 'hash-b' });
    expect(store.put(bobs)).toBe(bobs);
    expect(store.byClientId('alice', bobs.clientTradeId, T0)?.id).toBe('trade-1');
    expect(store.byClientId('bob', bobs.clientTradeId, T0)?.id).toBe('trade-2');
  });
});

describe('claimForCommit', () => {
  it('moves a prepared trade to executing exactly once', () => {
    store.put(trade());
    const claimed = store.claimForCommit('alice', 'trade-1', at(1000));
    expect(claimed).toMatchObject({ id: 'trade-1', status: 'executing', updatedAt: at(1000) });
    expect(store.claimForCommit('alice', 'trade-1', at(2000))).toBe('committed');
    expect(store.get('alice', 'trade-1', at(2000))?.status).toBe('executing');
  });

  it('refuses an expired trade, which reads as expired', () => {
    store.put(trade());
    expect(store.claimForCommit('alice', 'trade-1', at(TTL_MS))).toBe('expired');
    expect(store.get('alice', 'trade-1', at(TTL_MS))?.status).toBe('expired');
    expect(store.get('alice', 'trade-1', at(TTL_MS - 1))?.status).toBe('prepared');
  });

  it("does not find another user's trade, nor spend it", () => {
    store.put(trade());
    expect(store.claimForCommit('bob', 'trade-1', at(1000))).toBeUndefined();
    expect(store.get('bob', 'trade-1', at(1000))).toBeUndefined();
    expect(store.claimForCommit('alice', 'trade-1', at(1000))).toMatchObject({
      status: 'executing',
    });
  });

  it('does not find an unknown id', () => {
    expect(store.claimForCommit('alice', 'nope', T0)).toBeUndefined();
  });
});

describe('update and listRecent', () => {
  it('applies a patch and stamps updatedAt', () => {
    store.put(trade());
    store.claimForCommit('alice', 'trade-1', at(1000));
    const updated = store.update('trade-1', { status: 'completed' }, at(3000));
    expect(updated).toMatchObject({ status: 'completed', updatedAt: at(3000), createdAt: T0 });
    expect(store.update('nope', { status: 'failed' }, at(3000))).toBeUndefined();
  });

  it("lists only the user's own trades, newest first, up to the limit", () => {
    store.put(trade());
    store.put(trade({ id: 'trade-2', clientTradeId: 'c2', createdAt: at(10) }));
    store.put(trade({ id: 'trade-3', clientTradeId: 'c3', createdAt: at(20) }));
    store.put(trade({ id: 'bob-1', userId: 'bob', clientTradeId: 'c4', createdAt: at(30) }));
    expect(store.listRecent('alice', 2, at(40)).map((t) => t.id)).toEqual(['trade-3', 'trade-2']);
    expect(store.listRecent('bob', 10, at(40)).map((t) => t.id)).toEqual(['bob-1']);
  });
});

describe('sweep', () => {
  it('forgets a never-committed trade a retention period after it expired', () => {
    store.put(trade());
    store.sweep(at(TTL_MS + TRADE_RETENTION_MS - 1));
    expect(store.get('alice', 'trade-1', at(TTL_MS + TRADE_RETENTION_MS - 1))).toBeDefined();
    store.sweep(at(TTL_MS + TRADE_RETENTION_MS));
    expect(store.get('alice', 'trade-1', at(TTL_MS + TRADE_RETENTION_MS))).toBeUndefined();
    expect(store.byClientId('alice', trade().clientTradeId)).toBeUndefined();
  });

  it('keeps a finished trade for the retention period after its last update', () => {
    store.put(trade());
    store.claimForCommit('alice', 'trade-1', at(1000));
    store.update('trade-1', { status: 'completed' }, at(2000));
    store.sweep(at(2000 + TRADE_RETENTION_MS - 1));
    expect(store.get('alice', 'trade-1', at(2000 + TRADE_RETENTION_MS - 1))).toBeDefined();
    store.sweep(at(2000 + TRADE_RETENTION_MS));
    expect(store.get('alice', 'trade-1', at(2000 + TRADE_RETENTION_MS))).toBeUndefined();
  });

  it('never forgets an executing trade', () => {
    store.put(trade());
    store.claimForCommit('alice', 'trade-1', at(1000));
    store.sweep(at(TRADE_RETENTION_MS * 10));
    expect(store.get('alice', 'trade-1', at(TRADE_RETENTION_MS * 10))?.status).toBe('executing');
  });

  it('runs on put', () => {
    store.put(trade());
    store.put(
      trade({ id: 'trade-2', clientTradeId: 'c2', createdAt: at(TTL_MS + TRADE_RETENTION_MS) }),
    );
    expect(store.listRecent('alice', 10, at(TTL_MS + TRADE_RETENTION_MS)).map((t) => t.id)).toEqual(
      ['trade-2'],
    );
  });
});
