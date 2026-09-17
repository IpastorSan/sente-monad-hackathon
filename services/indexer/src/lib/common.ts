/**
 * Handler-side helpers shared by the Kuru and Perpl registration files.
 * All accumulation is read-modify-write on stored entities; every handler
 * batches its writes per entity so no read-your-write assumption is needed
 * within a single handler invocation (see docs/indexer.md §consistency).
 */
import { BigDecimal, type EvmOnEventContext } from 'envio';
import { applyFill, statsId } from './stats.ts';

export type Ctx = EvmOnEventContext;

/** exact decimal string for `atoms` at `decimals` places */
export function humanString(atoms: bigint, decimals: number): string {
  const neg = atoms < 0n;
  let s = (neg ? -atoms : atoms).toString().padStart(decimals + 1, '0');
  if (decimals > 0) {
    s = s.slice(0, -decimals) + '.' + s.slice(-decimals);
  }
  return (neg ? '-' : '') + s;
}

export function bd(atoms: bigint, decimals: number): BigDecimal {
  return BigDecimal.fromRawString(humanString(atoms, decimals));
}

export function addBd(a: BigDecimal, b: BigDecimal): BigDecimal {
  return a.plus(b);
}

export async function ensureAccount(
  context: Ctx,
  id: string,
  venue: 'KURU' | 'PERPL',
  accountId: bigint,
  blockNumber: number,
  timestampSec: number,
): Promise<void> {
  const existing = await context.Account.get(id);
  if (existing !== undefined) return;
  context.Account.set({
    id,
    venue,
    accountId,
    owner: undefined,
    firstSeenBlock: BigInt(blockNumber),
    firstSeenAt: new Date(timestampSec * 1000),
    totalTradeCount: 0,
    totalVolumeUsd: BigDecimal.fromNumber(0),
    realizedPnlUsd: BigDecimal.fromNumber(0),
    winningTradeCount: 0,
    losingTradeCount: 0,
  });
}

/** One accounted fill for one party (taker or maker) on one market. */
export type FillInput = {
  accountId: string; // "kuru-62" | "perpl-7"
  marketId: string;
  venue: 'KURU' | 'PERPL';
  role: 'taker' | 'maker';
  /** signed base raw units (+ buy, − sell) from this party's perspective */
  signedBaseRaw: bigint;
  baseDecimals: number; // human decimals of the base raw unit
  /** quote atoms exchanged (non-negative, venue-native decimals) */
  quoteAtoms: bigint;
  quoteDecimals: number;
  /** human-readable price for the market/day aggregates */
  priceBd: BigDecimal;
  blockNumber: number;
  timestampSec: number;
};

export async function recordPartyFill(
  context: Ctx,
  fill: FillInput,
): Promise<{ realizedAtoms: bigint; reduces: boolean }> {
  await ensureAccount(
    context,
    fill.accountId,
    fill.venue,
    BigInt(fill.accountId.split('-')[1]!),
    fill.blockNumber,
    fill.timestampSec,
  );
  const id = statsId(fill.accountId, fill.marketId);
  let stats = await context.AccountMarketStats.get(id);
  const created: import('envio').AccountMarketStats = {
    id,
    account_id: fill.accountId,
    market_id: fill.marketId,
    n: 0,
    takerN: 0,
    makerN: 0,
    volumeUsd: BigDecimal.fromNumber(0),
    boughtBase: BigDecimal.fromNumber(0),
    soldBase: BigDecimal.fromNumber(0),
    realizedPnlUsd: BigDecimal.fromNumber(0),
    wins: 0,
    losses: 0,
    openBaseRaw: 0n,
    openCostRaw: 0n,
    firstTradeBlock: BigInt(fill.blockNumber),
    lastTradeBlock: BigInt(fill.blockNumber),
  };
  stats ??= created;

  const pos = applyFill(
    { baseRaw: stats.openBaseRaw, costRaw: stats.openCostRaw },
    fill.signedBaseRaw,
    fill.quoteAtoms,
  );
  const baseAbs = fill.signedBaseRaw < 0n ? -fill.signedBaseRaw : fill.signedBaseRaw;
  const bought = fill.signedBaseRaw > 0n ? baseAbs : 0n;
  const sold = fill.signedBaseRaw < 0n ? baseAbs : 0n;
  stats = {
    ...stats,
    n: stats.n + 1,
    takerN: stats.takerN + (fill.role === 'taker' ? 1 : 0),
    makerN: stats.makerN + (fill.role === 'maker' ? 1 : 0),
    volumeUsd: addBd(stats.volumeUsd, bd(fill.quoteAtoms, fill.quoteDecimals)),
    boughtBase: addBd(stats.boughtBase, bd(bought, fill.baseDecimals)),
    soldBase: addBd(stats.soldBase, bd(sold, fill.baseDecimals)),
    realizedPnlUsd: addBd(stats.realizedPnlUsd, bd(pos.realizedRaw, fill.quoteDecimals)),
    wins: stats.wins + (pos.reduces && pos.realizedRaw > 0n ? 1 : 0),
    losses: stats.losses + (pos.reduces && pos.realizedRaw < 0n ? 1 : 0),
    openBaseRaw: pos.baseRaw,
    openCostRaw: pos.costRaw,
    lastTradeBlock: BigInt(fill.blockNumber),
  };
  context.AccountMarketStats.set(stats);

  const account = await context.Account.getOrThrow(fill.accountId);
  context.Account.set({
    ...account,
    totalTradeCount: account.totalTradeCount + 1,
    totalVolumeUsd: addBd(account.totalVolumeUsd, bd(fill.quoteAtoms, fill.quoteDecimals)),
    realizedPnlUsd: addBd(
      account.realizedPnlUsd,
      bd(pos.realizedRaw, fill.quoteDecimals),
    ),
    winningTradeCount: account.winningTradeCount + (pos.reduces && pos.realizedRaw > 0n ? 1 : 0),
    losingTradeCount: account.losingTradeCount + (pos.reduces && pos.realizedRaw < 0n ? 1 : 0),
  });
  return { realizedAtoms: pos.realizedRaw, reduces: pos.reduces };
}

/** Base human amount from raw book/LNS units (sizePrecision = 10^sd). */
export function baseBd(rawBase: bigint, sizePrecision: bigint): BigDecimal {
  const scale = sizePrecision.toString().length - 1; // 10^8 → 8
  return bd(rawBase, scale);
}
