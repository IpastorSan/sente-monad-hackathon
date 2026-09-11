/**
 * Exact comparison of non-negative decimal strings, for the notional cap.
 *
 * Never through `Number`: `"250.5"` against `"250.50000000000000001"` must say
 * which is larger, and a float cannot.
 */
import type { Decimal } from '@sente/venues';

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** A non-negative decimal string with no exponent, sign or leading zeros. */
export function isDecimal(value: unknown): value is Decimal {
  return typeof value === 'string' && DECIMAL.test(value);
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  for (const value of [a, b]) {
    if (!isDecimal(value)) throw new RangeError(`compareDecimal: "${value}" is not a decimal`);
  }
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(scale, '0'));
  const y = BigInt(bi + bf.padEnd(scale, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
