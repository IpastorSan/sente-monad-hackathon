/** Exact arithmetic on the non-negative decimal strings the venues use. Never through `Number`. */
import { compareDecimal, isDecimal } from '@sente/mandate';
import type { Decimal } from '@sente/venues';

export function mulDecimal(a: Decimal, b: Decimal): Decimal {
  for (const value of [a, b]) {
    if (!isDecimal(value)) throw new RangeError(`mulDecimal: "${value}" is not a decimal`);
  }
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = af.length + bf.length;
  const digits = (BigInt(ai + af) * BigInt(bi + bf)).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function maxDecimal(a: Decimal, b: Decimal): Decimal {
  return compareDecimal(a, b) >= 0 ? a : b;
}

export function isPositiveDecimal(value: unknown): value is Decimal {
  return isDecimal(value) && /[1-9]/.test(value);
}
