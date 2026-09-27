/**
 * Trade wire types shared by the phone's verifiers and its trade API client
 * (SEN-93, plan "Shared wire types" in docs/design/trading/plan-trading.md).
 *
 * Mirrored, not imported, from the API: the app does not import the server
 * (CLAUDE.md gotchas 2 and 10). Amounts are decimal strings on the wire so a
 * JSON round trip cannot lose precision; the verifiers parse them strictly.
 */
import type { Address, Hex } from 'viem';

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
// `/portfolio` (plan M-T19). PROVISIONAL: the route is not built yet, so these
// follow the plan's mini-plan, not a DTO. Re-copy them from M-T19's DTO when it
// lands. Amounts are decimal strings, as everywhere on the wire.
// ---------------------------------------------------------------------------

export type PortfolioVenue = 'kuru' | 'perpl';

export type PortfolioTokenBalance = {
  readonly symbol: string;
  /** The ERC-20, or the zero address for native MON. */
  readonly address: Address;
  readonly decimals: number;
  readonly raw: string;
  readonly amount: string;
};

export type PortfolioVenueBalance = {
  readonly asset: string;
  readonly available: string;
  readonly locked: string;
};

export type PortfolioOrder = {
  readonly orderId: string;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly price: string;
  readonly size: string;
  readonly filledSize?: string;
};

export type PortfolioPosition = {
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly size: string;
  readonly entryPrice: string;
  readonly markPrice?: string;
  readonly unrealizedPnl?: string;
  readonly leverage?: string;
  readonly liquidationPrice?: string;
};

/** `GET /portfolio`: wallet, Kuru margin account, Perpl account. */
export type Portfolio = {
  readonly asOf: number;
  readonly wallet: readonly PortfolioTokenBalance[];
  readonly kuru: {
    /** `null` for an empty Kuru account (id 0). */
    readonly accountId: string | null;
    readonly balances: readonly PortfolioVenueBalance[];
    readonly openOrders: readonly PortfolioOrder[];
  };
  readonly perpl: {
    readonly status: 'unlinked' | 'ok' | 'not_onboarded';
    readonly balances?: readonly PortfolioVenueBalance[];
    readonly positions?: readonly PortfolioPosition[];
    readonly openOrders?: readonly PortfolioOrder[];
  };
};

export type PortfolioFill = {
  readonly venue: PortfolioVenue;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly price: string;
  readonly size: string;
  readonly fee?: string;
  readonly tradeId: string;
  /** ms since epoch. */
  readonly time: number;
};

/** `GET /portfolio/fills?venue=&cursor=`: `next` is the cursor for the next page, `null` at the end. */
export type PortfolioFills = {
  readonly fills: readonly PortfolioFill[];
  readonly next: string | null;
};
