/**
 * Tests for the Perpl attribution rules.
 *
 * The ordering and enum expectations here are not invented — they replay tx
 * 0xd58c92adeb7a58603a8ccb14599477de289bb1f03148039328a018fc40aad070 on Monad
 * testnet (block 63311165), read off the chain with `eth_getTransactionReceipt`.
 * If Perpl ever renumbers `OrderDescEnum` or reorders these events, these fail
 * rather than silently flipping every trade's side.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERPL_ORDER_TYPE,
  perplFillPricePns,
  perplSide,
  selectFirstMakerFill,
  selectOrderIntent,
  type PerplMakerFillRef,
  type PerplOrderIntent,
} from './perpl.ts';

const TX = '0xd58c92adeb7a58603a8ccb14599477de289bb1f03148039328a018fc40aad070';

/** The real `OrderRequestV2` at logIndex 68 of the transaction above. */
const INTENT: PerplOrderIntent = {
  txHash: TX,
  logIndex: 68,
  perpId: 16n,
  accountId: 2n,
  orderType: 1, // OpenShort — the taker sold into a long and reduced it
};

/** The real `MakerOrderFilledV2` at logIndex 70. */
const MAKER_FILL: PerplMakerFillRef = {
  logIndex: 70,
  perpId: 16n,
  accountId: 1n,
  feeCns: 0n,
};

test('OrderDescEnum is zero-based and maps to the SDK side()', () => {
  // Mirrors `OrderType::side()` in PerplFoundation/dex-sdk:
  //   OpenLong | CloseShort => Bid, OpenShort | CloseLong => Ask
  assert.equal(PERPL_ORDER_TYPE.openLong, 0);
  assert.equal(PERPL_ORDER_TYPE.openShort, 1);
  assert.equal(PERPL_ORDER_TYPE.closeLong, 2);
  assert.equal(PERPL_ORDER_TYPE.closeShort, 3);

  assert.equal(perplSide(0), 'BUY'); // OpenLong
  assert.equal(perplSide(1), 'SELL'); // OpenShort
  assert.equal(perplSide(2), 'SELL'); // CloseLong
  assert.equal(perplSide(3), 'BUY'); // CloseShort
});

test('an order type outside 0-3 has no side', () => {
  // The one-off-by-one bug this guards: treating 1 as OpenLong, or 4 as
  // CloseShort, inverts the side (and the PnL sign) of every Perpl trade.
  for (const bogus of [-1, 4, 5, 6, 7, 255]) {
    assert.equal(perplSide(bogus), undefined, `orderType ${bogus}`);
  }
});

test('the real taker fill is attributed to its preceding request', () => {
  // Log order of the real transaction: 68 request, 70 maker, 72 taker.
  const intent = selectOrderIntent([INTENT], 72);
  assert.equal(intent?.accountId, 2n);
  assert.equal(intent?.perpId, 16n);
  // orderType 1 = OpenShort = ask. The taker's long went 1383623 → 1383035
  // (down 588 = lotLNS) on chain, which is only consistent with a sell.
  assert.equal(perplSide(intent!.orderType), 'SELL');
});

test('a request after the fill is not matched to it', () => {
  const later: PerplOrderIntent = { ...INTENT, logIndex: 80, accountId: 9n };
  // A request that comes *after* the fill cannot have produced it.
  assert.equal(selectOrderIntent([later], 72), undefined);
  // With both present, the earlier one wins until the later fill.
  assert.equal(selectOrderIntent([INTENT, later], 72)?.accountId, 2n);
  assert.equal(selectOrderIntent([INTENT, later], 81)?.accountId, 9n);
  // Nothing precedes a request's own log index.
  assert.equal(selectOrderIntent([INTENT], 68), undefined);
  assert.equal(selectOrderIntent([], 72), undefined);
});

test('a keeper batch resolves each fill to its nearest preceding request', () => {
  const second: PerplOrderIntent = { ...INTENT, logIndex: 100, accountId: 7n };
  assert.equal(selectOrderIntent([INTENT, second], 101)?.accountId, 7n);
  assert.equal(selectOrderIntent([INTENT, second], 99)?.accountId, 2n);
});

test('the taker fill names the first maker fill in the transaction', () => {
  const secondMaker: PerplMakerFillRef = { ...MAKER_FILL, logIndex: 76, accountId: 5n };
  assert.equal(selectFirstMakerFill([MAKER_FILL], 72)?.accountId, 1n);
  // Lowest logIndex wins, whatever order the rows come back in.
  assert.equal(selectFirstMakerFill([secondMaker, MAKER_FILL], 72)?.accountId, 1n);
  assert.equal(selectFirstMakerFill([MAKER_FILL], 70), undefined);
});

test('the fill price prefers pnlPricePNS and never falls through to zero', () => {
  // All three read 768109 in the real transaction; the maker's pricePNS did too.
  assert.equal(
    perplFillPricePns({ pnlPricePns: 768109n, collatPricePns: 768109n, entryPricePns: 768109n }),
    768109n,
  );
  assert.equal(
    perplFillPricePns({ pnlPricePns: 0n, collatPricePns: 700000n, entryPricePns: 690000n }),
    700000n,
  );
  assert.equal(
    perplFillPricePns({ pnlPricePns: 0n, collatPricePns: 0n, entryPricePns: 690000n }),
    690000n,
  );
});
