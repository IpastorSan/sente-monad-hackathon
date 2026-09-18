/**
 * Perpl handlers (Monad testnet, chain 10143) — perp fills.
 *
 * The awkward part is that Perpl's fill events are not self-describing, so the
 * attribution runs across three events in one transaction, in log order:
 *
 *   OrderRequestV2      the aggressor's identity (perpId, accountId) and intent
 *                       (orderType) — written to PerplOrderContext
 *   MakerOrderFilledV2  per maker leg; has perpId+accountId+pricePNS but not
 *                       which side the maker was on → opposite of the taker's
 *   TakerOrderFilledV2  the aggregate fill; has NO perpId and NO accountId
 *
 * Maker fills are stashed in PerplMakerFill so the taker's Trade row can name
 * the maker. Resolution is by log index (see src/lib/perpl.ts, which also
 * records the real transaction this ordering was verified against).
 *
 * Only the taker leg produces a `Trade` row, and only once per match: a
 * multi-maker sweep emits several `MakerOrderFilledV2` but a single
 * `TakerOrderFilledV2`, so taping the makers too would double-count volume.
 * Each maker still gets its own `AccountMarketStats` row from its own event.
 *
 * The vendored ABI in abis/PerplExchange.events.json holds only the events
 * needed here. Perpl also emits `PositionDecreased`, whose `deltaPnlCNS` is the
 * exchange's own realised PnL — the authority a leaderboard should ultimately
 * use. It is deliberately not indexed yet; see docs/indexer.md §perpl.
 */
import { indexer } from 'envio';
import {
  PERP_COLLATERAL_DECIMALS,
  PERPL_COLLATERAL,
  perplMarketId,
  perplMarketSeedByPerpId,
  perplMarketSeedFromContract,
} from '../lib/seeds.ts';
import { decimalsFromPrecision, perplAccountId, perplQuoteAtoms, tradeId } from '../lib/stats.ts';
import {
  perplFillPricePns,
  perplSide,
  selectFirstMakerFill,
  selectOrderIntent,
} from '../lib/perpl.ts';
import { bumpMarket, ensureMarket, ensurePerplMarkets, recordMarketDay } from '../lib/markets.ts';
import {
  bd,
  ensureAccount,
  ensureBalance,
  recordPartyFill,
  setAccountAddress,
} from '../lib/common.ts';

/** "<chainId>-<blockNumber>-<logIndex>" — the log's own identity. */
const logKey = (chainId: number, blockNumber: number, logIndex: number): string =>
  `${chainId}-${blockNumber}-${logIndex}`;

indexer.onEvent(
  { contract: 'PerplExchange', event: 'OrderRequestV2' },
  async ({ event, context }) => {
    const accountId = perplAccountId(event.params.accountId);
    await ensureAccount(
      context,
      accountId,
      'PERPL',
      event.params.accountId,
      event.block.number,
      event.block.timestamp,
    );
    // Stored, not interpreted here: whether this order ever fills is only known
    // to the fill events that follow.
    context.PerplOrderContext.set({
      id: logKey(event.chainId, event.block.number, event.logIndex),
      txHash: event.transaction.hash,
      perpId: event.params.perpId,
      accountId: event.params.accountId,
      orderId: event.params.orderId,
      orderType: Number(event.params.orderType),
      blockNumber: BigInt(event.block.number),
      logIndex: event.logIndex,
    });
  },
);

indexer.onEvent(
  { contract: 'PerplExchange', event: 'MakerOrderFilledV2' },
  async ({ event, context }) => {
    await ensurePerplMarkets(context);
    const market = perplMarketSeedByPerpId(event.params.perpId);
    if (market === undefined) {
      context.log.warn('MakerOrderFilledV2 for an unseeded perpetual — skipped', {
        perpId: event.params.perpId.toString(),
      });
      return;
    }
    const accountId = perplAccountId(event.params.accountId);
    await ensureAccount(
      context,
      accountId,
      'PERPL',
      event.params.accountId,
      event.block.number,
      event.block.timestamp,
    );

    // Stash for the taker fill that follows in this same transaction.
    context.PerplMakerFill.set({
      id: logKey(event.chainId, event.block.number, event.logIndex),
      txHash: event.transaction.hash,
      perpId: event.params.perpId,
      accountId: event.params.accountId,
      feeCns: event.params.feeCNS,
      logIndex: event.logIndex,
    });

    // The maker's own stats row. Its side is the opposite of the taker it
    // filled, which only the request can tell us.
    const intents = await context.PerplOrderContext.getWhere({
      txHash: { _eq: event.transaction.hash },
    });
    const intent = selectOrderIntent(intents, event.logIndex);
    if (intent === undefined || intent.perpId !== event.params.perpId) {
      context.log.warn('MakerOrderFilledV2 with no resolvable taker request — stats skipped', {
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
      });
      return;
    }
    const takerSide = perplSide(intent.orderType);
    if (takerSide === undefined) {
      context.log.warn('MakerOrderFilledV2 behind a non-order-type request — stats skipped', {
        txHash: event.transaction.hash,
        orderType: intent.orderType,
      });
      return;
    }
    const lotLns = event.params.lotLNS;
    if (lotLns === 0n) return;
    await recordPartyFill(context, {
      accountId,
      marketId: market.marketId,
      venue: 'PERPL',
      role: 'maker',
      signedBaseRaw: takerSide === 'BUY' ? -lotLns : lotLns,
      baseUnitDecimals: decimalsFromPrecision(market.sizePrecision),
      quoteAtoms: perplQuoteAtoms(
        event.params.pricePNS,
        lotLns,
        decimalsFromPrecision(market.pricePrecision),
        decimalsFromPrecision(market.sizePrecision),
        PERP_COLLATERAL_DECIMALS,
      ),
      quoteDecimals: PERP_COLLATERAL_DECIMALS,
      blockNumber: event.block.number,
      timestampSec: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: 'PerplExchange', event: 'TakerOrderFilledV2' },
  async ({ event, context }) => {
    await ensurePerplMarkets(context);
    const intents = await context.PerplOrderContext.getWhere({
      txHash: { _eq: event.transaction.hash },
    });
    const intent = selectOrderIntent(intents, event.logIndex);
    if (intent === undefined) {
      // Without the request there is no perpId, no accountId and no side —
      // there is nothing to attribute the fill to.
      context.log.warn('TakerOrderFilledV2 with no preceding OrderRequestV2 in tx — skipped', {
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
      });
      return;
    }
    const market = perplMarketSeedByPerpId(intent.perpId);
    if (market === undefined) {
      context.log.warn('TakerOrderFilledV2 for an unseeded perpetual — skipped', {
        perpId: intent.perpId.toString(),
      });
      return;
    }
    const side = perplSide(intent.orderType);
    if (side === undefined) {
      // A value outside 0-3 cannot be an order the contract fills. Resolving
      // one means the intent join picked the wrong request, so the fill is
      // reported rather than attributed to the wrong side.
      context.log.warn('TakerOrderFilledV2 resolved to an unknown order type — skipped', {
        txHash: event.transaction.hash,
        orderType: intent.orderType,
      });
      return;
    }

    const takerId = perplAccountId(intent.accountId);
    await ensureAccount(
      context,
      takerId,
      'PERPL',
      intent.accountId,
      event.block.number,
      event.block.timestamp,
    );

    const lotLns = event.params.lotLNS;
    if (lotLns === 0n) return;
    const takerBuy = side === 'BUY';
    const pricePns = perplFillPricePns({
      pnlPricePns: event.params.pnlPricePNS,
      collatPricePns: event.params.collatPricePNS,
      entryPricePns: event.params.entryPricePNS,
    });
    const quoteAtoms = perplQuoteAtoms(
      pricePns,
      lotLns,
      decimalsFromPrecision(market.pricePrecision),
      decimalsFromPrecision(market.sizePrecision),
      PERP_COLLATERAL_DECIMALS,
    );
    const priceBd = bd(pricePns, decimalsFromPrecision(market.pricePrecision));
    const notionalBd = bd(quoteAtoms, PERP_COLLATERAL_DECIMALS);

    const makerFills = await context.PerplMakerFill.getWhere({
      txHash: { _eq: event.transaction.hash },
    });
    const firstMaker = selectFirstMakerFill(makerFills, event.logIndex);
    let makerId: string | undefined;
    if (firstMaker !== undefined && firstMaker.perpId === intent.perpId) {
      makerId = perplAccountId(firstMaker.accountId);
      await ensureAccount(
        context,
        makerId,
        'PERPL',
        firstMaker.accountId,
        event.block.number,
        event.block.timestamp,
      );
    }

    context.Trade.set({
      id: tradeId(event.chainId, event.block.number, event.logIndex, 0),
      venue: 'PERPL',
      market_id: market.marketId,
      side,
      rawPrice: pricePns,
      rawSize: lotLns,
      price: priceBd,
      notionalUsd: notionalBd,
      maker_id: makerId,
      taker_id: takerId,
      takerFeeRaw: event.params.feeCNS,
      // The maker's fee rides on its own event; 0 when no maker was resolved.
      makerFeeRaw: firstMaker?.feeCns ?? 0n,
      blockNumber: BigInt(event.block.number),
      timestamp: new Date(event.block.timestamp * 1000),
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });

    await recordPartyFill(context, {
      accountId: takerId,
      marketId: market.marketId,
      venue: 'PERPL',
      role: 'taker',
      signedBaseRaw: takerBuy ? lotLns : -lotLns,
      baseUnitDecimals: decimalsFromPrecision(market.sizePrecision),
      quoteAtoms,
      quoteDecimals: PERP_COLLATERAL_DECIMALS,
      blockNumber: event.block.number,
      timestampSec: event.block.timestamp,
    });

    await bumpMarket(context, market.marketId, notionalBd, event.block.number);
    await recordMarketDay(context, {
      marketId: market.marketId,
      isBuy: takerBuy,
      notionalBd,
      baseBd: bd(lotLns, decimalsFromPrecision(market.sizePrecision)),
      priceBd,
      accountIds: makerId === undefined ? [takerId] : [takerId, makerId],
      timestampSec: event.block.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: 'PerplExchange', event: 'AccountCreated' },
  async ({ event, context }) => {
    const accountId = perplAccountId(event.params.id);
    await ensureAccount(
      context,
      accountId,
      'PERPL',
      event.params.id,
      event.block.number,
      event.block.timestamp,
    );
    await setAccountAddress(context, accountId, event.params.account);
  },
);

/** Cumulative wallet↔Exchange collateral flow, one direction per handler. */
async function applyCollateralFlow(
  context: import('envio').EvmOnEventContext,
  direction: 'deposit' | 'withdrawal',
  accountIdRaw: bigint,
  amountCns: bigint,
  balanceCns: bigint,
  blockNumber: number,
  timestampSec: number,
): Promise<void> {
  const accountId = perplAccountId(accountIdRaw);
  await ensureAccount(context, accountId, 'PERPL', accountIdRaw, blockNumber, timestampSec);
  const balance = await ensureBalance(
    context,
    accountId,
    PERPL_COLLATERAL,
    PERP_COLLATERAL_DECIMALS,
  );
  const deposited = balance.deposited + (direction === 'deposit' ? amountCns : 0n);
  const withdrawn = balance.withdrawn + (direction === 'withdrawal' ? amountCns : 0n);
  context.AccountBalance.set({
    ...balance,
    deposited,
    withdrawn,
    net: deposited - withdrawn,
    // balanceCNS is absolute, so it is the balance rather than a sum. The
    // locked portion is not on these events; reserved stays 0 for Perpl.
    freeRaw: balanceCns,
    reservedRaw: 0n,
    lastUpdatedBlock: BigInt(blockNumber),
  });
}

indexer.onEvent(
  { contract: 'PerplExchange', event: 'CollateralDeposit' },
  async ({ event, context }) => {
    await applyCollateralFlow(
      context,
      'deposit',
      event.params.accountId,
      event.params.amountCNS,
      event.params.balanceCNS,
      event.block.number,
      event.block.timestamp,
    );
  },
);

indexer.onEvent(
  { contract: 'PerplExchange', event: 'CollateralWithdrawal' },
  async ({ event, context }) => {
    await applyCollateralFlow(
      context,
      'withdrawal',
      event.params.accountId,
      event.params.amountCNS,
      event.params.balanceCNS,
      event.block.number,
      event.block.timestamp,
    );
  },
);

/**
 * A perpetual listed inside the indexed range. Seeded markets are left alone —
 * `ensureMarket` is a no-op when the row exists, so a differing off-chain
 * snapshot cannot overwrite what the chain reported.
 */
indexer.onEvent(
  { contract: 'PerplExchange', event: 'ContractAdded' },
  async ({ event, context }) => {
    await ensureMarket(
      context,
      perplMarketSeedFromContract(
        event.params.perpId,
        event.params.symbol,
        event.params.priceDecimals,
        event.params.lotDecimals,
      ),
    );
    context.log.info('Perpl perpetual added inside the indexed range', {
      perpId: event.params.perpId.toString(),
      symbol: event.params.symbol,
      marketId: perplMarketId(event.params.perpId),
    });
  },
);
