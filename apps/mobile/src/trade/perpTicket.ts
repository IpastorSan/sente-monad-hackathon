/**
 * The rules of the perp ticket (SEN-120), pure so they run under test.
 *
 * A market order is bounded at {@link PERP_MAX_SLIPPAGE} of Perpl's fresh
 * mark: `perplTrader.placeMarket` never takes a price from the screen. A
 * limit order (SEN-179, under "Advanced options") carries the user's price,
 * checked by {@link checkPerpLimit}, and is sized at that price. The
 * user types what the position is worth in AUSD; the size sent is that value
 * at the mark the screen showed, rounded DOWN to the market's step, so the
 * order is never bigger than what was typed (Perpl fills at its own mark,
 * within the bound). Margin is the size's value over the leverage — Perpl's
 * initial margin for an isolated position (the SEN-82 live run opened 0.0005
 * BTC at 82,947.4 with 2x and Perpl took 20.74 AUSD). There is no liquidation
 * estimate before the fill: it needs the market's maintenance margin, which
 * `/markets` does not send. The position screen shows Perpl's own figure.
 */
import { shortSize, toUnits, unitsToDecimal } from './ticket.ts';

/** `"0.01"`: 1%, the most a market order may fill away from the mark. */
export const PERP_MAX_SLIPPAGE = '0.01';

/** The leverage steps offered, filtered to what the market allows. */
const LEVERAGE_STEPS = [1, 2, 3, 5, 10, 20, 25, 50, 100] as const;

export type PerpSide = 'long' | 'short';

export type PerpOrderType = 'market' | 'limit';

/** What the ticket needs to know about one Perpl market. */
export type PerpMarket = {
  readonly symbol: string;
  /** e.g. `"BTC"`. */
  readonly base: string;
  /** `"0.00001"`: the smallest size step, also the minimum size. */
  readonly stepSize: string;
  /** `null` when `/markets` did not say. */
  readonly maxLeverage: number | null;
};

/**
 * The leverage chips: the usual steps at or under the market's maximum, and
 * the maximum itself if it is not one of them. Without a maximum, only 1x,
 * because the trader refuses a leverage it cannot check.
 */
export function leverageChoices(max: number | null): number[] {
  if (max === null || !Number.isFinite(max) || max < 1) return [1];
  const steps: number[] = LEVERAGE_STEPS.filter((x) => x <= max);
  // Perpl's `lv` is in hundredths; the trader refuses anything finer.
  const top = Math.floor(max * 100) / 100;
  if (steps[steps.length - 1] !== top) steps.push(top);
  return steps;
}

/** `10^decimals` of a step like `"0.001"`: the integer scale sizes are counted in. */
function scaleOf(step: string): bigint {
  const fraction = step.split('.')[1] ?? '';
  return 10n ** BigInt(fraction.length);
}

export type PerpTicketInput = {
  readonly market: PerpMarket;
  readonly side: PerpSide;
  /** What the user typed: the position's value in AUSD. */
  readonly value: string;
  readonly leverage: number;
  /** Perpl's mark as `/markets` last sent it; `null` before the first ticker. */
  readonly mark: string | null;
  /** AUSD free in the Perpl account, if known. */
  readonly available: string | null;
  /** `limit` sizes at `limitPrice` instead of the mark. Market when omitted. */
  readonly orderType?: PerpOrderType;
  readonly limitPrice?: string;
};

export type PerpTicket = {
  /** Base units to send, on the step; `null` until there is one. */
  readonly size: string | null;
  /** The size's value at the mark, AUSD, two places. */
  readonly notional: string | null;
  /** What the position locks, AUSD, two places, rounded up. */
  readonly margin: string | null;
  /** The line under the amount. */
  readonly sub: string | null;
  readonly cta: { readonly label: string; readonly enabled: boolean };
  readonly short: boolean;
};

const CENTS = 100n;

/** Cents → `"149.30"`: money always shows both places. */
function cents(value: bigint): string {
  const [whole = '0', fraction = ''] = unitsToDecimal(value, CENTS).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export function evaluatePerpTicket(input: PerpTicketInput): PerpTicket {
  const { market, side, value, leverage, mark } = input;
  const verb = side === 'long' ? 'Long' : 'Short';
  const none = (label: string, sub: string | null = null): PerpTicket => ({
    size: null,
    notional: null,
    margin: null,
    sub,
    cta: { label, enabled: false },
    short: false,
  });

  const limit = input.orderType === 'limit';
  const scale = scaleOf(market.stepSize);
  const markScale = 10n ** 8n;
  // The price the size is counted at: the mark, or the user's limit.
  const at = limit ? (input.limitPrice ?? '') : mark;
  const markUnits = at === null || at === '' ? null : toUnits(at, markScale);
  if (markUnits === null || markUnits <= 0n) {
    return none(limit ? 'Enter a limit price' : 'Waiting for the price');
  }
  const valueCents = value === '' ? null : toUnits(value, CENTS);
  if (valueCents === null || valueCents === 0n)
    return none(`Enter an amount to ${verb.toLowerCase()}`);

  // size = value / mark, floored to the step: value·scale·markScale / (mark·100).
  const sizeSteps = (valueCents * scale * markScale) / (markUnits * CENTS);
  const minSteps = toUnits(market.stepSize, scale) ?? 1n;
  if (sizeSteps < minSteps) {
    return none('Too small', `The smallest ${market.base} order is ${market.stepSize}`);
  }
  const size = unitsToDecimal(sizeSteps, scale);
  // notional = size · mark, in cents (floored), margin = notional / leverage (ceiled).
  const notionalCents = (sizeSteps * markUnits * CENTS) / (scale * markScale);
  const levHundredths = BigInt(Math.round(leverage * 100));
  const marginCents = (notionalCents * 100n + levHundredths - 1n) / levHundredths;
  const notional = cents(notionalCents);
  const margin = cents(marginCents);
  const sub = `≈ ${shortSize(size)} ${market.base} · ${margin} AUSD margin`;

  const availableCents = input.available === null ? null : toUnits(input.available, CENTS);
  if (availableCents !== null && marginCents > availableCents) {
    return {
      size,
      notional,
      margin,
      sub,
      cta: { label: 'Not enough margin in Perpl', enabled: false },
      short: true,
    };
  }
  return {
    size,
    notional,
    margin,
    sub,
    cta: { label: `Review ${verb.toLowerCase()}${limit ? ' limit' : ''}`, enabled: true },
    short: false,
  };
}

// ─── Limit orders ───────────────────────────────────────────────────────────

export type PerpLimitCheck = {
  /** Blocks the review: the order could not be sent as typed. */
  readonly problem: string | null;
  /** Said under the price; never blocks. */
  readonly warning: string | null;
};

const PLAIN = /^(?:\d+\.?\d*|\.\d+)$/;

function decimalsOf(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

/** `value` as integer units of `10^-places`; `places` must cover its decimals. */
function unitsAt(value: string, places: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt((whole || '0') + fraction.padEnd(places, '0'));
}

/**
 * A perp limit price (SEN-179): above zero and on the market's tick, or it is
 * a problem; on the far side of the mark it is only a warning, because the
 * mark is not the book's best price and the order may still rest. Post-only
 * says what Perpl does then: refuse it rather than let it take.
 */
export function checkPerpLimit(input: {
  readonly price: string;
  readonly side: PerpSide;
  readonly mark: string | null;
  readonly tickSize: string;
  readonly postOnly: boolean;
}): PerpLimitCheck {
  const { price, side, mark, tickSize, postOnly } = input;
  if (price === '') return { problem: 'Enter a limit price', warning: null };
  if (!PLAIN.test(price)) return { problem: 'That isn’t a price', warning: null };
  const places = Math.max(
    decimalsOf(price),
    decimalsOf(tickSize),
    mark !== null && PLAIN.test(mark) ? decimalsOf(mark) : 0,
  );
  const p = unitsAt(price, places);
  if (p <= 0n) return { problem: 'The price must be above zero', warning: null };
  const tick = PLAIN.test(tickSize) ? unitsAt(tickSize, places) : 0n;
  if (tick > 0n && p % tick !== 0n) {
    return { problem: `Perpl prices move in steps of ${tickSize}`, warning: null };
  }
  if (mark === null || !PLAIN.test(mark)) return { problem: null, warning: null };
  const m = unitsAt(mark, places);
  const crosses = side === 'long' ? p > m : p < m;
  if (!crosses) return { problem: null, warning: null };
  const where = side === 'long' ? 'Above' : 'Below';
  return {
    problem: null,
    warning: postOnly
      ? `${where} the mark, so it may trade at once: post-only refuses that, and the order is cancelled.`
      : `${where} the mark, so it may fill at once, at up to this price, like a market order.`,
  };
}

/** The mark floored to the tick: where a new limit price starts. */
export function limitFromMark(mark: string | null, tickSize: string): string {
  if (mark === null || !PLAIN.test(mark) || !PLAIN.test(tickSize)) return '';
  const places = Math.max(decimalsOf(mark), decimalsOf(tickSize));
  const m = unitsAt(mark, places);
  const tick = unitsAt(tickSize, places);
  if (tick <= 0n) return mark;
  const floored = m - (m % tick);
  const tickPlaces = decimalsOf(tickSize);
  const text = floored.toString().padStart(places + 1, '0');
  const whole = text.slice(0, text.length - places);
  const fraction = text.slice(text.length - places, text.length - places + tickPlaces);
  return tickPlaces > 0 ? `${whole}.${fraction}` : whole;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

/** One row of the setup's step list, in order. `chain` rows are sponsored transactions. */
export type SetupStep = {
  readonly key: 'perpl.approve' | 'perpl.createAccount' | 'perpl.allowForwarding' | 'enroll';
  readonly title: string;
  readonly detail: string;
};

/** What the setup screen will do, from what the account still needs. */
export function setupSteps(
  needs: { open: boolean; forwarding: boolean; enroll: boolean },
  amount: string,
): SetupStep[] {
  const steps: SetupStep[] = [];
  if (needs.open) {
    steps.push(
      {
        key: 'perpl.approve',
        title: `Let Perpl take ${amount} AUSD`,
        detail: 'An approval for exactly this amount, used up by the next step.',
      },
      {
        key: 'perpl.createAccount',
        title: `Open your Perpl account with ${amount} AUSD`,
        detail: 'The AUSD becomes your margin. Your wallet owns the account.',
      },
    );
  }
  if (needs.open || needs.forwarding) {
    steps.push({
      key: 'perpl.allowForwarding',
      title: 'Let orders reach your account',
      detail: 'Perpl’s order forwarding, so a key can trade without moving funds.',
    });
  }
  if (needs.enroll) {
    steps.push({
      key: 'enroll',
      title: 'Add this device’s trading key',
      detail: 'Can place and close orders. Cannot withdraw. Nothing sent on chain.',
    });
  }
  return steps;
}

/** The setup's CTA, named by what it will do first. */
export function setupCta(
  needs: { open: boolean; forwarding: boolean; enroll: boolean },
  amount: string,
): string {
  if (needs.open) return `Open account with ${amount} AUSD`;
  if (needs.forwarding) return 'Finish setting up';
  return 'Add trading key';
}

/** The AUSD free in a Perpl account, from `/portfolio`'s balances. */
export function perplFreeAusd(
  balances: readonly { asset: string; available: string }[] | undefined,
): string | null {
  return balances?.find((b) => b.asset === 'AUSD')?.available ?? null;
}
