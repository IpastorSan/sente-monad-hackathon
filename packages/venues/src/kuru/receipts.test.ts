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
import { toMakerFill, toPlacedOrder } from './mapping.ts';
import {
  decodeMakerFills,
  decodeOrderOutcome,
  type KuruChainLog,
  type KuruLog,
  type KuruMarketParams,
} from './orders.ts';
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

/** A receipt's logs as `eth_getLogs` returns them: located in a block. */
function located(
  receipt: {
    readonly transactionHash: KuruChainLog['transactionHash'];
    readonly logs: readonly KuruLog[];
  },
  blockNumber: bigint,
): KuruChainLog[] {
  return receipt.logs.map((log, logIndex) => ({
    ...log,
    transactionHash: receipt.transactionHash,
    logIndex,
    blockNumber,
  }));
}

test('the same IOC read from the maker side: its resting ask filled later (SEN-149)', () => {
  const fills = decodeMakerFills(located(RECEIPTS.placeMarket, 61_406_913n), MON_USDC);
  assert.equal(fills.length, 1);
  const fill = fills[0]!;
  // Account 47's ask 1:3679 was swept whole by account 62's IOC.
  assert.equal(fill.makerId, 47n);
  assert.equal(fill.slotIdx, 1);
  assert.equal(fill.orderId, 3679n);
  assert.equal(fill.remaining, 0n);
  assert.equal(fill.tradeId, 98n);
  assert.equal(fill.blockNumber, 61_406_913n);

  const monUsdc = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
  const decimals = toMakerFill(fill, monUsdc);
  assert.equal(decimals.orderId, '1:3679');
  assert.equal(decimals.side, 'sell');
  assert.equal(decimals.price, '0.030974');
  assert.equal(decimals.size, '317.73742494');
  assert.equal(decimals.remainingSize, '0');
  // The record's own maker rate, 4000 pps, of 9.841599 USDC, floored at the atom.
  assert.equal(decimals.fee, '0.003936');
  assert.equal(decimals.feeAsset, 'USDC');
});

test('maker fills: another book, a pending log, a placement or a cancel read nothing', () => {
  assert.deepEqual(decodeMakerFills(located(RECEIPTS.placeMarket, 1n), market('WETH-USDC')), []);
  const pending = located(RECEIPTS.placeMarket, 1n).map((log) => ({ ...log, logIndex: null }));
  assert.deepEqual(decodeMakerFills(pending, MON_USDC), []);
  for (const receipt of [RECEIPTS.placeLimit, RECEIPTS.cancel]) {
    assert.deepEqual(decodeMakerFills(located(receipt, 1n), MON_USDC), []);
  }
});
