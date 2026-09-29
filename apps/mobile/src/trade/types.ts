/**
 * Trade wire types shared by the phone's verifiers and its trade API client
 * (SEN-93, plan "Shared wire types" in docs/design/trading/plan-trading.md).
 *
 * Mirrored, not imported, from the API: the app does not import the server
 * (CLAUDE.md gotchas 2 and 10). Amounts are decimal strings on the wire so a
 * JSON round trip cannot lose precision; the verifiers parse them strictly.
 */
import type { Address, Hex } from 'viem';

import type { BalanceDto, OrderDto, PositionDto, SectionResult } from '../agents/api.ts';
import type { AuthorizationPayload } from '../auth/deviceKey.ts';

export type KuruPlaceIntent = {
  readonly kind: 'kuru.place';
  /** UUID v4, phone-generated. Seeds the idempotency keys and the client order id. */
  readonly clientTradeId: string;
  /** The OrderBook address. */
  readonly market: Address;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  /** Book size units. */
  readonly sizeAtoms: string;
  /** The limit price, or the phone-computed worst price; on tick. Book price units. */
  readonly priceUnits: string;
  /** Limit orders only. */
  readonly postOnly?: boolean;
  /** Phone-computed cap for the funding leg, in funding-token atoms. */
  readonly maxDepositAtoms: string;
};

export type KuruCancelIntent = {
  readonly kind: 'kuru.cancel';
  readonly clientTradeId: string;
  readonly market: Address;
  /** `"<slot>:<orderId>"`, as `formatOrderId` in `@sente/venues/kuru` writes it. */
  readonly orderId: string;
};

export type KuruWithdrawIntent = {
  readonly kind: 'kuru.withdraw';
  readonly clientTradeId: string;
  readonly token: Address;
  readonly amountAtoms: string;
};

export type PerplOnboardIntent = {
  readonly kind: 'perpl.onboard';
  readonly clientTradeId: string;
  readonly amountAtoms: string;
};

export type KuruIntent = KuruPlaceIntent | KuruCancelIntent | KuruWithdrawIntent;
export type TradeIntent = KuruIntent | PerplOnboardIntent;

export type StepKind =
  | 'approve'
  | 'deposit'
  | 'place'
  | 'cancel'
  | 'withdraw'
  | 'perpl.approve'
  | 'perpl.createAccount'
  | 'perpl.allowForwarding'
  | 'batch';

/** One server-composed step. `title` is display only and never trusted. */
export type PreparedStep = {
  readonly index: number;
  readonly kind: StepKind;
  readonly title: string;
  readonly payload: AuthorizationPayload;
};

export type PreparedTrade = {
  readonly tradeId: string;
  readonly clientTradeId: string;
  readonly expiresAt: string;
  readonly wallet: { readonly walletId: string; readonly address: Address };
  readonly steps: readonly PreparedStep[];
  /** Render only: never an input to a check. */
  readonly summary: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Responses of `/trade` (SEN-102, plan M-T20). Copied from
// `services/api/src/trade/dto/trade.dto.ts` and `trade-store.ts` (SEN-96);
// change one and change the other, or the app and the API disagree silently.
// ---------------------------------------------------------------------------

export type TradeKind = TradeIntent['kind'];

export type StepStatus =
  'awaiting_signature' | 'queued' | 'submitted' | 'included' | 'reverted' | 'not_sent' | 'unknown';

/** `expired` is a `prepared` trade past `expiresAt`; the server never stores it. */
export type TradeStatus = 'prepared' | 'executing' | 'completed' | 'failed' | 'expired';

/** `GET /trade/capabilities`: the full shape even with the flag off (every boolean false). */
export type TradeCapabilities = {
  readonly enabled: boolean;
  readonly atomicBatch: boolean;
  readonly chainId: number;
  readonly venues: { readonly kuru: boolean; readonly perpl: boolean };
};

export type KuruPlaceResult = {
  readonly status: 'filled' | 'partially_filled' | 'resting' | 'cancelled' | 'rejected';
  readonly orderId?: string;
  readonly requestedSize: string;
  readonly filledSize: string;
  readonly avgPrice?: string;
  readonly fee: string;
  readonly feeAsset: 'USDC';
  readonly fills: readonly {
    readonly price: string;
    readonly size: string;
    readonly tradeId: string;
  }[];
  readonly unfilledCancelled?: string;
};

export type TradeFunds = readonly {
  readonly where: 'wallet' | 'kuru' | 'perpl';
  readonly symbol: string;
  readonly amount: string;
}[];

export type TradeStepView = {
  readonly index: number;
  readonly kind: StepKind;
  readonly title: string;
  readonly status: StepStatus;
  readonly userOpHash?: Hex;
  readonly transactionHash?: Hex;
  readonly blockNumber?: string;
  readonly error?: string;
};

/** `POST /trade/:tradeId/commit`, `GET /trade/:tradeId`, `GET /trade`. */
export type TradeView = {
  readonly tradeId: string;
  readonly clientTradeId: string;
  readonly kind: TradeKind;
  readonly status: TradeStatus;
  readonly steps: readonly TradeStepView[];
  readonly result?: KuruPlaceResult;
  readonly funds?: TradeFunds;
  /** ISO 8601. */
  readonly updatedAt: string;
};

/** The `reason`s `/trade` refuses with, and the HTTP status each arrives under. */
export type TradeRefusalReason =
  | 'trading_disabled' // 404
  | 'trade_not_found' // 404
  | 'trade_id_conflict' // 409
  | 'already_terminal' // 409
  | 'trade_expired' // 410
  | 'not_supported_yet' // 400
  | 'signature_count_mismatch' // 400
  | 'invalid_intent' // 400
  | 'market_not_allowed' // 400
  | 'below_min_notional' // 422
  | 'reserve_balance' // 422
  | 'deposit_cap_exceeded' // 422
  | 'insufficient_balance'; // 422

// ---------------------------------------------------------------------------
// `/portfolio` (SEN-101, plan M-T19). Copied from
// `services/api/src/portfolio/dto/portfolio.dto.ts`, replacing the shapes
// SEN-102 had to guess before the route existed (SEN-118); change one and
// change the other. The balance, order and position DTOs are the markets
// contract's, which the phone already mirrors in `agents/api.ts` for the
// agent portfolio, so they are imported rather than copied a second time.
// ---------------------------------------------------------------------------

export type PortfolioVenue = 'kuru' | 'perpl';

/** One wallet token, as `/wallet` sends it too: `raw` atoms and `amount` decimal. */
export type PortfolioTokenBalance = {
  readonly symbol: string;
  /** The ERC-20, or the zero address for native MON. */
  readonly address: string;
  readonly decimals: number;
  /** Atoms, as a decimal string: bigint is not JSON. */
  readonly raw: string;
  /** The same number decimal-shifted, e.g. "1.5" USDC. What the app shows. */
  readonly amount: string;
};

/**
 * - `ok`: read through the user's read-scoped Perpl key (M-T18).
 * - `unlinked`: an account exists but the server holds no read key for it;
 *   the chain still gives its collateral balance, nothing else.
 * - `not_onboarded`: the wallet has no Perpl account at all.
 */
export type PerplPortfolioStatus = 'ok' | 'unlinked' | 'not_onboarded';

export type PerplPortfolioSection = {
  readonly status: PerplPortfolioStatus;
  /** Present whenever the account exists (`ok` and `unlinked`). */
  readonly accountId?: string;
  /** `unlinked`: the chain's collateral balance only, which excludes margin in positions. */
  readonly balances?: readonly BalanceDto[];
  /** Only with `ok`; absent means unknown, not none. */
  readonly positions?: readonly PositionDto[];
  readonly openOrders?: readonly OrderDto[];
  /**
   * When Perpl was read (SEN-151): a linked account's section is cached for
   * up to 30 s, so it can lag the portfolio's own `asOf`. Absent from older APIs.
   */
  readonly asOf?: number;
  /** The latest read failed and this is the last good one, from `asOf`. */
  readonly stale?: true;
};

/**
 * `GET /portfolio`: the user's Privy wallet, its Kuru account and its Perpl
 * account. Each section is a `SectionResult` (SEN-123), so one venue that
 * does not answer costs only its own section; `{ ok: false }` is unknown and
 * must never be drawn as empty.
 */
export type Portfolio = {
  /** Unix ms of the read. */
  readonly asOf: number;
  /** MON, every Kuru market token, and AUSD. */
  readonly wallet: SectionResult<{ readonly balances: readonly PortfolioTokenBalance[] }>;
  readonly kuru: SectionResult<{
    /** `null` until the wallet's first Kuru deposit creates its AccountCore account. */
    readonly accountId: string | null;
    /** `available` is free, `locked` is reserved by resting orders. */
    readonly balances: readonly BalanceDto[];
    readonly openOrders: readonly OrderDto[];
  }>;
  readonly perpl: SectionResult<PerplPortfolioSection>;
};

/** One of the user's own fills: Kuru from a `/trade` they placed, Perpl off the account. */
export type PortfolioFill = {
  readonly venue: PortfolioVenue;
  /** Our trade id (`/trade/:tradeId`); `null` for Perpl, whose orders skip `/trade` (SEN-151). */
  readonly tradeId: string | null;
  /** The venue's own id for the match. */
  readonly venueTradeId: string;
  readonly orderId: string | null;
  /** `null` only if the trade's summary was lost; the fill itself is still real. */
  readonly symbol: string | null;
  readonly side: 'buy' | 'sell' | null;
  readonly price: string;
  readonly size: string;
  /**
   * What the fill cost in `feeAsset`, positive paid, negative a rebate
   * (SEN-162). Kuru's is its order's one fee split across the fills by
   * notional. `null` when the venue did not report it: unknown, not zero.
   */
  readonly fee: string | null;
  readonly feeAsset: string | null;
  /** The transaction that carried the fill, when the step recorded one. */
  readonly transactionHash: string | null;
  /** Unix ms. Kuru: when the trade recorded the result. Perpl: the block time. */
  readonly timestamp: number;
};

/** `GET /portfolio/fills?venue=&cursor=&limit=`, newest first. */
export type PortfolioFills = {
  readonly fills: readonly PortfolioFill[];
  /** Pass back as `cursor` for the next, older page; `null` at the end. */
  readonly next: string | null;
};
