/**
 * Trade wire types shared by the phone's verifiers and its trade API client
 * (SEN-93, plan "Shared wire types" in docs/design/trading/plan-trading.md).
 *
 * Mirrored, not imported, from the API: the app does not import the server
 * (CLAUDE.md gotchas 2 and 10). Amounts are decimal strings on the wire so a
 * JSON round trip cannot lose precision; the verifiers parse them strictly.
 */
import type { Address } from 'viem';

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
  readonly summary: Record<string, unknown>;
};
