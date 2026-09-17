import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBookUpdatesPacked, decodeTradesPacked } from './packed.ts';

/**
 * Real packed payloads from tx
 * 0x9d7fbce17b32fb4585612ed292ba064da5e85c0da865edee6dcfb2aefb2d30fd
 * (Monad testnet block 61406913, MON-USDC IOC sweep of 317.73742494 MON at
 * 0.030974 — docs/kuru.md). The taker's Trade record and the maker's
 * BookUpdates record are pinned here; both were cross-checked against
 * @toxicflow-labs/ts-sdk's own decoder output on the same bytes.
 */
const TRADES_PACKED =
  '0x000000002f0104000078fe000000000000000765dcd59e0000000000000e5f00000000000000000000000000000fa00000000000000000000000000000000062';

test('decodes the real TradesPacked record', () => {
  const [trade] = decodeTradesPacked(TRADES_PACKED);
  assert.ok(trade);
  assert.equal(trade.makerId, 47n); // the resting maker (Sente's earlier probe)
  assert.equal(trade.slotIdx, 1);
  assert.equal(trade.price, 30974n); // book units, ×1e6
  assert.equal(trade.fillSize, 31773742494n); // book units, ×1e8
  assert.equal(trade.orderId, 3679n);
  assert.equal(trade.makerIsBuy, false); // maker sold MON → taker bought
  assert.equal(trade.isMatchEnd, true);
  assert.equal(trade.makerFeePps, 4000);
  assert.equal(trade.tradeId, 98n);
});

test('rejects a buffer that is not a multiple of 64 bytes', () => {
  assert.throws(() => decodeTradesPacked('0x001234'), /multiple of 64/);
});

test('decodes a BookUpdates record for the removal of the swept maker order', () => {
  // 39-byte record built by hand from the same match: maker 47, slot 1,
  // order 3679, price 30974, remaining size 0, flags 0 (removed, sell),
  // minSizeAfterBlock 0, fee 4000 (0x000fa0).
  const hex =
    '0x' +
    '000000002f' + // makerId 47        (5 B)
    '01' + //          slotIdx 1         (1 B)
    '00' + //          flags: removed sell (1 B)
    '000078fe' + //    price 30974       (4 B)
    '000000000000000000000000' + // size 0 (12 B)
    '0000000000000e5f' + // orderId 3679   (8 B)
    '00' + //          packed-word pad    (1 B)
    '00000000' + //     minSizeAfterBlock  (4 B)
    '000fa0'; //       makerFeePps 4000   (3 B)
  const [update] = decodeBookUpdatesPacked(hex);
  assert.ok(update);
  assert.equal(update.makerId, 47n);
  assert.equal(update.slotIdx, 1);
  assert.equal(update.orderId, 3679n);
  assert.equal(update.price, 30974n);
  assert.equal(update.size, 0n);
  assert.equal(update.makerIsBuy, false);
  assert.equal(update.isLive, false);
  assert.equal(update.makerFeePps, 4000);
});
