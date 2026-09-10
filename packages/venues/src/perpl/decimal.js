const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;
/** A value with more precision than the venue accepts, under `'exact'` rounding. */
export class PrecisionError extends Error {
  constructor(value, decimals) {
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
export function toScaled(value, decimals, rounding = 'exact') {
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
export function fromScaled(value, decimals) {
  const n = BigInt(value);
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== '0' ? `-${body}` : body;
}
/** `10^-decimals` as a decimal string: the tick for `decimals` places. */
export function unit(decimals) {
  return fromScaled(1n, decimals);
}
/**
 * Integer division rounded half away from zero. Used where a ratio of two
 * exact integers must become one integer (average prices, bps offsets).
 */
export function divRound(numerator, denominator) {
  if (denominator === 0n) throw new Error('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}
