/**
 * Layer 1: the mandate checked against one intent, before anything is signed.
 *
 * This is where the limits the enclave cannot see are enforced — Perpl order
 * size and leverage, Kuru order notional — and where every other limit is
 * checked again so the agent gets a named refusal instead of an opaque
 * `policy_violation` from Privy. Pure: the caller supplies `now`.
 *
 * Fails closed. The intent is untrusted agent output, so a venue or market the
 * mandate does not name is refused, and a missing amount, notional or leverage
 * is treated as over the cap rather than as zero.
 *
 * **Cancel, close and withdraw are always allowed on an allowed venue** —
 * including after expiry and on markets no longer listed — because reducing
 * risk must never be blocked. Layer 2 agrees for withdraw: its rule carries no
 * expiry (the money can only go back to the agent's own wallet, see policy.ts).
 * It is stricter for a Kuru cancel: the `batch` rules expire with the mandate,
 * so after `expiresAt` a Kuru cancel passes this check and is still refused by
 * the enclave; the account owner cancels then.
 */
import type { Decimal } from '@sente/venues';
import { isAddress, isAddressEqual, type Address } from 'viem';

import { compareDecimal, isDecimal } from './decimal.ts';
import type { Mandate, VenueId } from './mandate.ts';

export const REFUSAL_CODES = [
  'mandate_expired',
  'venue_not_allowed',
  'market_not_allowed',
  'notional_over_cap',
  'leverage_over_cap',
  'deposit_over_cap',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  readonly code: RefusalCode;
  readonly detail: string;
}

/** `withdraw`: collateral from the venue back to the agent's own wallet. */
export type IntentKind = 'deposit' | 'order' | 'cancel' | 'close' | 'withdraw';

/** Kinds that only ever reduce risk: allowed on any allowed venue, even after expiry. */
const RISK_REDUCING: readonly IntentKind[] = ['cancel', 'close', 'withdraw'];

export interface Intent {
  /** Untrusted — any string. Only a venue the mandate lists passes. */
  readonly venue: string;
  readonly kind: IntentKind;
  /**
   * Kuru order: the OrderBook address. Kuru deposit: the token address.
   * Perpl order: the market symbol. Perpl deposit: ignored (AUSD is the only
   * collateral).
   */
  readonly market: string;
  /** Order notional in quote units. Required for orders. */
  readonly notional?: Decimal;
  /** Required for Perpl orders. Ignored on Kuru spot. */
  readonly leverage?: number;
  /** Required for deposits, in token atoms. */
  readonly amountAtoms?: bigint;
}

function refuse(code: RefusalCode, detail: string): Refusal {
  return { code, detail };
}

function checkDeposit(amount: bigint | undefined, cap: bigint, what: string): Refusal | null {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    return refuse(
      'deposit_over_cap',
      `a deposit needs a positive amountAtoms; got ${String(amount)}`,
    );
  }
  if (amount > cap) {
    return refuse(
      'deposit_over_cap',
      `${amount} atoms of ${what} exceeds the mandate's cap of ${cap}`,
    );
  }
  return null;
}

function checkNotional(mandate: Mandate, notional: Decimal | undefined): Refusal | null {
  if (!isDecimal(notional)) {
    return refuse(
      'notional_over_cap',
      `an order needs a decimal notional; got ${String(notional)}`,
    );
  }
  if (compareDecimal(notional, mandate.maxOrderNotional) > 0) {
    return refuse(
      'notional_over_cap',
      `notional ${notional} exceeds the mandate's cap of ${mandate.maxOrderNotional}`,
    );
  }
  return null;
}

function kuruAddress(market: string): Address | null {
  return isAddress(market, { strict: false }) ? market : null;
}

function checkKuru(mandate: Mandate, intent: Intent): Refusal | null {
  const address = kuruAddress(intent.market);
  if (intent.kind === 'deposit') {
    const entry = address
      ? Object.entries(mandate.kuru.maxDepositAtoms).find(([token]) =>
          isAddressEqual(token as Address, address),
        )
      : undefined;
    if (!entry) {
      return refuse('market_not_allowed', `the mandate allows no Kuru deposit of ${intent.market}`);
    }
    return checkDeposit(intent.amountAtoms, entry[1], entry[0]);
  }
  if (!address || !mandate.kuru.markets.some((m) => isAddressEqual(m, address))) {
    return refuse('market_not_allowed', `Kuru market ${intent.market} is not in the mandate`);
  }
  return checkNotional(mandate, intent.notional);
}

function checkPerpl(mandate: Mandate, intent: Intent): Refusal | null {
  if (intent.kind === 'deposit') {
    return checkDeposit(intent.amountAtoms, mandate.perpl.maxCollateralAtoms, 'AUSD');
  }
  if (!mandate.perpl.markets.includes(intent.market)) {
    return refuse('market_not_allowed', `Perpl market ${intent.market} is not in the mandate`);
  }
  const notional = checkNotional(mandate, intent.notional);
  if (notional) return notional;
  const leverage = intent.leverage;
  if (typeof leverage !== 'number' || !Number.isFinite(leverage) || leverage <= 0) {
    return refuse(
      'leverage_over_cap',
      `a Perpl order needs a positive leverage; got ${String(leverage)}`,
    );
  }
  if (leverage > mandate.perpl.maxLeverage) {
    return refuse(
      'leverage_over_cap',
      `leverage ${leverage}x exceeds the mandate's cap of ${mandate.perpl.maxLeverage}x`,
    );
  }
  return null;
}

/**
 * `null` when the mandate allows the intent at unix second `now`, otherwise the
 * first refusal. Order: venue, then cancel/close/withdraw pass, then expiry,
 * then market, then the caps.
 */
export function checkIntent(mandate: Mandate, intent: Intent, now: number): Refusal | null {
  if (!mandate.venues.includes(intent.venue as VenueId)) {
    return refuse('venue_not_allowed', `venue ${intent.venue} is not in the mandate`);
  }
  if (RISK_REDUCING.includes(intent.kind)) return null;
  // Written so that a NaN `now` is refused too.
  if (!(now <= mandate.expiresAt)) {
    return refuse('mandate_expired', `the mandate expired at ${mandate.expiresAt}; now is ${now}`);
  }
  // Any kind other than deposit gets the full order checks — the strictest path.
  return intent.venue === 'kuru' ? checkKuru(mandate, intent) : checkPerpl(mandate, intent);
}
