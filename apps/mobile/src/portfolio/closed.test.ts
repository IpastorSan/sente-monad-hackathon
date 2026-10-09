/** Closed positions from fills (SEN-154). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closedList,
  closedNotes,
  closedRow,
  closedTotal,
  closedPositions,
  type ClosableFill,
  type FillCoverage,
} from './closed.ts';

let seq = 0;
function fill(
  side: 'buy' | 'sell' | null,
  size: string,
  price: string,
  at: number,
  extra: Partial<ClosableFill> = {},
): ClosableFill {
  seq += 1;
  return {
    venue: 'kuru',
    tradeId: `t${seq}`,
    venueTradeId: `v${seq}`,
    symbol: 'MON-USDC',
    side,
    price,
    size,
    timestamp: at,
    ...extra,
  };
}

const perp = (side: 'buy' | 'sell', size: string, price: string, at: number, extra = {}) =>
  fill(side, size, price, at, { venue: 'perpl', tradeId: null, symbol: 'ETH-PERP', ...extra });

const ALL: FillCoverage = { kuru: 'complete', perpl: 'complete' };

test('a buy then a sell of the same size is one closed long, P&L exact', () => {
  const { positions } = closedPositions([
    fill('buy', '10', '1.1', 1),
    fill('sell', '10', '1.3', 2),
  ]);
  assert.equal(positions.length, 1);
  const [p] = positions;
  assert.equal(p?.direction, 'long');
  assert.equal(p?.size, '10');
  assert.equal(p?.entry, '1.1');
  assert.equal(p?.exit, '1.3');
  assert.equal(p?.costBasis, '11');
  assert.equal(p?.realisedPnl, '2');
  assert.equal(p?.pnlAsset, 'USDC');
  assert.equal(p?.openedAt, 1);
  assert.equal(p?.closedAt, 2);
  assert.ok(Math.abs((p?.pct ?? 0) - 18.1818) < 0.001);
  // A fill with no fee: said, not assumed to be zero.
  assert.equal(p?.feesIncluded, false);
});

test('fills arrive newest first; order in does not matter', () => {
  const fills = [fill('sell', '1', '3', 30), fill('buy', '1', '2', 20)];
  assert.equal(closedPositions(fills).positions[0]?.realisedPnl, '1');
});

test('a partial close is not closed; the position is still open', () => {
  const { positions } = closedPositions([fill('buy', '10', '1', 1), fill('sell', '4', '2', 2)]);
  assert.deepEqual(positions, []);
});

test('partial closes add up once the size is back to zero', () => {
  const { positions } = closedPositions([
    fill('buy', '10', '1', 1),
    fill('sell', '4', '2', 2),
    fill('sell', '6', '0.5', 3),
  ]);
  assert.equal(positions.length, 1);
  // 4 × (2 − 1) + 6 × (0.5 − 1) = 4 − 3
  assert.equal(positions[0]?.realisedPnl, '1');
  assert.equal(positions[0]?.exit, '1.1');
  assert.equal(positions[0]?.fills, 3);
});

test('multiple lots match FIFO, splitting a lot when the exit cuts through it', () => {
  const { positions } = closedPositions([
    fill('buy', '5', '1', 1),
    fill('buy', '5', '2', 2),
    fill('sell', '7', '3', 3),
    fill('sell', '3', '1', 4),
  ]);
  assert.equal(positions.length, 1);
  // Sell 7 @3: 5 × (3−1) + 2 × (3−2) = 12. Sell 3 @1 against the rest of lot 2: 3 × (1−2) = −3.
  assert.equal(positions[0]?.realisedPnl, '9');
  assert.equal(positions[0]?.entry, '1.5');
  assert.equal(positions[0]?.costBasis, '15');
});

test('a market that goes flat twice is two trips, newest close first', () => {
  const { positions } = closedPositions([
    fill('buy', '1', '1', 1),
    fill('sell', '1', '2', 2),
    fill('buy', '2', '3', 3),
    fill('sell', '2', '2.5', 4),
  ]);
  assert.deepEqual(
    positions.map((p) => [p.realisedPnl, p.openedAt, p.closedAt]),
    [
      ['-1', 3, 4],
      ['1', 1, 2],
    ],
  );
});

test('spot has no short: a sell from flat is left out, and over-selling closes at zero with a note', () => {
  const { positions } = closedPositions([
    fill('sell', '3', '5', 1),
    fill('buy', '2', '1', 2),
    fill('sell', '5', '2', 3),
  ]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.size, '2');
  assert.equal(positions[0]?.realisedPnl, '2');
  assert.match(positions[0]?.notes[0] ?? '', /^3 sold had no buy/u);
});

test('fees are netted whole on the fill that paid them, base fees priced at that fill', () => {
  const { positions } = closedPositions([
    fill('buy', '10', '1', 1, { fee: '0.1', feeAsset: 'USDC' }),
    // A fee in MON, the base, priced at this fill: 0.05 × 2 = 0.1 USDC.
    fill('sell', '10', '2', 2, { fee: '0.05', feeAsset: 'MON' }),
  ]);
  assert.equal(positions[0]?.realisedPnl, '9.8');
  assert.equal(positions[0]?.feesIncluded, true);
});

test('a fee with no asset is read as the P&L asset', () => {
  const { positions } = closedPositions([
    fill('buy', '1', '1', 1, { fee: '0.01' }),
    fill('sell', '1', '1', 2, { fee: '0.01' }),
  ]);
  assert.equal(positions[0]?.realisedPnl, '-0.02');
});

test('perps: a short makes money when price falls, in AUSD', () => {
  const { positions } = closedPositions([
    perp('sell', '2', '2500', 1),
    perp('buy', '2', '2400', 2),
  ]);
  assert.equal(positions[0]?.direction, 'short');
  assert.equal(positions[0]?.realisedPnl, '200');
  assert.equal(positions[0]?.pnlAsset, 'AUSD');
  assert.equal(positions[0]?.venue, 'perpl');
});

test('perps: a sell past the long closes it and opens a short with the rest', () => {
  const { positions } = closedPositions([
    perp('buy', '1', '100', 1, { fee: '0.3', feeAsset: 'AUSD' }),
    perp('sell', '3', '110', 2, { fee: '0.9', feeAsset: 'AUSD' }),
    perp('buy', '2', '105', 3, { fee: '0.6', feeAsset: 'AUSD' }),
  ]);
  assert.equal(positions.length, 2);
  const [short, long] = positions;
  // Long: 1 × (110 − 100) − 0.3 − 0.9 × 1/3.
  assert.equal(long?.direction, 'long');
  assert.equal(long?.realisedPnl, '9.4');
  // Short: 2 × (110 − 105) − 0.9 × 2/3 − 0.6.
  assert.equal(short?.direction, 'short');
  assert.equal(short?.size, '2');
  assert.equal(short?.entry, '110');
  assert.equal(short?.openedAt, 2);
  assert.equal(short?.realisedPnl, '8.8');
});

test('a flip whose new side is still open lists only the closed side', () => {
  const { positions } = closedPositions([perp('buy', '1', '100', 1), perp('sell', '2', '90', 2)]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.realisedPnl, '-10');
});

test('markets and venues replay apart; the same fill on two pages counts once', () => {
  const a = fill('buy', '1', '1', 1);
  const fills = [
    a,
    a,
    fill('buy', '1', '5', 2, { symbol: 'WETH-USDC' }),
    fill('sell', '1', '2', 3),
  ];
  const { positions } = closedPositions(fills);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.realisedPnl, '1');
});

test('closedList: a complete history gets its ≈ $ total across venues', () => {
  const list = closedList(
    [
      fill('buy', '1', '1', 1),
      fill('sell', '1', '1.5', 2),
      perp('buy', '1', '10', 3),
      perp('sell', '1', '9', 4),
    ],
    ALL,
  );
  assert.equal(list.positions.length, 2);
  assert.equal(list.total, '-0.5');
  assert.deepEqual(list.gaps, []);
  assert.equal(list.feesIncluded, false);
});

test('closedList: Perpl unlinked keeps Kuru rows, names the gap and withholds the total', () => {
  const list = closedList([fill('buy', '1', '1', 1), fill('sell', '1', '2', 2)], {
    kuru: 'complete',
    perpl: 'unlinked',
  });
  assert.equal(list.positions.length, 1);
  assert.equal(list.total, null);
  assert.match(list.gaps.join(' '), /once Perpl is linked/u);
});

test('closedList: a venue still paging shows no rows, since an older lot would move every match', () => {
  const list = closedList(
    [
      fill('buy', '1', '1', 1),
      fill('sell', '1', '2', 2),
      perp('buy', '1', '1', 1),
      perp('sell', '1', '2', 2),
    ],
    { kuru: 'paging', perpl: 'complete' },
  );
  assert.deepEqual(
    list.positions.map((p) => p.venue),
    ['perpl'],
  );
  assert.equal(list.total, null);
  assert.match(list.gaps[0] ?? '', /older Kuru fills/u);
});

test('closedList: a Kuru section that failed, or fills that lost their market, withhold Kuru', () => {
  const unread = closedList([fill('buy', '1', '1', 1), fill('sell', '1', '2', 2)], {
    kuru: 'unread',
    perpl: 'complete',
  });
  assert.equal(unread.positions.length, 0);
  assert.match(unread.gaps[0] ?? '', /Kuru didn’t answer/u);

  const lost = closedList(
    [fill('buy', '1', '1', 1), fill('sell', '1', '2', 2), fill(null, '1', '2', 3)],
    ALL,
  );
  assert.equal(lost.positions.length, 0);
  assert.equal(lost.total, null);
  assert.match(lost.gaps[0] ?? '', /^1 Kuru fill lost its market/u);
});

test('closedList: still loading is reading, not empty', () => {
  const list = closedList([], { kuru: 'loading', perpl: 'loading' });
  assert.equal(list.reading, true);
  assert.equal(list.total, null);
});

test('closedRow: exact money, both dates, and hiding keeps the percent', () => {
  const [p] = closedPositions([
    fill('buy', '10', '1.1', Date.UTC(2026, 8, 20)),
    fill('sell', '10', '1.3', Date.UTC(2026, 8, 24)),
  ]).positions;
  assert.ok(p);
  const row = closedRow(p, false);
  assert.equal(row.title, 'MON');
  assert.equal(row.caption, '10.0000 MON · 1.1000 → 1.3000 · Kuru');
  assert.equal(row.pnl, '+2.00');
  assert.equal(row.tone, 'up');
  assert.equal(row.under, '+18.18% · Sep 20 – Sep 24');
  const masked = closedRow(p, true);
  assert.equal(masked.pnl, '+•.••');
  assert.match(masked.under, /^\+18\.18%/u);
  assert.equal(closedTotal('-2.675', false), '−$2.68');
  assert.equal(closedTotal(null, false), null);
});

test('closedNotes: "before fees" only when a trip has a fill without its fee (SEN-162)', () => {
  const paid = { fee: '0.01', feeAsset: 'USDC' };
  const after = closedList([fill('buy', '1', '1', 1, paid), fill('sell', '1', '2', 2, paid)], ALL);
  assert.equal(after.feesIncluded, true);
  assert.equal(after.total, '0.98');
  assert.deepEqual(closedNotes(after), []);

  // One fill of one trip with its fee unreported (`null` on the route) is enough.
  const before = closedList(
    [
      fill('buy', '1', '1', 1, paid),
      fill('sell', '1', '2', 2, paid),
      perp('buy', '1', '10', 3, { fee: '0.01', feeAsset: 'AUSD' }),
      perp('sell', '1', '11', 4, { fee: null, feeAsset: null }),
    ],
    ALL,
  );
  assert.deepEqual(
    before.positions.map((p) => [p.venue, p.feesIncluded]),
    [
      ['perpl', false],
      ['kuru', true],
    ],
  );
  assert.deepEqual(closedNotes(before), [
    'Some fills didn’t report their fee, so those positions are before fees.',
    'Perp funding is not included.',
  ]);
});

test('a perp round trip that lost under a cent net of fees reads −0.01, red (SEN-179)', () => {
  const { positions } = closedPositions([
    perp('buy', '0.008', '2483.34', 1, { fee: '0.007', feeAsset: 'AUSD', venueTradeId: 'open' }),
    perp('sell', '0.008', '2484.66', 2, { fee: '0.007', feeAsset: 'AUSD', venueTradeId: 'close' }),
  ]);
  const [p] = positions;
  assert.equal(p?.realisedPnl, '-0.00344', '0.01056 on price, 0.014 in fees');
  assert.equal(p?.closedBy, 'perpl::close');
  const row = closedRow(p!, false);
  assert.equal(row.pnl, '−0.01');
  assert.equal(row.tone, 'down');
  assert.equal(closedTotal('-0.00344', false), '−$0.01');
});
