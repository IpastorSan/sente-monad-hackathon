/**
 * The one signed-money formatter (SEN-136). Every P&L, change and signed
 * percent on screen goes through `signedFigure`, so they all agree on three
 * rules that five separate formatters used to each get slightly wrong:
 *
 * - Exact: the digits are rounded as a bigint, never through a float, so
 *   `-2.675` → `−2.68` (a float says `2.67499…`) and an 18-digit wei-scale
 *   figure keeps every digit.
 * - Half away from zero, on the magnitude: `-0.005` → `−0.01`, like `0.005`.
 * - The sign and the mint/berry tone come from the ROUNDED figure: something
 *   that prints as zero is `0.00`, unsigned and untinted — never `−0.00`.
 *
 * Plain node, no React Native, so `money.test.ts` runs with no device.
 */
import { groupThousands } from '../agents/amounts.ts';

/** A true minus, as every figure in the app prints it; a hyphen reads as a dash. */
export const MINUS = '−';

export type Tone = 'up' | 'down' | null;

export type SignedFigure = {
  sign: '+' | typeof MINUS | '';
  /** The rounded magnitude as a plain decimal (`1234.50`), for `BigNumber`. */
  plain: string;
  /** The rounded magnitude, grouped (`1,234.50`). */
  magnitude: string;
  /** Sign and grouped magnitude: `+1,234.50`, `−0.40`, `0.00`. */
  text: string;
  tone: Tone;
};

/**
 * A plain decimal, optionally signed (`-`, `+` or a true `−`, which is what
 * our own labels print), optionally in exponent form: `String(1e-7)` is
 * `'1e-7'` and a venue can send the same.
 */
const NUMBER = /^([+\-−]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u;

/**
 * Past this an exponent is not a price or a P&L, and expanding it would build
 * a string of that many zeros.
 */
const MAX_EXPONENT = 400;

/**
 * `value` at `places` decimals, signed and toned from the rounded figure.
 * `trim` drops trailing fractional zeros (`+12.4`, `0`) for the Ledger's
 * "venue precision" figures. `null` when `value` is not a finite number.
 */
export function signedFigure(
  value: string | number | null | undefined,
  places: number,
  { trim = false }: { trim?: boolean } = {},
): SignedFigure | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  // `String` of a number is its shortest round-trip form (`-2.675`, `1e-7`),
  // which is the figure the caller meant; `toFixed` would round in binary.
  const match = NUMBER.exec(String(value).trim());
  if (!match) return null;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  if (whole === '' && fraction === '') return null;
  const shift = Number(exponent);
  if (Math.abs(shift) > MAX_EXPONENT) return null;

  // The number is `digits × 10^-scale`; bring it to `places` decimals.
  let digits = `${whole}${fraction}`;
  let scale = fraction.length - shift;
  if (scale < places) {
    digits += '0'.repeat(places - scale);
    scale = places;
  }
  const drop = scale - places;
  const kept = drop >= digits.length ? 0n : BigInt(digits.slice(0, digits.length - drop));
  // Half away from zero: the first dropped digit alone says whether the rest
  // is at least half a unit, and it rounds the magnitude, whatever the sign.
  const first = drop > 0 && drop <= digits.length ? digits[digits.length - drop] : '0';
  const rounded = kept + ((first ?? '0') >= '5' ? 1n : 0n);

  const padded = rounded.toString().padStart(places + 1, '0');
  const intPart = padded.slice(0, padded.length - places);
  let fracPart = padded.slice(padded.length - places);
  if (trim) fracPart = fracPart.replace(/0+$/u, '');
  const dot = fracPart === '' ? '' : `.${fracPart}`;
  const plain = `${intPart}${dot}`;
  const magnitude = `${groupThousands(intPart)}${dot}`;

  const tone: Tone = rounded === 0n ? null : sign === '-' || sign === MINUS ? 'down' : 'up';
  const shown = tone === 'up' ? '+' : tone === 'down' ? MINUS : '';
  return { sign: shown, plain, magnitude, text: `${shown}${magnitude}`, tone };
}
