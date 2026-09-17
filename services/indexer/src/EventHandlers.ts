/**
 * Kuru Spot V2 handlers (Monad testnet, chain 10143).
 *
 * Kuru's OrderBook emits *packed* logs: `TradesPacked.packedTrades` is a
 * flat array of 64-byte bit-packed trade records and `BookUpdatesPacked`
 * holds 39-byte order-lifecycle records — neither is ABI-decodable, so
 * src/lib/packed.ts ports @toxicflow-labs/ts-sdk's decoder and pins it
 * against a real fill (tx 0x9d7fbce1… at block 61406913).
 *
 * One match emits the taker's `TradesPacked` (taker = indexed accountId)
 * with one record per maker filled; each record resolves both leaderboard
 * legs. `BookUpdatesPacked` follows in the same tx for the maker book state.
 */
import { indexer, BigDecimal } from 'envio';
import { decodeBookUpdatesPacked, decodeTradesPacked } from './lib/packed.ts';
import {
  KURU_MARKETS,
  kuruMarketByAddress,
  KURU_ACCOUNT_CORE,
  kuruTokenDecimals,
  NATIVE_TOKEN,
} from './lib/seeds.ts';
import {
  kurbAccountIdUnused,
} from './lib/nothing.ts';
import {
  kuruAccountId,
  kuruQuoteAtoms,
  tradeId,
  yyyymmdd,
  statsId,
} from './lib/stats.ts';
import {
  type Ctx,
  addBd,
  bd,
  ensureAccount,
  recordPartyFill,
} from './lib/common.ts';

/** Seed markets + custody tokens are written once, on first event handled. */
async function ensureKuruMarkets(context: Ctx): Promise<void> {
  for (const m of KURU_MARKETS) {
    if ((await context.Market.get(m.marketId)) === undefined) {
      context.Market.set({
        id: m.marketId,
        venue: 'KURU',
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        pricePrecision: m.pricePrecision,
        sizePrecision: m.sizePrecision,
        baseDecimals: m.baseDecimals,
        quoteDecimals: m.quoteDecimals,
        address: m.address,
        tradeCount: 0,
        volumeUsd: BigDecimal.fromNumber(0),
        latestTradeBlock: undefined,
      });
    }
  }
}

async function bumpMarketAggregates(
  context: Ctx,
  marketId: string,
  notionalBd: BigDecimal,
  blockNumber: number,
): Promise<void> {
  const market = await context.Market.getOrThrow(marketId);
  context.Market.set({
    ...market,
    tradeCount: market.tradeCount + 1,
    volumeUsd: addBd(market.volumeUsd, notionalBd),
    latestTradeBlock: BigInt(blockNumber),
  });
}

async function bumpMarketDay(
  context: Ctx,
  marketId: string,
  args: {
    isBuy: boolean;
    notionalBd: BigDecimal;
    baseBd: BigDecimal;
    priceBd: BigDecimal;
    accountId: string;
    timestampSec: number;
  },
): Promise<void> {
  const day = yyyymmdd(args.timestampSec);
  const id = `${marketId}-${day}`;
  let row = await context.MarketDay.get(id);
  if (row === undefined) {
    row = {
      id,
      market_id: marketId,
      day,
      date: new Date(Math.floor(args.timestampSec / 86_400) * 86_400_000),
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: BigDecimal.fromNumber(0),
      baseVolume: BigDecimal.fromNumber(0),
      highPrice: undefined,
      lowPrice: undefined,
      vwapPrice: undefined,
      activeAccountIds: [],
    };
  }
  const active = row.activeAccountIds.includes(args.accountId)
    ? row.activeAccountIds
    : [...row.activeAccountIds, args.accountId];
  const high = row.highPrice === undefined || args.priceBd.gt(row.highPrice)
    ? args.priceBd
    : row.highPrice;
  const low = row.lowPrice === undefined || args.priceBd.lt(row.lowPrice)
    ? args.priceBd
    : row.lowPrice;
  const volumeUsd = addBd(row.volumeUsd, args.notionalBd);
  const baseVolume = addBd(row.baseVolume, args.baseBd);
  context.MarketDay.set({
    ...row,
    tradeCount: row.tradeCount + 1,
    buyCount: row.buyCount + (args.isBuy ? 1 : 0),
    sellCount: row.sellCount + (args.isBuy ? 0 : 1),
    volumeUsd,
    baseVolume,
    highPrice: high,
    lowPrice: low,
    vwapPrice: baseVolume.isZero() ? undefined : volumeUsd.div(baseVolume),
    activeAccountIds: active,
  });
}

indexer.onEvent(
  { contract: 'KuruOrderBook', event: 'TradesPacked' },
  async ({ event, context }) => {
    const market = kuruMarketByAddress(event.srcAddress);
    if (market === undefined) return; // unknown book — ignore, don't crash
    await ensureKuruMarkets(context);

    const records = decodeTradesPacked(event.params.packedTrades);
    const takerId = kuruAccountId(event.params.accountId);
    const blockNumber = event.block.number;
    const timestampSec = event.block.timestamp;
    const txHash = event.transaction.hash;
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

      const priceBd = bd(rec.price, decimalDigits(market.pricePrecision));
      const notionalBd = bd(quoteAtoms, market.quoteDecimals);

      context.Trade.set({
        id: tradeId(event.chainId, blockNumber, event.logIndex, recordIdx),
        venue: 'KURU',
        market_id: market.marketId,
        side: takerBuy ? 'BUY' : 'SELL',
        rawPrice: rec.price,
        rawSize: rec.fillSize,
        price: priceBd,
        notionalUsd: notionalBd,
        maker_id: makerId,
        taker_id: takerId,
        takerFeeRaw: takerBuy
          ? (quoteAtoms * event.params.effectiveTakerFeePps) / 10_000_000n
          : (quoteAtoms * event.params.effectiveTakerFeePps) / 10_000_000n,
        makerFeeRaw: (quoteAtoms * BigInt(rec.makerFeePps)) / 10_000_000n,
        blockNumber: BigInt(blockNumber),
        timestamp: new Date(timestampSec * 1000),
        txHash,
        logIndex: event.logIndex,
      });

      // taker leg
      await recordPartyFill(context, {
        accountId: takerId,
        marketId: market.marketId,
        venue: 'KURU',
        role: 'taker',
        signedBaseRaw: takerSigned,
        baseDecimals: market.baseDecimals,
        quoteAtoms,
        quoteDecimals: market.quoteDecimals,
        priceBd,
        blockNumber,
        timestampSec,
      });
      // maker leg (mirror direction; same notional)
      await recordPartyFill(context, {
        accountId: makerId,
        marketId: market.marketId,
        venue: 'KURU',
        role: 'maker',
        signedBaseRaw: -takerSigned,
        baseDecimals: market.baseDecimals,
        quoteAtoms,
        quoteDecimals: market.quoteDecimals,
        priceBd,
        blockNumber,
        timestampSec,
      });

      await bumpMarketAggregates(context, market.marketId, notionalBd, blockNumber);
      await bumpMarketDay(context, market.marketId, {
        isBuy: takerBuy,
        notionalBd,
        baseBd: bd(rec.fillSize, decimalDigits(market.sizePrecision)),
        priceBd,
        accountId: takerId,
        timestampSec,
      });
    }
  },
);

indexer.onEvent(
  { contract: 'KuruOrderBook', event: 'BookUpdatesPacked' },
  async ({ event, context }) => {
    const market = kuruMarketByAddress(event.srcAddress);
    if (market === undefined) return;
    await ensureKuruMarkets(context);
    for (const [recordIdx, rec] of decodeBookUpdatesPacked(event.params.packedUpdates).entries()) {
      context.MakerOrderUpdate.set({
        id: tradeId(event.chainId, event.block.number, event.logIndex, recordIdx),
        market_id: market.marketId,
        makerAccountId: String(event.params.accountId),
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

/** Deposit/Withdrawal rails: custody between wallet and AccountCore. */
function balanceHandler(direction: 'deposit' | 'withdrawal') {
  return async ({ event, context }: { event: EnvEvent<'Deposit' | 'Withdrawal'>; context: Ctx }) => {
    const accountId = kuruAccountId(event.params.accountId);
    await ensureAccount(
      context,
      accountId,
      'KURU',
      event.params.accountId,
      event.block.number,
      event.block.timestamp,
    );
    const token = event.params.token.toLowerCase();
    const id = `${accountId}-${token}`;
    let bal = await context.AccountBalance.get(id);
    bal ??= {
      id,
      account_id: accountId,
      token,
      deposited: 0n,
      withdrawn: 0n,
      net: 0n,
      decimals: kuruTokenDecimals(token),
      lastUpdatedBlock: 0n,
    };
    const delta = direction === 'deposit' ? event.params.amount : event.params.amount;
    context.AccountBalance.set({
      ...bal,
      deposited: direction === 'deposit' ? bal.deposited + delta : bal.deposited,
      withdrawn: direction === 'withdrawal' ? bal.withdrawn + delta : bal.withdrawn,
      net:
        direction === 'deposit'
          ? bal.deposited + delta - bal.withdrawn
          : bal.deposited - (bal.withdrawn + delta),
      lastUpdatedBlock: BigInt(event.block.number),
    });
    void KURU_ACCOUNT_CORE;
    void NATIVE_TOKEN;
  };
}

type EnvEvent<N extends 'Deposit' | 'Withdrawal'> = Parameters<
  Parameters<typeof indexer.onEvent>[1] extends (args: infer A) => unknown
    ? N extends 'Deposit'
      ? (args: { event: DepositEvent; context: Ctx }) => unknown
      : (args: { event: WithdrawalEvent; context: Ctx }) => unknown
    : never
> extends [infer _A]
  ? never
  : never;

declare global {
  interface DepositEvent {
    params: { accountId: bigint; token: string; payer: string; amount: bigint };
  }
  interface WithdrawalEvent {
    params: { accountId: bigint; token: string; recipient: string; amount: bigint };
  }
}

indexer.onEvent({ contract: 'KuruAccountCore', event: 'Deposit' }, balanceHandler('deposit'));
indexer.onEvent(
  { contract: 'KuruAccountCore', event: 'Withdrawal' },
  balanceHandler('withdrawal'),
);

/** account ↔ owner mapping. */
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
    const account = await context.Account.getOrThrow(accountId);
    context.Account.set({ ...account, owner: event.params.account.toLowerCase() });
  },
);

function decimalDigits(precision: bigint): number {
  return precision.toString().length - 1;
}
