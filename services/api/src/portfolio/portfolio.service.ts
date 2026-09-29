/**
 * The user's own portfolio: their Privy wallet, its Kuru AccountCore account
 * and its Perpl account (SEN-101, plan-trading M-T19).
 *
 * Every venue read is the address-level helper `AgentPortfolioService` uses
 * (`agents/portfolio/venue-reads.ts`, SEN-78), so an agent's portfolio and its
 * owner's cannot disagree about how a venue is read. What is user specific is
 * only whose address it is — the session's registered wallet — and where
 * Perpl credentials would come from.
 *
 * Like the agent portfolio, each section is read independently and reported
 * as a `SectionResult` (SEN-123), so a venue that is down costs that section
 * only.
 *
 * Nothing is stored: every call re-reads chain and venue state, so a restart
 * can never misreport a balance (plan "Persistence"). The one thing held in
 * memory is a short-lived Perpl read (SEN-151): with the user's read key
 * linked, each Perpl read signs in on a fresh trading socket, and Perpl's
 * budget is ~10 requests a minute.
 */
import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';
import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_NETWORKS, PerplVenue, type PerplFillRecord } from '@sente/venues/perpl';
import { BaseError, formatUnits, parseUnits, type Address, type PublicClient } from 'viem';

import {
  AGENT_WALLET_TOKENS,
  kuruAccountVenue,
  readKuruAccount,
  readPerplAccount,
  type KuruAccountVenue,
  type PerplAccountInfoReader,
  type PerplAccountVenue,
} from '../agents/portfolio/venue-reads';
import { perplAccountInfo } from '../agents/venues/perpl-agent';
import type { Principal } from '../auth/principal';
import { TradeStore, type Trade } from '../trade/trade-store';
import { USER_VENUE_SECRETS, type UserVenueSecretStore } from '../trade/user-venue-secrets';
import { ViemTokenBalanceReader, type TokenBalanceReader } from '../wallet/balances/token-balances';
import {
  USER_WALLET_REGISTRY,
  type UserWalletBinding,
  type UserWalletRegistry,
} from '../wallet/store/user-wallet-registry';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { MONAD_PUBLIC_CLIENT } from '../wallet/wallet.module';
import type { SectionResult } from '../venues/dto/markets.dto';
import type {
  FillDto,
  FillsPageDto,
  FillsQueryDto,
  PerplPortfolioSection,
  PortfolioDto,
} from './dto/portfolio.dto';

/** Everything the service reads through: the seam the spec fakes. */
export interface UserPortfolioReaders {
  readonly registry: Pick<UserWalletRegistry, 'find'>;
  readonly wallet: TokenBalanceReader;
  readonly kuruVenue: (address: Address) => KuruAccountVenue;
  readonly perplAccountInfo: PerplAccountInfoReader;
  /**
   * Runs `read` against a Perpl venue signed in with the user's read-scoped
   * key (SEN-100), `undefined` while the server holds none. A callback so the
   * reader owns the venue's lifetime: the socket is closed once `read`
   * settles, never left open between polls (SEN-151, as SEN-122 for agents).
   */
  readonly withPerplReadVenue: <T>(
    userId: string,
    read: (venue: PerplUserVenue | undefined) => Promise<T>,
  ) => Promise<T>;
  readonly trades: Pick<TradeStore, 'listRecent'>;
  readonly now?: () => number;
}

export const USER_PORTFOLIO_READERS = Symbol('USER_PORTFOLIO_READERS');

/** What the user's Perpl reads need: the account read plus the signed REST fills. */
export type PerplUserVenue = PerplAccountVenue & Pick<PerplVenue, 'getFills'>;

/**
 * How long a linked user's Perpl section (and a page of Perpl fills) is served
 * from memory (SEN-151). Each read signs in with the read key, and Perpl's
 * budget is ~10 requests/min; the phone polls `/portfolio` every 10 s.
 */
export const USER_PERPL_TTL_MS = 30_000;

/** How old a last good Perpl read may be and still stand in, flagged stale, for a failed one. */
export const USER_PERPL_STALE_MS = 120_000;

export type PortfolioRefusalReason = 'invalid_cursor' | 'perpl_unlinked' | 'perpl_unavailable';

/** A `/portfolio` refusal the controller turns into a clean 4xx/5xx with this `reason`. */
export class PortfolioRefusedError extends Error {
  readonly reason: PortfolioRefusalReason;

  constructor(reason: PortfolioRefusalReason, message: string) {
    super(message);
    this.name = 'PortfolioRefusedError';
    this.reason = reason;
  }
}

type PerplSection = PortfolioDto['perpl'];
type Cached<T> = { at: number; value: Promise<T> };

export const FILLS_DEFAULT_LIMIT = 50;

/**
 * A `listRecent` limit that means "all of them": the store keeps a day of one
 * user's manual trades, so the whole set is small (see `TradeStore.listRecent`).
 */
const ALL_TRADES = Number.MAX_SAFE_INTEGER;

/**
 * `TradeService` stores the planner's render summary on the trade object
 * itself (the store has no field for it; `TradeWithSummary` in
 * `trade.service.ts`). A fill needs its market and side from there, because
 * `KuruPlaceResult` carries neither.
 */
type TradeWithSummary = Trade & { readonly summary?: Record<string, string> };

@Injectable()
export class UserPortfolioService {
  readonly #readers: UserPortfolioReaders;
  readonly #now: () => number;
  readonly #logger = new Logger(UserPortfolioService.name);
  readonly #perplCache = new Map<string, Cached<PerplSection>>();
  readonly #perplLastGood = new Map<string, PerplSection & { ok: true; asOf: number }>();
  readonly #perplFillsCache = new Map<string, Cached<FillsPageDto>>();

  constructor(@Inject(USER_PORTFOLIO_READERS) readers: UserPortfolioReaders) {
    this.#readers = readers;
    this.#now = readers.now ?? Date.now;
  }

  async portfolio(principal: Principal): Promise<PortfolioDto> {
    const { address } = await this.#bound(principal);
    const { userId } = principal;
    const asOf = this.#now();
    // Each read settles into its own section (SEN-123): with `Promise.all`
    // over the bare reads, one venue timing out failed the whole request and
    // the phone lost the wallet along with it.
    const [wallet, kuru, perpl] = await Promise.all([
      this.#section('wallet', userId, async () => ({
        balances: (await this.#readers.wallet.balances(address)).map((token) => ({
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          raw: token.raw.toString(),
          amount: token.amount,
        })),
      })),
      // `account` = the wallet: for a user the Privy wallet is the AccountCore
      // root (plan §2), not the retired Kernel address gotcha 9 describes.
      this.#section('kuru', userId, () => readKuruAccount(this.#readers.kuruVenue(address))),
      this.#perpl(userId, address, asOf),
    ]);
    return { asOf, wallet, kuru, perpl };
  }

  /**
   * The Perpl section, single-flight per user for {@link USER_PERPL_TTL_MS}
   * (SEN-151). A failed read is kept for the window too: retrying every poll
   * is exactly the traffic that trips Perpl's rate limit.
   */
  #perpl(userId: string, address: Address, now: number): Promise<PerplSection> {
    this.#prune(now);
    const key = `${userId}:${address}`;
    const hit = this.#perplCache.get(key);
    if (hit && now - hit.at < USER_PERPL_TTL_MS) return hit.value;

    const value = this.#readPerpl(key, userId, address, now);
    this.#perplCache.set(key, { at: now, value });
    void value.then((section) => {
      // Without a read key the read was chain-only and signed nothing in:
      // nothing to ration, and a key linked a second later must show at once.
      const socketless = section.ok && section.status !== 'ok' && !section.stale;
      if (socketless && this.#perplCache.get(key)?.value === value) this.#perplCache.delete(key);
    });
    return value;
  }

  async #readPerpl(
    key: string,
    userId: string,
    address: Address,
    now: number,
  ): Promise<PerplSection> {
    const fresh = await this.#section('perpl', userId, async () => ({
      ...toPerplSection(
        await this.#readers.withPerplReadVenue(userId, (venue) =>
          readPerplAccount(address, { accountInfo: this.#readers.perplAccountInfo, venue }),
        ),
      ),
      asOf: now,
    }));
    if (fresh.ok) {
      this.#perplLastGood.set(key, fresh);
      return fresh;
    }
    const last = this.#perplLastGood.get(key);
    if (last && now - last.asOf <= USER_PERPL_STALE_MS) return { ...last, stale: true };
    return fresh;
  }

  #prune(now: number): void {
    for (const cache of [this.#perplCache, this.#perplFillsCache]) {
      for (const [key, entry] of cache) {
        if (now - entry.at >= USER_PERPL_TTL_MS) cache.delete(key);
      }
    }
    for (const [key, last] of this.#perplLastGood) {
      if (now - last.asOf > USER_PERPL_STALE_MS) this.#perplLastGood.delete(key);
    }
  }

  /**
   * The user's fills, newest first.
   *
   * Kuru: the fills decoded from each manual trade's own receipt (M-T15), as
   * the trade store holds them — so a day's worth at most, and none from
   * before a restart. The Data Source's `order-events` would reach further
   * back, but `KuruVenue` exposes no history read and those events carry no
   * fill price (an order with no cancel that no longer rests was filled, at
   * some price), so they are left out rather than guessed at.
   *
   * Perpl (`venue=perpl`): Perpl's signed REST `fills`, read with the user's
   * read key (SEN-151), so every fill of the account — the phone's own orders
   * included, which never pass through `/trade`. Without a key it refuses
   * `perpl_unlinked` rather than answer an empty page that would read as "no
   * fills"; a Perpl failure is `perpl_unavailable`.
   *
   * No `venue` means Kuru, as it always has: the two venues page with
   * different cursors, so the phone asks for each.
   */
  async fills(principal: Principal, query: FillsQueryDto = {}): Promise<FillsPageDto> {
    const { address } = await this.#bound(principal);
    const limit = query.limit ?? FILLS_DEFAULT_LIMIT;
    if (query.venue === 'perpl') {
      const page = await this.#perplFills(principal.userId, address, query.cursor, limit);
      // SEN-157: Perpl pages by its own cursor, so a market is filtered out of
      // each page after the read (and after the cache, which stays per page):
      // a page may come back short, but `next` still walks the whole history.
      if (query.symbol === undefined) return page;
      return { ...page, fills: page.fills.filter((fill) => fill.symbol === query.symbol) };
    }
    // The cursor is opaque on the wire since Perpl's own is not a number;
    // Kuru's is still an offset.
    if (query.cursor !== undefined && !/^\d{1,9}$/.test(query.cursor)) {
      throw new PortfolioRefusedError('invalid_cursor', 'Not a Kuru fills cursor');
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);

    const all = this.#readers.trades
      .listRecent(principal.userId, ALL_TRADES)
      .flatMap((trade) => kuruFills(trade))
      // SEN-157: filtered before paging, so a market's page is full, not a sparse slice of everyone's.
      .filter((fill) => query.symbol === undefined || fill.symbol === query.symbol);
    const page = all.slice(offset, offset + limit);
    const end = offset + page.length;
    return { fills: page, next: end < all.length ? String(end) : null };
  }

  /** A page of Perpl fills, single-flight and cached like the section (SEN-151). */
  #perplFills(
    userId: string,
    address: Address,
    cursor: string | undefined,
    limit: number,
  ): Promise<FillsPageDto> {
    const now = this.#now();
    this.#prune(now);
    const key = `${userId}:${address}:${cursor ?? ''}:${limit}`;
    const hit = this.#perplFillsCache.get(key);
    if (hit && now - hit.at < USER_PERPL_TTL_MS) return hit.value;

    const value = this.#readers
      .withPerplReadVenue(userId, (venue) =>
        venue
          ? venue.getFills({ count: limit, ...(cursor ? { page: cursor } : {}) })
          : Promise.resolve(undefined),
      )
      .then(
        (page) => {
          if (!page) {
            throw new PortfolioRefusedError(
              'perpl_unlinked',
              'No Perpl read key is linked for this account',
            );
          }
          return { fills: page.fills.map(perplFillDto), next: page.next };
        },
        (error: unknown) => {
          this.#logger.warn(`User ${userId}: Perpl fills read failed: ${messageOf(error)}`);
          throw new PortfolioRefusedError('perpl_unavailable', messageOf(error));
        },
      );
    this.#perplFillsCache.set(key, { at: now, value });
    value.catch((error: unknown) => {
      // Unlinked signed nothing in, and a key linked a second later must show at once.
      const unlinked = error instanceof PortfolioRefusedError && error.reason === 'perpl_unlinked';
      if (unlinked && this.#perplFillsCache.get(key)?.value === value) {
        this.#perplFillsCache.delete(key);
      }
    });
    return value;
  }

  async #section<T extends object>(
    name: string,
    userId: string,
    read: () => Promise<T>,
  ): Promise<SectionResult<T>> {
    try {
      return { ok: true, ...(await read()) };
    } catch (error) {
      this.#logger.warn(`User ${userId}: portfolio ${name} read failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
  }

  async #bound(principal: Principal): Promise<UserWalletBinding> {
    const binding = await this.#readers.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No wallet for this user; POST /wallet/register with the device public key first',
      );
    }
    return binding;
  }
}

/** viem's `shortMessage` drops the request dump (URL, calldata) its `message` carries. */
function messageOf(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

function toPerplSection(
  snapshot: Awaited<ReturnType<typeof readPerplAccount>>,
): PerplPortfolioSection {
  switch (snapshot.status) {
    case 'no_account':
      return { status: 'not_onboarded' };
    case 'not_enrolled':
      // The helper's `null` positions/orders mean "unknown"; the plan's shape
      // says the same by leaving them out.
      return { status: 'unlinked', accountId: snapshot.accountId, balances: snapshot.balances };
    case 'ok':
      return {
        status: 'ok',
        accountId: snapshot.accountId,
        balances: snapshot.balances,
        positions: snapshot.positions,
        openOrders: snapshot.openOrders,
      };
  }
}

/** Perpl's fills are the account's, not a `/trade`'s: there is no trade id of ours to name. */
function perplFillDto(fill: PerplFillRecord): FillDto {
  return {
    venue: 'perpl',
    tradeId: null,
    venueTradeId: fill.tradeId ?? fill.orderId,
    orderId: fill.orderId,
    symbol: fill.symbol,
    side: fill.side,
    price: fill.price,
    size: fill.size,
    fee: fill.fee,
    feeAsset: fill.feeAsset,
    transactionHash: fill.txHash ?? null,
    timestamp: fill.timestamp,
  };
}

/** A trade's decoded fills; none for a trade whose result is not recorded (yet). */
function kuruFills(trade: TradeWithSummary): FillDto[] {
  if (trade.kind !== 'kuru.place' || !trade.result) return [];
  const { summary, result } = trade;
  const side = summary?.side === 'buy' || summary?.side === 'sell' ? summary.side : null;
  // The fills live in the place step's receipt, or the batch's when packed (plan §2).
  const carrier = trade.steps.find(
    (step) => (step.kind === 'place' || step.kind === 'batch') && step.transactionHash,
  );
  const fees = kuruFeeShares(result.fee, result.fills, KURU_TESTNET_TOKENS.USDC.decimals);
  return result.fills.map((fill, i) => ({
    venue: 'kuru',
    tradeId: trade.id,
    venueTradeId: fill.tradeId,
    orderId: result.orderId ?? null,
    symbol: summary?.market ?? null,
    side,
    price: fill.price,
    size: fill.size,
    fee: fees[i]!,
    feeAsset: result.feeAsset,
    transactionHash: carrier?.transactionHash ?? null,
    timestamp: trade.updatedAt.getTime(),
  }));
}

/** Digits after the point, so each decimal parses without rounding. */
function places(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

/**
 * A Kuru placement's one fee split across its fills (SEN-162). The decoded
 * result keeps a single taker fee — `feeAtoms` floors the summed notional
 * once — so no per-fill fee exists to report. Each fill gets the share of its
 * notional (`price × size`), floored at the fee token's atom (`atomDecimals`,
 * USDC's 6: nothing finer is ever charged), and the last fill takes what
 * flooring left over: the shares always add up to exactly `fee`, so netting
 * every fill of a trip nets the order's whole fee, no more.
 */
export function kuruFeeShares(
  fee: string,
  fills: readonly { price: string; size: string }[],
  atomDecimals: number,
): string[] {
  if (fills.length === 0) return [];
  const feeScale = Math.max(places(fee), atomDecimals);
  const total = parseUnits(fee, feeScale);
  const priceScale = Math.max(...fills.map((f) => places(f.price)));
  const sizeScale = Math.max(...fills.map((f) => places(f.size)));
  const weights = fills.map((f) => parseUnits(f.price, priceScale) * parseUnits(f.size, sizeScale));
  const sum = weights.reduce((a, b) => a + b, 0n);
  // A zero notional has nothing to weigh by; the whole fee rides on the last fill.
  const shares = weights.map((w) => (sum === 0n ? 0n : (total * w) / sum));
  shares[shares.length - 1] = total - shares.slice(0, -1).reduce((a, b) => a + b, 0n);
  return shares.map((atoms) => formatUnits(atoms, feeScale));
}

/** Nest wiring: the real readers over the wallet module's Monad client. */
export const userPortfolioProviders: Provider[] = [
  {
    provide: USER_PORTFOLIO_READERS,
    inject: [USER_WALLET_REGISTRY, MONAD_PUBLIC_CLIENT, TradeStore, USER_VENUE_SECRETS],
    useFactory: (
      registry: UserWalletRegistry,
      client: PublicClient,
      trades: TradeStore,
      secrets: UserVenueSecretStore,
    ): UserPortfolioReaders => ({
      registry,
      // The agent token list, not `/wallet`'s three: a user who withdraws a
      // spot buy from Kuru holds WBTC or WETH in the wallet, and the portfolio
      // must show it.
      wallet: new ViemTokenBalanceReader(client, AGENT_WALLET_TOKENS),
      kuruVenue: (address) => kuruAccountVenue(client, address),
      perplAccountInfo: (address) => perplAccountInfo(client, address),
      withPerplReadVenue: (userId, read) => withPerplReadVenue(secrets, userId, read),
      trades,
    }),
  },
  UserPortfolioService,
];

/**
 * A throwaway Perpl venue on the user's read key (SEN-151), closed once `read`
 * settles. The phone's trade key is never here: the server holds none (SEN-100).
 */
async function withPerplReadVenue<T>(
  secrets: Pick<UserVenueSecretStore, 'getPerplRead'>,
  userId: string,
  read: (venue: PerplUserVenue | undefined) => Promise<T>,
): Promise<T> {
  const credentials = await secrets.getPerplRead(userId);
  if (!credentials) return read(undefined);
  const venue = new PerplVenue({ credentials, network: PERPL_NETWORKS.testnet });
  try {
    return await read(venue);
  } finally {
    venue.close();
  }
}
