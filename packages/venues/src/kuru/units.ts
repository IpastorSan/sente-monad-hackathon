/**
 * Exact conversion between Sente's decimal strings and Kuru's integers.
 *
 * Kuru has three integer domains and mixing them up is silent:
 *
 *   book price   `rawPrice / pricePrecision`          quote per base, uint32
 *   book size    `quantity / sizePrecision`           base, uint96
 *   token atoms  `amount / 10^decimals`               deposits, balances
 *
 * and `rawBaseAtoms = quantity * baseSizeMultiplier`. Every precision is a power
 * of ten, which is what makes the conversions below exact.
 *
 * Nothing here rounds an order input. viem's `parseUnits` rounds excess
 * fractional digits away without complaint; a trading client that does that
 * places a different order from the one the user typed. So parsing is strict
 * and refuses, and only derived display values (averages, ratios) are floored.
 */
import { formatUnits } from 'viem';

export class KuruUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KuruUnitsError';
  }
}

const NON_NEGATIVE_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** `10^n` -> `n`. Throws for anything that is not a power of ten. */
export function precisionDecimals(precision: bigint): number {
  const digits = precision.toString();
  if (!/^10*$/.test(digits)) {
    throw new KuruUnitsError(`precision ${digits} is not a power of ten`);
  }
  return digits.length - 1;
}

/**
 * Parses a non-negative decimal string into integer units.
 *
 * Refuses rather than rounds when `value` carries more precision than
 * `decimals` can hold — trailing zeros excepted, so `"1.50"` at 1 decimal is
 * fine and `"1.55"` is not.
 */
export function toUnits(value: string, decimals: number, what = 'value'): bigint {
  const match = NON_NEGATIVE_DECIMAL.exec(value.trim());
  if (!match) {
    throw new KuruUnitsError(`${what} "${value}" is not a non-negative decimal`);
  }
  const whole = match[1]!;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) {
    throw new KuruUnitsError(`${what} "${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** Integer units -> decimal string. Exact; no trailing zeros. */
export function fromUnits(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

/**
 * `numerator / denominator` as a decimal string with at most `scale` fractional
 * digits, truncated toward zero. For derived values only — never for an order
 * input.
 */
export function ratioToDecimal(numerator: bigint, denominator: bigint, scale = 18): string {
  if (denominator === 0n) {
    throw new KuruUnitsError('division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const abs = (n: bigint) => (n < 0n ? -n : n);
  const scaled = (abs(numerator) * 10n ** BigInt(scale)) / abs(denominator);
  const text = formatUnits(scaled, scale);
  return negative && scaled !== 0n ? `-${text}` : text;
}
