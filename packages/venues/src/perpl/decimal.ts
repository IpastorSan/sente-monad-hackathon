/**
 * Decimal strings <-> Perpl's scaled integers, without ever touching a float.
 *
 * Perpl carries a BTC price of $77,108.1 as `771081` (price_decimals = 1) and
 * 0.001 BTC as `100` (size_decimals = 5). The obvious `Math.round(p * 10 ** d)`
 * is how an order for 0.29 of something becomes 0.28999999999999998, so every
 * conversion here is string and bigint arithmetic.
 */
import type { Decimal } from '../types.ts';

export type Rounding = 'exact' | 'floor' | 'ceil';

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** A value with more precision than the venue accepts, under `'exact'` rounding. */
export class PrecisionError extends Error {
  constructor(value: string, decimals: number) {
    super(`${value} has more than ${decimals} decimal places`);
    this.name = 'PrecisionError';
  }
}

/**
 * `"77108.15"` at 1 decimal -> `771081n` (floor) / `771082n` (ceil).
 *
 * `'exact'` refuses to round: a size that does not fit the step is a caller
 * bug, and silently trimming it changes the order.
 */
export function toScaled(value: Decimal, decimals: number, rounding: Rounding = 'exact'): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`not a decimal string: "${value}"`);
  const [, sign, whole = '0', fraction = ''] = match;
  const negative = sign === '-';

  const kept = fraction.slice(0, decimals).padEnd(decimals, '0');
  let magnitude = BigInt(whole + kept);
  const truncated = /[1-9]/.test(fraction.slice(decimals));
  if (truncated) {
    if (rounding === 'exact') throw new PrecisionError(value, decimals);
    // Toward +inf for ceil, toward -inf for floor.
    if ((rounding === 'ceil' && !negative) || (rounding === 'floor' && negative)) magnitude += 1n;
  }
  return negative ? -magnitude : magnitude;
}

/** `771081n` at 1 decimal -> `"77108.1"`. Trailing zeros dropped; zero is `"0"`. */
export function fromScaled(value: bigint | number | string, decimals: number): Decimal {
  const n = BigInt(value);
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== '0' ? `-${body}` : body;
}

/** `10^-decimals` as a decimal string: the tick for `decimals` places. */
export function unit(decimals: number): Decimal {
  return fromScaled(1n, decimals);
}

/**
 * Integer division rounded half away from zero. Used where a ratio of two
 * exact integers must become one integer (average prices, bps offsets).
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}
