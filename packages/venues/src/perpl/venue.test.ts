import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOrder, toPosition, type ResolvedMarket } from './venue.ts';
import type { PerplMarket, PerplOrder, PerplPosition } from './wire.ts';

/** BTC as testnet configures it: 1 price decimal, 5 size decimals, MMF 25 (= 4%). */
function btc(maintenanceMargin = 2500): ResolvedMarket {
  const raw = {
    id: 16,
    symbol: 'BTC',
    config: { price_decimals: 1, size_decimals: 5, maintenance_margin: maintenanceMargin },
  } as unknown as PerplMarket;
  return { raw, symbol: 'BTC-PERP', pd: 1, sd: 5, cd: 6, collateral: 'AUSD' };
}

function position(overrides: Partial<PerplPosition>): PerplPosition {
  return {
    at: { t: 1 },
    mkt: 16,
    acc: 493,
    pid: 7,
    st: 1,
    sd: 1,
    c: String(10_000n * 10n ** 6n), // $10,000 of AUSD
    ep: 1_000_000, // $100,000.0
    s: 100_000, // 1 BTC
    lv: 1000,
    ...overrides,
  };
}

test("liquidation price reproduces Perpl's own worked example ($100k 10x long -> $94k)", () => {
  const p = toPosition(position({}), btc(), 1_000_000n);
  assert.equal(p.liquidationPrice, '94000');
  assert.equal(p.side, 'long');
  assert.equal(p.leverage, 10);
  assert.equal(p.margin, '10000');
  assert.equal(p.size, '1');
  assert.equal(p.entryPrice, '100000');
  assert.equal(p.marginMode, 'isolated');
});

test('a short liquidates on the way up', () => {
  const p = toPosition(position({ sd: 2 }), btc(), 1_000_000n);
  assert.equal(p.liquidationPrice, '106000');
  assert.equal(p.side, 'short');
});

test('uPnL is side · (mark − entry) · size, in collateral units', () => {
  const long = toPosition(position({}), btc(), 950_000n); // mark $95,000
  assert.equal(long.unrealizedPnl, '-5000');
  assert.equal(long.markPrice, '95000');
  const short = toPosition(position({ sd: 2 }), btc(), 950_000n);
  assert.equal(short.unrealizedPnl, '5000');
});

test('collateral rescales when price+size decimals are below the token decimals', () => {
  // ETH-like: pd 2 + sd 3 = 5 < cd 6. 1 ETH long at $2,000, $400 deposit, MMF 20 (5%).
  const raw = {
    id: 32,
    symbol: 'ETH',
    config: { price_decimals: 2, size_decimals: 3, maintenance_margin: 2000 },
  } as unknown as PerplMarket;
  const eth: ResolvedMarket = { raw, symbol: 'ETH-PERP', pd: 2, sd: 3, cd: 6, collateral: 'AUSD' };
  const p = toPosition(
    position({ mkt: 32, ep: 200_000, s: 1_000, c: String(400n * 10n ** 6n), lv: 500 }),
    eth,
    200_000n,
  );
  // MMR = $100; liq = 2000 + (100 − 400) / 1 = 1700
  assert.equal(p.liquidationPrice, '1700');
  assert.equal(p.leverage, 5);
});

test('orders map status, side and the tx hash with its 0x', () => {
  const raw: PerplOrder = {
    at: { b: 9_999, t: 20, txid: 'ab'.repeat(32) },
    c: { t: 10 },
    rq: 3,
    mkt: 16,
    acc: 493,
    oid: 42,
    st: 4,
    t: 3, // CloseLong: a reduce-only sell
    p: 771_081,
    os: 100,
    fp: 771_050,
    fs: 100,
    fl: 4,
    lv: 500,
  };
  const order = toOrder(raw, btc(), { type: 'market', timeInForce: 'IOC' });
  assert.deepEqual(order, {
    id: '42',
    symbol: 'BTC-PERP',
    side: 'sell',
    type: 'market',
    status: 'filled',
    price: '77108.1',
    size: '0.001',
    filledSize: '0.001',
    averageFillPrice: '77105',
    timeInForce: 'IOC',
    reduceOnly: true,
    blockNumber: 9_999,
    leverage: 5,
    createdAt: 10,
    updatedAt: 20,
    txHash: `0x${'ab'.repeat(32)}`,
  });
});

test('a failed order with no on-chain id is identified by its rq', () => {
  const order = toOrder(
    { at: {}, rq: 9, mkt: 16, acc: 493, oid: 0, st: 7, sr: 34, t: 1, os: 100, fl: 0, lv: 100 },
    btc(),
  );
  assert.equal(order.id, 'rq:9');
  assert.equal(order.status, 'rejected');
  assert.equal(order.side, 'buy');
});
