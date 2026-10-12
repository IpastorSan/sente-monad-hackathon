/**
 * SEN-202: the server's Perpl section lags Perpl by up to its 30 s cache; the
 * phone's own orders overlay it until the server agrees.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PositionDto } from '../agents/api.ts';
import type { Portfolio } from '../trade/types.ts';
import {
  OVERLAY_TTL_MS,
  overlayPortfolio,
  overlayPositions,
  perplOverlay,
  perplPositionOn,
  recordPerpl,
  samePosition,
  settlePerpl,
  subscribePerplOverlay,
  type OverlayEntry,
} from './perplOverlay.ts';

function dto(overrides: Partial<PositionDto> = {}): PositionDto {
  return {
    symbol: 'BTC-PERP',
    side: 'long',
    size: '0.01',
    entryPrice: '100000',
    markPrice: '100100',
    liquidationPriceEst: '81000',
    leverage: 5,
    margin: '200',
    unrealizedPnl: '1',
    realizedPnl: null,
    fundingPaid: null,
    quote: 'AUSD',
    updatedAt: 1,
    ...overrides,
  };
}

const ETH = dto({ symbol: 'ETH-PERP', entryPrice: '3000', size: '1' });
const NOW = 1_000_000;

test('positions compare by side, size and entry, by value', () => {
  assert.ok(samePosition(dto(), dto({ markPrice: '1', unrealizedPnl: '-5' })));
  assert.ok(samePosition(dto(), dto({ size: '0.010', entryPrice: '100000.0' })));
  assert.ok(!samePosition(dto(), dto({ size: '0.02' })));
  assert.ok(!samePosition(dto(), dto({ side: 'short' })));
  assert.ok(samePosition(null, undefined));
  assert.ok(!samePosition(dto(), null));
});

test('a close hides the position the server’s stale read still lists', () => {
  const entry: OverlayEntry = { kind: 'gone', symbol: 'BTC-PERP', at: NOW, before: dto() };
  const out = overlayPositions([dto({ markPrice: '99000' }), ETH], [entry], NOW + 5_000);
  assert.deepEqual(out.positions, [ETH]);
  assert.deepEqual(out.pending, []);
  assert.deepEqual(out.settled, []);
});

test('a close settles once the server lists no position, or a different (newer) one', () => {
  const entry: OverlayEntry = { kind: 'gone', symbol: 'BTC-PERP', at: NOW, before: dto() };
  assert.deepEqual(overlayPositions([ETH], [entry], NOW).settled, ['BTC-PERP']);
  const reopened = dto({ entryPrice: '101000' });
  const out = overlayPositions([reopened], [entry], NOW);
  assert.deepEqual(out.positions, [reopened]);
  assert.deepEqual(out.settled, ['BTC-PERP']);
});

test('an open shows Perpl’s position at once, and yields to the server’s copy when it agrees', () => {
  const fresh = dto({ markPrice: '100000' });
  const entry: OverlayEntry = { kind: 'position', symbol: 'BTC-PERP', at: NOW, position: fresh };
  // The server has not seen it yet.
  assert.deepEqual(overlayPositions([ETH], [entry], NOW).positions, [ETH, fresh]);
  // An add: the server still has the smaller one.
  const grown: OverlayEntry = { ...entry, position: dto({ size: '0.02' }) };
  assert.deepEqual(overlayPositions([dto(), ETH], [grown], NOW).positions, [ETH, grown.position]);
  // The server caught up: its copy, with the live mark, wins.
  const live = dto({ markPrice: '100500' });
  const out = overlayPositions([live], [entry], NOW);
  assert.deepEqual(out.positions, [live]);
  assert.deepEqual(out.settled, ['BTC-PERP']);
});

test('a filled order Perpl has not shown yet is "updating", never "no position"', () => {
  const entry: OverlayEntry = { kind: 'pending', symbol: 'BTC-PERP', at: NOW, before: null };
  const out = overlayPositions([ETH], [entry], NOW);
  assert.deepEqual(out.positions, [ETH]);
  assert.deepEqual(out.pending, ['BTC-PERP']);
  // Once the server lists something new, it has caught up.
  assert.deepEqual(overlayPositions([dto()], [entry], NOW).settled, ['BTC-PERP']);
});

test('entries expire after the server’s longest lag', () => {
  const entry: OverlayEntry = { kind: 'gone', symbol: 'BTC-PERP', at: NOW, before: dto() };
  const out = overlayPositions([dto()], [entry], NOW + OVERLAY_TTL_MS + 1);
  assert.deepEqual(out.positions, [dto()]);
  assert.deepEqual(out.settled, ['BTC-PERP']);
});

function portfolio(perpl: Portfolio['perpl']): Portfolio {
  return {
    asOf: NOW,
    wallet: { ok: true, balances: [] },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl,
  } as Portfolio;
}

test('only a Perpl section that listed positions is overlaid', () => {
  const entry: OverlayEntry = { kind: 'gone', symbol: 'BTC-PERP', at: NOW, before: dto() };
  const ok = portfolio({ ok: true, status: 'ok', positions: [dto()], balances: [] });
  const out = overlayPortfolio(ok, [entry], NOW);
  assert.deepEqual(out.portfolio.perpl.ok && out.portfolio.perpl.positions, []);
  assert.equal(perplPositionOn(out.portfolio, 'BTC-PERP'), null);
  assert.deepEqual(perplPositionOn(ok, 'BTC-PERP'), dto());

  const failed = portfolio({ ok: false } as Portfolio['perpl']);
  assert.equal(overlayPortfolio(failed, [entry], NOW).portfolio, failed);
  const unlinked = portfolio({ ok: true, status: 'unlinked', balances: [] });
  assert.equal(overlayPortfolio(unlinked, [entry], NOW).portfolio, unlinked);
});

test('the store keeps one entry per market, the latest, and notifies', () => {
  let calls = 0;
  const unsubscribe = subscribePerplOverlay(() => calls++);
  recordPerpl({ kind: 'pending', symbol: 'BTC-PERP', at: 1, before: null });
  recordPerpl({ kind: 'position', symbol: 'BTC-PERP', at: 2, position: dto() });
  recordPerpl({ kind: 'gone', symbol: 'ETH-PERP', at: 3, before: ETH });
  assert.deepEqual(
    perplOverlay().map((e) => [e.symbol, e.kind]),
    [
      ['BTC-PERP', 'position'],
      ['ETH-PERP', 'gone'],
    ],
  );
  settlePerpl(['BTC-PERP', 'ETH-PERP']);
  assert.deepEqual(perplOverlay(), []);
  settlePerpl(['BTC-PERP']); // nothing left: no notification
  unsubscribe();
  assert.equal(calls, 4);
});
