/**
 * Decimal strings <-> bigint atoms, without ever going through a float.
 *
 * Plain node, no React Native: the mandate form and the fund sheet both parse
 * what a person typed, and `amounts.test.ts` pins the edge cases.
 */

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Canonicalises a typed number: trims, fills a bare leading or trailing dot,
 * and drops redundant zeros. Returns `null` for anything that is not a plain
 * non-negative decimal. Commas are refused rather than guessed at: "1,5" is
 * 1.5 in half the world and 15 in the other half.
 */
export function normalizeDecimal(input: string): string | null {
  let text = input.trim();
  if (text === '' || text === '.') return null;
  if (text.startsWith('.')) text = `0${text}`;
  if (text.endsWith('.')) text = text.slice(0, -1);
  text = text.replace(/^0+(?=\d)/, '');
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return DECIMAL.test(text) ? text : null;
}

/** Typed amount -> atoms. `null` if it doesn't parse or has more decimals than the token. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const normal = normalizeDecimal(input);
  if (normal === null) return null;
  const [whole = '0', fraction = ''] = normal.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Atoms -> a display decimal, trailing zeros dropped. `group: false` gives a
 * string `parseAmount` reads back exactly, for pre-filling an input.
 */
export function formatAtoms(
  atoms: bigint,
  decimals: number,
  { group = true }: { group?: boolean } = {},
): string {
  const { sign, whole, fraction } = split(atoms, decimals);
  const trimmed = fraction.replace(/0+$/, '');
  return `${sign}${group ? groupThousands(whole) : whole}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * Atoms -> a balance figure with a FIXED number of decimals: `0.00`, `1,204.50`.
 *
 * `formatAtoms` formats a number someone typed, where trailing zeros are noise.
 * A balance is a column of money, and a column of money lines up or it looks
 * broken: `0` above `1,204.5` above `0.000001` reads as three unrelated things.
 * `places` is how many decimals to show, defaulting to all of the token's.
 *
 * It TRUNCATES, always toward zero, and never rounds. Rounding 0.009 AUSD up to
 * `0.01` tells a user they hold a hundredth they cannot spend, and a balance is
 * read precisely when deciding what it can cover. Showing fewer places than the
 * token has therefore means the figure can be short of the truth — say so on
 * screen rather than in the number.
 */
export function formatFixedAtoms(
  atoms: bigint,
  decimals: number,
  { group = true, places = decimals }: { group?: boolean; places?: number } = {},
): string {
  const shown = Math.max(0, Math.min(places, decimals));
  const { sign, whole, fraction } = split(atoms, decimals);
  const truncated = fraction.slice(0, shown);
  return `${sign}${group ? groupThousands(whole) : whole}${truncated ? `.${truncated}` : ''}`;
}

/** Sign, whole part, and the full zero-padded fraction. No rounding anywhere. */
function split(atoms: bigint, decimals: number): { sign: string; whole: string; fraction: string } {
  const negative = atoms < 0n;
  const magnitude = negative ? -atoms : atoms;
  const base = 10n ** BigInt(decimals);
  return {
    sign: negative ? '-' : '',
    whole: (magnitude / base).toString(),
    fraction: decimals > 0 ? (magnitude % base).toString().padStart(decimals, '0') : '',
  };
}
