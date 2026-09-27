/**
 * The wire shapes of `/portfolio` (SEN-101, plan-trading M-T19).
 *
 * `PortfolioDto` is the plan's `Portfolio` verbatim, reusing the wallet's
 * `TokenBalanceDto` and the markets contract's balance, order and position
 * DTOs rather than defining look-alikes: the phone already parses those.
 * `apps/mobile/src/trade/api.ts` (M-T20) copies these types — change one and
 * change the other.
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import type {
  BalanceDto,
  Decimal,
  OrderDto,
  PositionDto,
  VenueId,
} from '../../venues/dto/markets.dto';
import type { TokenBalanceDto } from '../../wallet/dto/wallet.dto';

/**
 * - `ok`: read through the user's read-scoped Perpl key (M-T18).
 * - `unlinked`: an account exists but the server holds no read key for it —
 *   the chain still gives its collateral balance, nothing else.
 * - `not_onboarded`: the wallet has no Perpl account at all.
 */
export type PerplPortfolioStatus = 'ok' | 'unlinked' | 'not_onboarded';

export interface PortfolioDto {
  /** Unix ms of the read. */
  asOf: number;
  /** The user's Privy wallet: MON, every Kuru market token, and AUSD. */
  wallet: TokenBalanceDto[];
  kuru: {
    /** `null` until the wallet's first Kuru deposit creates its AccountCore account. */
    accountId: string | null;
    /** `available` is free, `locked` is reserved by resting orders. */
    balances: BalanceDto[];
    openOrders: OrderDto[];
  };
  perpl: {
    status: PerplPortfolioStatus;
    /** Present whenever the account exists (`ok` and `unlinked`). */
    accountId?: string;
    /** `unlinked`: the chain's collateral balance only, which excludes margin in positions. */
    balances?: BalanceDto[];
    /** Only with `ok`; absent means unknown, not none. */
    positions?: PositionDto[];
    openOrders?: OrderDto[];
  };
}

export interface FillDto {
  venue: VenueId;
  /** Our trade id (`/trade/:tradeId`) that produced the fill. */
  tradeId: string;
  /** The venue's own id for the match. */
  venueTradeId: string;
  orderId: string | null;
  /** `null` only if the trade's summary was lost; the fill itself is still real. */
  symbol: string | null;
  side: 'buy' | 'sell' | null;
  price: Decimal;
  size: Decimal;
  /** The transaction that carried the fill, when the step recorded one. */
  transactionHash: string | null;
  /** Unix ms. When the trade recorded the result, not the block time. */
  timestamp: number;
}

export interface FillsPageDto {
  fills: FillDto[];
  /** Pass back as `cursor` for the next, older page; `null` at the end. */
  next: string | null;
}

export class FillsQueryDto {
  @IsOptional()
  @IsIn(['kuru', 'perpl'])
  venue?: VenueId;

  /** Opaque; whatever the previous page's `next` was. */
  @IsOptional()
  @Matches(/^\d{1,9}$/)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
