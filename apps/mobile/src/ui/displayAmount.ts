/**
 * The one rule for how many decimals a token amount SHOWS (SEN-215): at most
 * four, rounded half-up, trailing zeros dropped. `0.013920066 WETH` reads
 * `0.0139 WETH`, `2.5000 MON` reads `2.5 MON`, and a non-zero amount too small
 * for four places reads `<0.0001` rather than a `0` that says nothing is there.
 *
 * Display only. Inputs, editable ticket fields, order payloads and anything
 * sent to the API keep the full precision; prices keep their own formatting.
 * Stablecoin money keeps its two places (`minPlaces`), so a column of USDC
 * still lines up.
 *
 * Plain node, no React Native, so `displayAmount.test.ts` runs with no device.
 */

/** The most decimals a token amount shows anywhere in the app. */
export const DISPLAY_MAX_PLACES = 4;

const DECIMAL = /^([+\-−]?)(\d*)(?:\.(\d*))?$/u;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

export type DisplayAmountOptions = {
  /** Decimals kept even when they are zeros: 2 for stablecoin money. Default 0. */
  minPlaces?: number;
  /** Decimals at most. Default `DISPLAY_MAX_PLACES`. */
  maxPlaces?: number;
  /** Thousands separators. Default on. */
  group?: boolean;
};

/**
 * `value` (a plain decimal, commas tolerated) as a display figure: rounded
 * half-up to `maxPlaces`, trimmed down to `minPlaces`, grouped. Anything that
 * is not a plain decimal (`—`, an exponent) comes back untouched.
 */
export function displayAmount(
  value: string,
  { minPlaces = 0, maxPlaces = DISPLAY_MAX_PLACES, group = true }: DisplayAmountOptions = {},
): string {
  const match = DECIMAL.exec(value.trim().replace(/,/gu, ''));
  if (match === null) return value;
  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return value;
  const max = Math.max(0, maxPlaces);
  const min = Math.min(Math.max(0, minPlaces), max);

  const atoms = BigInt(`${whole}${fraction}` || '0');
  const scale = fraction.length;
  // Half-up on the magnitude: 0.00005 → 0.0001, and −0.00005 → −0.0001.
  let rounded: bigint;
  if (scale <= max) {
    rounded = atoms * 10n ** BigInt(max - scale);
  } else {
    const unit = 10n ** BigInt(scale - max);
    rounded = (atoms + unit / 2n) / unit;
  }

  const negative = sign === '-' || sign === '−';
  const minus = negative ? sign : '';
  if (rounded === 0n) {
    if (atoms === 0n) return min > 0 ? `0.${'0'.repeat(min)}` : '0';
    // Real, but below what four places can say.
    return `${minus}<${max > 0 ? `0.${'0'.repeat(max - 1)}1` : '1'}`;
  }

  const digits = rounded.toString().padStart(max + 1, '0');
  const int = digits.slice(0, digits.length - max);
  let dec = digits.slice(digits.length - max);
  while (dec.length > min && dec.endsWith('0')) dec = dec.slice(0, -1);
  return `${minus}${group ? groupThousands(int) : int}${dec ? `.${dec}` : ''}`;
}
