/**
 * Kuru's packed event decoders, ported from `@toxicflow-labs/ts-sdk`
 * (`dist/events/index.js` @ 0.0.4 — src/events/packed.ts) so the indexer
 * has no runtime dependency on the SDK or viem. Kuru packs trade and book
 * records as fixed-width bit fields, not ABI-encoded params, so this is a
 * hand-rolled decoder either way.
 *
 * The field layouts below were pinned against a real fill: tx
 * 0x9d7fbce17b32fb4585612ed292ba064da5e85c0da865edee6dcfb2aefb2d30fd on
 * Monad testnet (docs/kuru.md "placeMarket 388 MON → 317.737 filled").
 * See packed.test.ts.
 */

export type PackedTrade = {
  /** AccountCore id of the maker whose resting order was hit. */
  readonly makerId: bigint;
  readonly slotIdx: number;
  /** Book price units. */
  readonly price: bigint;
  /** Book size units filled. */
  readonly fillSize: bigint;
  readonly orderId: bigint;
  readonly makerIsBuy: boolean;
  readonly makerIsPassive: boolean;
  readonly isMatchEnd: boolean;
  /** Remaining size of the maker order after this match (book units). */
  readonly updatedSize: bigint;
  /** Fee charged to the maker, parts per ten million. */
  readonly makerFeePps: number;
  readonly tradeId: bigint;
};

export type PackedBookUpdate = {
  readonly makerId: bigint;
  readonly slotIdx: number;
  readonly orderId: bigint;
  readonly price: bigint;
  readonly size: bigint;
  readonly makerIsBuy: boolean;
  /** true = the order rests on the book after this update; false = removed. */
  readonly isLive: boolean;
  readonly makerFeePps: number;
};

const MASK_40 = (1n << 40n) - 1n;
const MASK_32 = (1n << 32n) - 1n;
const MASK_96 = (1n << 96n) - 1n;
const MASK_64 = (1n << 64n) - 1n;
const MASK_24 = (1n << 24n) - 1n;

function bytesToBigInt(bytes: Uint8Array, start: number, length: number): bigint {
  let value = 0n;
  for (let i = 0; i < length; i++) {
    value = (value << 8n) | BigInt(bytes[start + i] ?? 0);
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error(`odd hex length: ${hex.slice(0, 10)}…`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function assertPackedLength(bytes: Uint8Array, recordSize: number, label: string): void {
  if (bytes.length % recordSize !== 0) {
    throw new Error(
      `${label} length must be a multiple of ${recordSize} bytes, got ${bytes.length}`,
    );
  }
}

/**
 * First 32 bytes of a trade record / 39-byte book-update record, packed as
 * (word >> bit positions): makerId(40) slotIdx(8) flags(8) price(32)
 * fillSize/size(96) orderId(64).
 */
function decodeFirstPackedWord(bytes: Uint8Array, offset: number) {
  const word = bytesToBigInt(bytes, offset, 32);
  const makerFlags = Number((word >> 200n) & 0xffn);
  return {
    makerId: (word >> 216n) & MASK_40,
    slotIdx: Number((word >> 208n) & 0xffn),
    makerFlags,
    makerIsBuy: (makerFlags & 1) === 1,
    price: (word >> 168n) & MASK_32,
    fillSize: (word >> 72n) & MASK_96,
    orderId: (word >> 8n) & MASK_64,
  };
}

function decodeTradeRecord(bytes: Uint8Array, offset: number): PackedTrade {
  const first = decodeFirstPackedWord(bytes, offset);
  const second = bytesToBigInt(bytes, offset + 32, 32);
  return {
    makerId: first.makerId,
    slotIdx: first.slotIdx,
    price: first.price,
    fillSize: first.fillSize,
    orderId: first.orderId,
    makerIsBuy: first.makerIsBuy,
    makerIsPassive: (first.makerFlags & 2) !== 0,
    isMatchEnd: (first.makerFlags & 4) !== 0,
    updatedSize: (second >> 160n) & MASK_96,
    makerFeePps: Number((second >> 136n) & MASK_24),
    tradeId: second & MASK_64,
  };
}

/** `TradesPacked.packedTrades`: 64-byte records. */
export function decodeTradesPacked(packedTrades: string): PackedTrade[] {
  const bytes = hexToBytes(packedTrades);
  assertPackedLength(bytes, 64, 'TradesPacked.packedTrades');
  const records: PackedTrade[] = [];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    records.push(decodeTradeRecord(bytes, offset));
  }
  return records;
}

/** `BookUpdatesPacked.packedUpdates`: 39-byte records. */
export function decodeBookUpdatesPacked(packedUpdates: string): PackedBookUpdate[] {
  const bytes = hexToBytes(packedUpdates);
  assertPackedLength(bytes, 39, 'BookUpdatesPacked.packedUpdates');
  const records: PackedBookUpdate[] = [];
  for (let offset = 0; offset < bytes.length; offset += 39) {
    const update = decodeFirstPackedWord(bytes, offset);
    records.push({
      makerId: update.makerId,
      slotIdx: update.slotIdx,
      orderId: update.orderId,
      price: update.price,
      size: update.fillSize,
      makerIsBuy: update.makerIsBuy,
      isLive: (update.makerFlags & 128) !== 0,
      makerFeePps: Number(bytesToBigInt(bytes, offset + 36, 3)),
    });
  }
  return records;
}
