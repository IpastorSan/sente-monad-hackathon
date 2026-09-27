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
 * Nothing is cached or stored: every call re-reads chain and venue state, so a
 * restart can never misreport a balance (plan "Persistence").
 */
import { Inject, Injectable, type Provider } from '@nestjs/common';
import type { Address, PublicClient } from 'viem';

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
import { ViemTokenBalanceReader, type TokenBalanceReader } from '../wallet/balances/token-balances';
import {
  USER_WALLET_REGISTRY,
  type UserWalletBinding,
  type UserWalletRegistry,
} from '../wallet/store/user-wallet-registry';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { MONAD_PUBLIC_CLIENT } from '../wallet/wallet.module';
import type { FillDto, FillsPageDto, FillsQueryDto, PortfolioDto } from './dto/portfolio.dto';

/** Everything the service reads through: the seam the spec fakes. */
export interface UserPortfolioReaders {
  readonly registry: Pick<UserWalletRegistry, 'find'>;
  readonly wallet: TokenBalanceReader;
  readonly kuruVenue: (address: Address) => KuruAccountVenue;
  readonly perplAccountInfo: PerplAccountInfoReader;
  /**
   * The user's read-scoped Perpl venue, `undefined` while the server holds no
   * read key. M-T18 (enrollment) is what will return one; until it lands this
   * is always `undefined`, so every existing account reads as `unlinked`.
   */
  readonly perplReadVenue: (
    userId: string,
    address: Address,
  ) => Promise<PerplAccountVenue | undefined>;
  readonly trades: Pick<TradeStore, 'listRecent'>;
  readonly now?: () => number;
}

export const USER_PORTFOLIO_READERS = Symbol('USER_PORTFOLIO_READERS');

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

  constructor(@Inject(USER_PORTFOLIO_READERS) readers: UserPortfolioReaders) {
    this.#readers = readers;
    this.#now = readers.now ?? Date.now;
  }

  async portfolio(principal: Principal): Promise<PortfolioDto> {
    const { address } = await this.#bound(principal);
    const asOf = this.#now();
    const [wallet, kuru, perpl] = await Promise.all([
      this.#readers.wallet.balances(address),
      // `account` = the wallet: for a user the Privy wallet is the AccountCore
      // root (plan §2), not the retired Kernel address gotcha 9 describes.
      readKuruAccount(this.#readers.kuruVenue(address)),
      readPerplAccount(address, {
        accountInfo: this.#readers.perplAccountInfo,
        venue: this.#readers.perplReadVenue(principal.userId, address),
      }),
    ]);

    return {
      asOf,
      wallet: wallet.map((token) => ({
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        raw: token.raw.toString(),
        amount: token.amount,
      })),
      kuru,
      perpl: toPerplSection(perpl),
    };
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
   * Perpl: signed REST `fills` need the read key M-T18 enrolls; empty until
   * then.
   */
  async fills(principal: Principal, query: FillsQueryDto = {}): Promise<FillsPageDto> {
    await this.#bound(principal);
    const limit = query.limit ?? FILLS_DEFAULT_LIMIT;
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (query.venue === 'perpl') return { fills: [], next: null };

    const all = this.#readers.trades
      .listRecent(principal.userId, ALL_TRADES)
      .flatMap((trade) => kuruFills(trade));
    const page = all.slice(offset, offset + limit);
    const end = offset + page.length;
    return { fills: page, next: end < all.length ? String(end) : null };
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

function toPerplSection(
  snapshot: Awaited<ReturnType<typeof readPerplAccount>>,
): PortfolioDto['perpl'] {
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

/** A trade's decoded fills; none for a trade whose result is not recorded (yet). */
function kuruFills(trade: TradeWithSummary): FillDto[] {
  if (trade.kind !== 'kuru.place' || !trade.result) return [];
  const { summary, result } = trade;
  const side = summary?.side === 'buy' || summary?.side === 'sell' ? summary.side : null;
  // The fills live in the place step's receipt, or the batch's when packed (plan §2).
  const carrier = trade.steps.find(
    (step) => (step.kind === 'place' || step.kind === 'batch') && step.transactionHash,
  );
  return result.fills.map((fill) => ({
    venue: 'kuru',
    tradeId: trade.id,
    venueTradeId: fill.tradeId,
    orderId: result.orderId ?? null,
    symbol: summary?.market ?? null,
    side,
    price: fill.price,
    size: fill.size,
    transactionHash: carrier?.transactionHash ?? null,
    timestamp: trade.updatedAt.getTime(),
  }));
}

/** Nest wiring: the real readers over the wallet module's Monad client. */
export const userPortfolioProviders: Provider[] = [
  {
    provide: USER_PORTFOLIO_READERS,
    inject: [USER_WALLET_REGISTRY, MONAD_PUBLIC_CLIENT, TradeStore],
    useFactory: (
      registry: UserWalletRegistry,
      client: PublicClient,
      trades: TradeStore,
    ): UserPortfolioReaders => ({
      registry,
      // The agent token list, not `/wallet`'s three: a user who withdraws a
      // spot buy from Kuru holds WBTC or WETH in the wallet, and the portfolio
      // must show it.
      wallet: new ViemTokenBalanceReader(client, AGENT_WALLET_TOKENS),
      kuruVenue: (address) => kuruAccountVenue(client, address),
      perplAccountInfo: (address) => perplAccountInfo(client, address),
      // M-T18 holds the read key; until it lands there is never one.
      perplReadVenue: () => Promise.resolve(undefined),
      trades,
    }),
  },
  UserPortfolioService,
];
