/**
 * Receipt decoding against real Monad testnet receipts (`receipts.fixture.ts`).
 *
 * `batch` returns nothing, so these packed events are the ONLY record of what
 * an order did. Decoding them wrong means reporting a fill that did not happen
 * or losing track of a resting order, so this is tested on the real bytes, not
 * on logs the test built itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KURU_TESTNET_MARKETS } from './constants.ts';
import { toPlacedOrder } from './mapping.ts';
import { decodeOrderOutcome, type KuruMarketParams } from './orders.ts';
import { RECEIPT_ACCOUNT_ID, RECEIPTS } from './receipts.fixture.ts';

const market = (symbol: string) => KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol)!.address;
const MON_USDC = market('MON-USDC');

const PARAMS: KuruMarketParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 100_000_000n,
  tickSize: 1n,
  minQuoteNotional: 10_000_000n,
  maxQuoteNotional: 5_000_000_000_000n,
  takerFeePps: 7000n,
  makerFeePps: 4000n,
};

/** The order `placeLimit` rested: 500 MON bid at 0.02, slot 0, order 3680. */
const RESTED = { slotIdx: 0, orderId: 3680n, price: 20_000n, size: 50_000_000_000n, isBuy: true };

test('a resting limit order: BookUpdatesPacked names its slot and order id', () => {
  assert.deepEqual(decodeOrderOutcome(RECEIPTS.placeLimit.logs, MON_USDC, RECEIPT_ACCOUNT_ID), {
    fills: [],
    rested: [RESTED],
    removed: [],
    takerFeePps: undefined,
  });
});

test('a cancel: the same order comes back as a removal, not a live record', () => {
  assert.deepEqual(decodeOrderOutcome(RECEIPTS.cancel.logs, MON_USDC, RECEIPT_ACCOUNT_ID), {
    fills: [],
    rested: [],
    removed: [RESTED],
    takerFeePps: undefined,
  });
});

test('a taking IOC: TradesPacked carries the fills and nothing rests', () => {
  const outcome = decodeOrderOutcome(RECEIPTS.placeMarket.logs, MON_USDC, RECEIPT_ACCOUNT_ID);
  assert.equal(outcome.rested.length, 0);
  assert.equal(outcome.removed.length, 0);
  assert.equal(outcome.takerFeePps, 7000n);
  assert.ok(outcome.fills.length > 0);
  assert.ok(
    outcome.fills.every((fill) => fill.price === 30_974n && fill.makerId !== RECEIPT_ACCOUNT_ID),
  );
  assert.equal(
    outcome.fills.reduce((sum, fill) => sum + fill.size, 0n),
    31_773_742_494n, // the whole best ask: 317.73742494 MON
  );

  // 388 MON asked for at a 2% bound; the next ask was beyond it, so the rest
  // of the IOC was discarded. That is a partial fill, reported as cancelled.
  const order = toPlacedOrder({
    symbol: 'MON-USDC',
    side: 'buy',
    type: 'market',
    timeInForce: 'IOC',
    quantity: 388n * 10n ** 8n,
    params: PARAMS,
    outcome,
    executionHash: RECEIPTS.placeMarket.transactionHash,
    transactionHash: RECEIPTS.placeMarket.transactionHash,
    observedAt: 0,
    blockNumber: 74_000_001,
    quoteDecimals: 6,
    feeAsset: 'USDC',
  });
  assert.equal(order.status, 'cancelled');
  assert.equal(order.filledSize, '317.73742494');
  assert.equal(order.averageFillPrice, '0.030974');
  // 7000 pps of a 9.841599 USDC fill, floored at the atom (SEN-20).
  assert.equal(order.fee, '0.006889');
  assert.equal(order.feeAsset, 'USDC');
  assert.equal(order.blockNumber, 74_000_001);
});

test('another account reads nothing from the same receipts', () => {
  for (const receipt of Object.values(RECEIPTS)) {
    assert.deepEqual(decodeOrderOutcome(receipt.logs, MON_USDC, RECEIPT_ACCOUNT_ID + 1n), {
      fills: [],
      rested: [],
      removed: [],
      takerFeePps: undefined,
    });
  }
});

test('logs emitted by any other contract are ignored', () => {
  for (const receipt of Object.values(RECEIPTS)) {
    const outcome = decodeOrderOutcome(receipt.logs, market('WETH-USDC'), RECEIPT_ACCOUNT_ID);
    assert.equal(outcome.fills.length + outcome.rested.length + outcome.removed.length, 0);
  }
});
