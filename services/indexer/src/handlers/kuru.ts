/**
 * Kuru Spot V2 handlers (Monad testnet, chain 10143).
 *
 * Kuru's OrderBook emits *packed* logs: `TradesPacked.packedTrades` is a flat
 * array of 64-byte bit-packed trade records and `BookUpdatesPacked` holds
 * 39-byte order-lifecycle records — neither is ABI-decodable, so src/lib/packed.ts
 * ports @toxicflow-labs/ts-sdk's decoder and pins it against a real fill
 * (tx 0x9d7fbce1… at block 61406913; see src/lib/packed.test.ts).
 *
 * One match emits the taker's `TradesPacked` (taker = the indexed accountId)
 * with one record per maker filled; each record resolves both leaderboard legs.
 * `BookUpdatesPacked` follows in the same tx for the maker book state.
 *
 * Custody comes off AccountCore, in three independent readings:
 *   SpotReserveUpdated  absolute free/reserved per (account, token) — the balance
 *   Deposit/Withdrawal  cumulative wallet↔venue flow
 *   AccountRegistered   account id → account address, and the owner
 */
import { indexer } from 'envio';
import { decodeBookUpdatesPacked, decodeTradesPacked } from '../lib/packed.ts';
import { kuruMarketByAddress, kuruTokenDecimals } from '../lib/seeds.ts';
import {
  decimalsFromPrecision,
  kuruAccountId,
  kuruQuoteAtoms,
  tradeId,
} from '../lib/stats.ts';
import { bumpMarket, ensureKuruMarkets, recordMarketDay } from '../lib/markets.ts';
import {
  type Ctx,
  type FillInput,
  bd,
  ensureAccount,
  ensureBalance,
  recordPartyFill,
  setAccountAddress,
  setAccountOwner,
} from '../lib/common.ts';

/** Kuru's fee denominator: parts per ten million. */
const PPS = 10_000_000n;

indexer.onEvent({ contract: 'KuruOrderBook', event: 'TradesPacked' }, async ({ event, context }) => {
  const market = kuruMarketByAddress(event.srcAddress);
  if (market === undefined) {
    // A book we never seeded. Guessing its precision would silently corrupt
    // every USD figure downstream, so refuse instead.
    context.log.warn('TradesPacked from unseeded order book — skipped', {
      srcAddress: event.srcAddress,
    });
    return;
  }
  await ensureKuruMarkets(context);

  const records = decodeTradesPacked(event.params.packedTrades);
  const takerId = kuruAccountId(event.params.accountId);
  const { number: blockNumber, timestamp: timestampSec } = event.block;
  const txHash = event.transaction.hash;
  const logIndex = event.logIndex;
  // Raw book units → human base is the *book* size scale (10^8 on MON-USDC),
  // not the base token's ERC-20 decimals; see decimalsFromPrecision.
  const baseUnitDecimals = decimalsFromPrecision(market.sizePrecision);
  const priceDecimals = decimalsFromPrecision(market.pricePrecision);
  await ensureAccount(context, takerId, 'KURU', event.params.accountId, blockNumber, timestampSec);

  for (const [recordIdx, rec] of records.entries()) {
    if (rec.fillSize === 0n) continue; // zero-fill bookkeeping record
    const quoteAtoms = kuruQuoteAtoms(
      rec.price,
      rec.fillSize,
      market.pricePrecision,
      market.sizePrecision,
      market.quoteDecimals,
    );
    // makerIsBuy=true → the maker bought, so the taker sold (and vice versa)
    const takerBuy = !rec.makerIsBuy;
    const takerSigned = takerBuy ? rec.fillSize : -rec.fillSize;
    const makerId = kuruAccountId(rec.makerId);
    await ensureAccount(context, makerId, 'KURU', rec.makerId, blockNumber, timestampSec);

    const priceBd = bd(rec.price, priceDecimals);
    const notionalBd = bd(quoteAtoms, market.quoteDecimals);

    context.Trade.set({
      id: tradeId(event.chainId, blockNumber, logIndex, recordIdx),
      venue: 'KURU',
      market_id: market.marketId,
      side: takerBuy ? 'BUY' : 'SELL',
      rawPrice: rec.price,
      rawSize: rec.fillSize,
      price: priceBd,
      notionalUsd: notionalBd,
      maker_id: makerId,
      taker_id: takerId,
      takerFeeRaw: (quoteAtoms * event.params.effectiveTakerFeePps) / PPS,
      makerFeeRaw: (quoteAtoms * BigInt(rec.makerFeePps)) / PPS,
      blockNumber: BigInt(blockNumber),
      timestamp: new Date(timestampSec * 1000),
      txHash,
      logIndex,
    });

    const leg: Omit<FillInput, 'accountId' | 'role' | 'signedBaseRaw'> = {
      marketId: market.marketId,
      venue: 'KURU',
      baseUnitDecimals,
      quoteAtoms,
      quoteDecimals: market.quoteDecimals,
      blockNumber,
      timestampSec,
    };
    // Both legs of the match: the taker's direction is the record's, the
    // maker's is its mirror.
    await recordPartyFill(context, {
      ...leg,
      accountId: takerId,
      role: 'taker',
      signedBaseRaw: takerSigned,
    });
    await recordPartyFill(context, {
      ...leg,
      accountId: makerId,
      role: 'maker',
      signedBaseRaw: -takerSigned,
    });

    await bumpMarket(context, market.marketId, notionalBd, blockNumber);
    await recordMarketDay(context, {
      marketId: market.marketId,
      isBuy: takerBuy,
      notionalBd,
      baseBd: bd(rec.fillSize, baseUnitDecimals),
      priceBd,
      accountIds: [takerId, makerId],
      timestampSec,
    });
  }
});

indexer.onEvent(
  { contract: 'KuruOrderBook', event: 'BookUpdatesPacked' },
  async ({ event, context }) => {
    const market = kuruMarketByAddress(event.srcAddress);
    if (market === undefined) {
      context.log.warn('BookUpdatesPacked from unseeded order book — skipped', {
        srcAddress: event.srcAddress,
      });
      return;
    }
    await ensureKuruMarkets(context);
    for (const [recordIdx, rec] of decodeBookUpdatesPacked(event.params.packedUpdates).entries()) {
      context.MakerOrderUpdate.set({
        id: tradeId(event.chainId, event.block.number, event.logIndex, recordIdx),
        market_id: market.marketId,
        makerAccountId: String(rec.makerId),
        slotIdx: rec.slotIdx,
        orderId: rec.orderId,
        priceRaw: rec.price,
        sizeRaw: rec.size,
        isBuy: rec.makerIsBuy,
        isLive: rec.isLive,
        blockNumber: BigInt(event.block.number),
        timestamp: new Date(event.block.timestamp * 1000),
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
      });
    }
  },
);

/**
 * Absolute free/reserved balances per (account, token). Emitted on every
 * custody change *and* every fill, which is what makes it the balance rather
 * than a running sum — a dropped delta is corrected by the next event.
 */
indexer.onEvent(
  { contract: 'KuruAccountCore', event: 'SpotReserveUpdated' },
  async ({ event, context }) => {
    const accountId = kuruAccountId(event.params.userId);
    await ensureAccount(
      context,
      accountId,
      'KURU',
      event.params.userId,
      event.block.number,
      event.block.timestamp,
    );
    const token = event.params.token.toLowerCase();
    const balance = await ensureBalance(context, accountId, token, kuruTokenDecimals(token));
    context.AccountBalance.set({
      ...balance,
      freeRaw: event.params.freeBalance,
      reservedRaw: event.params.reservedBalance,
      lastUpdatedBlock: BigInt(event.block.number),
    });
  },
);

/** Cumulative wallet↔AccountCore flow. Deposit and Withdrawal differ only here. */
async function applyCustodyFlow(
  context: Ctx,
  direction: 'deposit' | 'withdrawal',
  accountIdRaw: bigint,
  tokenRaw: string,
  amount: bigint,
  blockNumber: number,
  timestampSec: number,
): Promise<void> {
  const accountId = kuruAccountId(accountIdRaw);
  await ensureAccount(context, accountId, 'KURU', accountIdRaw, blockNumber, timestampSec);
  const token = tokenRaw.toLowerCase();
  const balance = await ensureBalance(context, accountId, token, kuruTokenDecimals(token));
  const deposited = balance.deposited + (direction === 'deposit' ? amount : 0n);
  const withdrawn = balance.withdrawn + (direction === 'withdrawal' ? amount : 0n);
  context.AccountBalance.set({
    ...balance,
    deposited,
    withdrawn,
    net: deposited - withdrawn,
    lastUpdatedBlock: BigInt(blockNumber),
  });
}

indexer.onEvent({ contract: 'KuruAccountCore', event: 'Deposit' }, async ({ event, context }) => {
  await applyCustodyFlow(
    context,
    'deposit',
    event.params.accountId,
    event.params.token,
    event.params.amount,
    event.block.number,
    event.block.timestamp,
  );
});

indexer.onEvent(
  { contract: 'KuruAccountCore', event: 'Withdrawal' },
  async ({ event, context }) => {
    await applyCustodyFlow(
      context,
      'withdrawal',
      event.params.accountId,
      event.params.token,
      event.params.amount,
      event.block.number,
      event.block.timestamp,
    );
  },
);

/** account id → account address, and the owner the contract names. */
indexer.onEvent(
  { contract: 'KuruAccountCore', event: 'AccountRegistered' },
  async ({ event, context }) => {
    const accountId = kuruAccountId(event.params.accountId);
    await ensureAccount(
      context,
      accountId,
      'KURU',
      event.params.accountId,
      event.block.number,
      event.block.timestamp,
    );
    // `account` is the address that holds the id and trades — the address a
    // Sente user is matched on. `owner` is a separate field on the same event.
    // Both are stored; neither is inferred from the other.
    await setAccountAddress(context, accountId, event.params.account);
    await setAccountOwner(context, accountId, event.params.owner);
  },
);
