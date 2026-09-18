/**
 * Handler-side helpers shared by the Kuru and Perpl registration files.
 *
 * Every accumulation here is a read-modify-write on a stored entity, and every
 * handler batches its writes per entity, so no read-your-write assumption is
 * needed *within* a handler invocation. Across handlers Envio does make
 * uncommitted in-batch writes visible to `getWhere` (LoadLayer consults the
 * in-memory index before storage), which the Perpl attribution relies on — see
 * src/lib/perpl.ts.
 *
 * `BigDecimal` is Envio's re-export of bignumber.js. Note what it does *not*
 * have: `BigDecimal.fromNumber` / `fromRawString` do not exist on bignumber.js
 * 9.x, so every value is built from an exact decimal *string*. Construction and
 * addition are exact; only division rounds, and it is rounded explicitly with
 * `.decimalPlaces(n)` rather than by mutating global config. `div`'s own second
 * argument is NOT a decimal-place count — it is the numeric base of the
 * operands, and reading it as precision is what made every VWAP wrong until
 * SEN-34 (see markets.ts).
 */
import { BigDecimal, type EvmOnEventContext } from 'envio';
import { accountAddressEffect } from './accountAddress.ts';
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

/** Exact BigDecimal for an integer amount at `decimals` places. */
export function bd(atoms: bigint, decimals: number): BigDecimal {
  return new BigDecimal(humanString(atoms, decimals));
}

export function addBd(a: BigDecimal, b: BigDecimal): BigDecimal {
  return a.plus(b);
}

export const ZERO_BD = (): BigDecimal => new BigDecimal('0');

/**
 * The account's address, read off the venue the first time the account is
 * seen.
 *
 * The registration events (`AccountRegistered`, `AccountCreated`) are one-shot
 * and most of them are older than `config.yaml`'s `start_block`, so an account
 * that only ever *trades* inside the window would otherwise carry a null
 * address forever — and the API matches agents by address, dropping null rows.
 * The read is an Envio effect, so it is deduplicated and cached: one RPC call
 * per account id, not per fill. See src/lib/accountAddress.ts for why this is
 * a contract read rather than something taken off the fill events.
 *
 * `undefined` (no such account) is stored as no address, never as `0x000…0`.
 */
async function lookupAccountAddress(
  context: Ctx,
  venue: 'KURU' | 'PERPL',
  accountId: bigint,
): Promise<string | undefined> {
  const address = await context.effect(accountAddressEffect, { venue, accountId });
  return address === null ? undefined : address.toLowerCase();
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
    address: await lookupAccountAddress(context, venue, accountId),
    owner: undefined,
    firstSeenBlock: BigInt(blockNumber),
    firstSeenAt: new Date(timestampSec * 1000),
    totalTradeCount: 0,
    totalVolumeUsd: ZERO_BD(),
    realizedPnlUsd: ZERO_BD(),
    winningTradeCount: 0,
    losingTradeCount: 0,
  });
}

/** The Kuru account address (`AccountRegistered.account`). */
export async function setAccountAddress(
  context: Ctx,
  id: string,
  address: string,
): Promise<void> {
  const account = await context.Account.getOrThrow(id);
  context.Account.set({ ...account, address: address.toLowerCase() });
}

/** The owner the venue names separately (`AccountRegistered.owner`). */
export async function setAccountOwner(
  context: Ctx,
  id: string,
  owner: string,
): Promise<void> {
  const account = await context.Account.getOrThrow(id);
  context.Account.set({ ...account, owner: owner.toLowerCase() });
}

/**
 * The (account, token) custody row, created at zero if absent. Callers then
 * write only the fields their event actually reports — `SpotReserveUpdated`
 * sets the absolute free/reserved pair, `Deposit`/`Withdrawal` add to the
 * cumulative flow, and neither clobbers the other.
 */
export async function ensureBalance(
  context: Ctx,
  accountId: string,
  token: string,
  decimals: number,
): Promise<import('envio').AccountBalance> {
  const id = `${accountId}-${token}`;
  const existing = await context.AccountBalance.get(id);
  if (existing !== undefined) return existing;
  return {
    id,
    account_id: accountId,
    token,
    deposited: 0n,
    withdrawn: 0n,
    net: 0n,
    freeRaw: 0n,
    reservedRaw: 0n,
    decimals,
    lastUpdatedBlock: 0n,
  };
}

/** One accounted fill for one party (taker or maker) on one market. */
export type FillInput = {
  /** "kuru-62" | "perpl-7" — the Account entity id; the row must already exist. */
  accountId: string;
  marketId: string;
  venue: 'KURU' | 'PERPL';
  role: 'taker' | 'maker';
  /** signed base raw units (+ buy, − sell) from this party's perspective */
  signedBaseRaw: bigint;
  /**
   * Decimal scale of that raw unit — `decimalsFromPrecision(market.sizePrecision)`
   * for both venues, NOT the base token's ERC-20 decimals.
   */
  baseUnitDecimals: number;
  /** quote atoms exchanged (non-negative, venue-native decimals) */
  quoteAtoms: bigint;
  quoteDecimals: number;
  blockNumber: number;
  timestampSec: number;
};

/**
 * Roll one party's fill into its `AccountMarketStats` and the account rollup.
 *
 * Realised PnL is fee-exclusive: fees are recorded on the `Trade` row (and are
 * zero for a maker leg, whose fee is on its own maker event) but are not netted
 * out of `realizedPnlUsd`. See docs/indexer.md §pnl for why.
 *
 * Precondition: `fill.accountId` already has an `Account` row — every caller
 * runs `ensureAccount` first, which is also where the raw id is known.
 */
export async function recordPartyFill(
  context: Ctx,
  fill: FillInput,
): Promise<{ realizedRaw: bigint; reduces: boolean }> {
  if (fill.signedBaseRaw === 0n) {
    return { realizedRaw: 0n, reduces: false };
  }
  const id = statsId(fill.accountId, fill.marketId);
  const stats = (await context.AccountMarketStats.get(id)) ?? {
    id,
    account_id: fill.accountId,
    market_id: fill.marketId,
    n: 0,
    takerN: 0,
    makerN: 0,
    volumeUsd: ZERO_BD(),
    boughtBase: ZERO_BD(),
    soldBase: ZERO_BD(),
    realizedPnlUsd: ZERO_BD(),
    wins: 0,
    losses: 0,
    openBaseRaw: 0n,
    openCostRaw: 0n,
    firstTradeBlock: BigInt(fill.blockNumber),
    lastTradeBlock: BigInt(fill.blockNumber),
  };

  const pos = applyFill(
    { baseRaw: stats.openBaseRaw, costRaw: stats.openCostRaw },
    fill.signedBaseRaw,
    fill.quoteAtoms,
  );
  const baseAbs = fill.signedBaseRaw < 0n ? -fill.signedBaseRaw : fill.signedBaseRaw;
  const bought = fill.signedBaseRaw > 0n ? baseAbs : 0n;
  const sold = fill.signedBaseRaw < 0n ? baseAbs : 0n;
  const realizedBd = bd(pos.realizedRaw, fill.quoteDecimals);
  const won = pos.reduces && pos.realizedRaw > 0n;
  const lost = pos.reduces && pos.realizedRaw < 0n;
  context.AccountMarketStats.set({
    ...stats,
    n: stats.n + 1,
    takerN: stats.takerN + (fill.role === 'taker' ? 1 : 0),
    makerN: stats.makerN + (fill.role === 'maker' ? 1 : 0),
    volumeUsd: addBd(stats.volumeUsd, bd(fill.quoteAtoms, fill.quoteDecimals)),
    boughtBase: addBd(stats.boughtBase, bd(bought, fill.baseUnitDecimals)),
    soldBase: addBd(stats.soldBase, bd(sold, fill.baseUnitDecimals)),
    realizedPnlUsd: addBd(stats.realizedPnlUsd, realizedBd),
    wins: stats.wins + (won ? 1 : 0),
    losses: stats.losses + (lost ? 1 : 0),
    openBaseRaw: pos.baseRaw,
    openCostRaw: pos.costRaw,
    lastTradeBlock: BigInt(fill.blockNumber),
  });

  const account = await context.Account.getOrThrow(fill.accountId);
  context.Account.set({
    ...account,
    totalTradeCount: account.totalTradeCount + 1,
    totalVolumeUsd: addBd(account.totalVolumeUsd, bd(fill.quoteAtoms, fill.quoteDecimals)),
    realizedPnlUsd: addBd(account.realizedPnlUsd, realizedBd),
    winningTradeCount: account.winningTradeCount + (won ? 1 : 0),
    losingTradeCount: account.losingTradeCount + (lost ? 1 : 0),
  });
  return { realizedRaw: pos.realizedRaw, reduces: pos.reduces };
}
