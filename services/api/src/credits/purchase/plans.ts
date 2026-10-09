/**
 * What Sente sells on top of the free tier (SEN-183): credit packs of 10, 20
 * and 50 USD, a custom amount, and an optional auto top-up. Pure, so the
 * plan table, the request checks and the app's mirror can be tested without
 * Nest.
 *
 * Nothing here takes money. While `CREDITS_PURCHASES_ENABLED` is off every
 * purchase is refused before it is even read; with it on, the request is
 * checked here and handed to the `CreditPayments` seam (`credit-payments.ts`).
 */
import type { LimitReset } from '../openrouter.client';

/** The packs, in USD. A pack raises the user's OpenRouter key limit by its amount. */
export const CREDIT_PACKS_USD = [10, 20, 50] as const;

/** A custom pack: whole dollars in this range. */
export const CUSTOM_PACK = { minUsd: 5, maxUsd: 500 } as const;

/** Auto top-up: when what is left drops below `thresholdUsd`, buy `amountUsd`. */
export const AUTO_TOP_UP = {
  thresholdsUsd: [1, 2, 5],
  amountsUsd: CREDIT_PACKS_USD,
} as const;

/** What a purchase would be paid in: a sponsored send of either stablecoin to the treasury. */
export const PAYMENT_ASSETS = ['USDC', 'AUSD'] as const;

/** Shown wherever buying is off, so the screen never pretends a disabled button is broken. */
export const PURCHASES_CLOSED_NOTE = 'Purchases open after the testnet demo.';

export type CreditPlanId = `pack_${(typeof CREDIT_PACKS_USD)[number]}` | 'custom';

export interface CreditPlan {
  readonly id: CreditPlanId;
  /** Fixed price for a pack; null for `custom`, which takes `amountUsd`. */
  readonly usd: number | null;
}

export interface CreditPlansView {
  readonly purchasesEnabled: boolean;
  /** Why buying is off; null when it is on. */
  readonly note: string | null;
  readonly currency: 'USD';
  readonly freeTier: { readonly usd: number; readonly reset: LimitReset };
  readonly plans: readonly CreditPlan[];
  readonly custom: { readonly minUsd: number; readonly maxUsd: number };
  readonly autoTopUp: {
    readonly thresholdsUsd: readonly number[];
    readonly amountsUsd: readonly number[];
  };
  readonly paymentAssets: readonly string[];
}

export function creditPlans(input: {
  purchasesEnabled: boolean;
  freeTierUsd: number;
  freeTierReset: LimitReset;
}): CreditPlansView {
  return {
    purchasesEnabled: input.purchasesEnabled,
    note: input.purchasesEnabled ? null : PURCHASES_CLOSED_NOTE,
    currency: 'USD',
    freeTier: { usd: input.freeTierUsd, reset: input.freeTierReset },
    plans: [
      ...CREDIT_PACKS_USD.map((usd): CreditPlan => ({ id: `pack_${usd}`, usd })),
      { id: 'custom', usd: null },
    ],
    custom: { ...CUSTOM_PACK },
    autoTopUp: {
      thresholdsUsd: [...AUTO_TOP_UP.thresholdsUsd],
      amountsUsd: [...AUTO_TOP_UP.amountsUsd],
    },
    paymentAssets: [...PAYMENT_ASSETS],
  };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

export interface PurchaseOrder {
  readonly plan: CreditPlanId;
  readonly usd: number;
}

/** `{plan: 'pack_20'}` or `{plan: 'custom', amountUsd: 35}` → what to charge. */
export function checkPurchase(body: unknown): Checked<PurchaseOrder> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Expected {plan, amountUsd?}' };
  }
  const { plan, amountUsd } = body as Record<string, unknown>;
  if (plan === 'custom') {
    const { minUsd, maxUsd } = CUSTOM_PACK;
    if (typeof amountUsd !== 'number' || !Number.isInteger(amountUsd)) {
      return { ok: false, message: 'A custom pack needs amountUsd, in whole dollars' };
    }
    if (amountUsd < minUsd || amountUsd > maxUsd) {
      return { ok: false, message: `A custom pack is ${minUsd} to ${maxUsd} USD` };
    }
    return { ok: true, value: { plan: 'custom', usd: amountUsd } };
  }
  const pack = CREDIT_PACKS_USD.find((usd) => plan === `pack_${usd}`);
  if (pack === undefined) {
    return { ok: false, message: `Unknown plan ${JSON.stringify(plan)}` };
  }
  if (amountUsd !== undefined) {
    return { ok: false, message: 'A pack has a fixed price; amountUsd is for custom only' };
  }
  return { ok: true, value: { plan: `pack_${pack}`, usd: pack } };
}

export interface AutoTopUpSetting {
  readonly enabled: boolean;
  readonly thresholdUsd: number | null;
  readonly amountUsd: number | null;
}

export const AUTO_TOP_UP_OFF: AutoTopUpSetting = {
  enabled: false,
  thresholdUsd: null,
  amountUsd: null,
};

/** `{enabled: false}` or `{enabled: true, thresholdUsd: 2, amountUsd: 20}`. */
export function checkAutoTopUp(body: unknown): Checked<AutoTopUpSetting> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Expected {enabled, thresholdUsd?, amountUsd?}' };
  }
  const { enabled, thresholdUsd, amountUsd } = body as Record<string, unknown>;
  if (enabled === false) return { ok: true, value: AUTO_TOP_UP_OFF };
  if (enabled !== true) return { ok: false, message: 'enabled must be true or false' };
  const thresholds: readonly unknown[] = AUTO_TOP_UP.thresholdsUsd;
  const amounts: readonly unknown[] = AUTO_TOP_UP.amountsUsd;
  if (!thresholds.includes(thresholdUsd)) {
    return { ok: false, message: `thresholdUsd must be one of ${thresholds.join(', ')}` };
  }
  if (!amounts.includes(amountUsd)) {
    return { ok: false, message: `amountUsd must be one of ${amounts.join(', ')}` };
  }
  return {
    ok: true,
    value: { enabled: true, thresholdUsd: thresholdUsd as number, amountUsd: amountUsd as number },
  };
}
