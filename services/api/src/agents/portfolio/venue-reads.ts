/**
 * Read-only venue reads for ONE address: wallet tokens, a Kuru AccountCore
 * account and a Perpl account (SEN-78, plan B-T9).
 *
 * Nothing here knows about agents. They take an address (or a venue already
 * bound to one) and return wire DTOs, because two portfolios read the same
 * venues: the agent's (`AgentPortfolioService`) and the user's (plan-trading
 * M-T19, which imports these instead of writing a second copy). What IS agent
 * specific — the mandate check, the event-log cost basis, where credentials
 * come from — stays in the service.
 */
import type { Balance, Order, Position } from '@sente/venues';
import { KURU_TESTNET_TOKENS, KuruVenue } from '@sente/venues/kuru';
import {
  PERPL_COLLATERAL_DECIMALS,
  PERPL_TESTNET_CONTRACTS,
  type PerplVenue,
} from '@sente/venues/perpl';
import { formatUnits, type Address, type PublicClient } from 'viem';

import type { BalanceDto, OrderDto, PositionDto, VenueId } from '../../venues/dto/markets.dto';
import type { BalanceToken, TokenBalanceReader } from '../../wallet/balances/token-balances';
import type { PerplAccountInfo } from '../venues/perpl-agent';

// ---------------------------------------------------------------------------
// Wallet

/**
 * Every token an agent wallet can hold: the Kuru market tokens (native MON
 * included) plus Agora AUSD, Perpl's collateral. USDC and AUSD are both listed
 * because they are different tokens that happen to look alike.
 */
export const AGENT_WALLET_TOKENS: readonly BalanceToken[] = [
  ...Object.values(KURU_TESTNET_TOKENS),
  {
    symbol: 'AUSD',
    address: PERPL_TESTNET_CONTRACTS.collateral,
    decimals: PERPL_COLLATERAL_DECIMALS,
  },
];

export type WalletBalanceDto = BalanceDto & { decimals: number };

/** The address's own token balances; nothing in a wallet is locked. */
export async function readWalletBalances(
  reader: TokenBalanceReader,
  address: Address,
): Promise<WalletBalanceDto[]> {
  return (await reader.balances(address)).map((token) => ({
    asset: token.symbol,
    available: token.amount,
    locked: '0',
    total: token.amount,
    decimals: token.decimals,
  }));
}

// ---------------------------------------------------------------------------
// Kuru

/** The slice of `KuruVenue` an account read needs. */
export type KuruAccountVenue = Pick<KuruVenue, 'accountId' | 'getBalances' | 'getOpenOrders'>;

/** A read-only `KuruVenue` bound to `address`: no submitter, so it cannot sign anything. */
export function kuruAccountVenue(publicClient: PublicClient, address: Address): KuruAccountVenue {
  return new KuruVenue({ publicClient, account: address });
}

export interface KuruAccountSnapshot {
  /** `null` until the address's first deposit registers it with AccountCore. */
  accountId: string | null;
  /** AccountCore: `available` is free, `locked` is reserved by resting orders. */
  balances: BalanceDto[];
  openOrders: OrderDto[];
}

export async function readKuruAccount(venue: KuruAccountVenue): Promise<KuruAccountSnapshot> {
  const accountId = await venue.accountId();
  // Id 0 is "never deposited": there is nothing to read, and the Gateway has
  // no orders to list for an account that does not exist.
  if (accountId === 0n) return { accountId: null, balances: [], openOrders: [] };
  const [balances, openOrders] = await Promise.all([venue.getBalances(), venue.getOpenOrders()]);
  return {
    accountId: accountId.toString(),
    balances: balances.map(balanceDto),
    openOrders: openOrders.map((order) => orderDto('kuru', order)),
  };
}

// ---------------------------------------------------------------------------
// Perpl

/** The slice of `PerplVenue` a credentialed account read needs. */
export type PerplAccountVenue = Pick<PerplVenue, 'getBalances' | 'getPositions' | 'getOpenOrders'>;

/** `perplAccountInfo` bound to a client: `(address) => account | null`. */
export type PerplAccountInfoReader = (address: Address) => Promise<PerplAccountInfo | null>;

export type PerplAccountSnapshot =
  | {
      status: 'ok';
      accountId: string;
      balances: BalanceDto[];
      positions: PositionDto[];
      openOrders: OrderDto[];
    }
  | {
      status: 'not_enrolled';
      accountId: string;
      balances: BalanceDto[];
      positions: null;
      openOrders: null;
    }
  | { status: 'no_account' };

/**
 * The address's Perpl account. With `venue` (API credentials held) it is the
 * full picture off the trading socket; without one only the chain is readable,
 * which gives a balance and nothing else — positions and orders are `null`
 * (unknown), not `[]` (none). Plan finding #1: nearly every agent is here.
 */
export async function readPerplAccount(
  address: Address,
  readers: {
    readonly accountInfo: PerplAccountInfoReader;
    /** A promise is fine: it is awaited alongside the chain read, not before it. */
    readonly venue?: PerplAccountVenue | Promise<PerplAccountVenue | undefined>;
  },
): Promise<PerplAccountSnapshot> {
  const [info, venue] = await Promise.all([readers.accountInfo(address), readers.venue]);
  // Credentials are only ever enrolled for an existing account, so a venue
  // without one means the chain and the socket disagree; believe the chain.
  if (!info) return { status: 'no_account' };
  const accountId = info.accountId.toString();
  if (!venue) {
    return {
      status: 'not_enrolled',
      accountId,
      balances: [perplChainBalance(info)],
      positions: null,
      openOrders: null,
    };
  }
  const [balances, positions, openOrders] = await Promise.all([
    venue.getBalances(),
    venue.getPositions(),
    venue.getOpenOrders(),
  ]);
  return {
    status: 'ok',
    accountId,
    balances: balances.map(balanceDto),
    positions: positions.map(positionDto),
    openOrders: openOrders.map((order) => orderDto('perpl', order)),
  };
}

/**
 * The collateral balance as the Exchange stores it. Unlike the socket's
 * `getBalances`, `total` here excludes margin sitting in open positions (Perpl
 * moves it out of the account balance, and the tuple's position words are
 * opaque), so with positions open this understates the account.
 */
export function perplChainBalance(info: PerplAccountInfo): BalanceDto {
  const available = info.balance > info.locked ? info.balance - info.locked : 0n;
  return {
    asset: 'AUSD',
    available: formatUnits(available, PERPL_COLLATERAL_DECIMALS),
    locked: formatUnits(info.locked, PERPL_COLLATERAL_DECIMALS),
    total: formatUnits(info.balance, PERPL_COLLATERAL_DECIMALS),
  };
}

// ---------------------------------------------------------------------------
// Venue types → wire DTOs

export function balanceDto(balance: Balance): BalanceDto {
  return {
    asset: balance.asset,
    available: balance.available,
    locked: balance.locked,
    total: balance.total,
  };
}

export function orderDto(venue: VenueId, order: Order): OrderDto {
  return {
    venue,
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    price: order.price ?? null,
    size: order.size,
    filledSize: order.filledSize,
    leverage: order.leverage ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function positionDto(position: Position): PositionDto {
  return {
    symbol: position.symbol,
    side: position.side,
    size: position.size,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    // The adapter's own estimate; it ignores accrued funding, hence "Est".
    liquidationPriceEst: position.liquidationPrice ?? null,
    leverage: position.leverage,
    margin: position.margin,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl ?? null,
    fundingPaid: position.fundingPaid ?? null,
    quote: 'AUSD',
    updatedAt: position.updatedAt,
  };
}
