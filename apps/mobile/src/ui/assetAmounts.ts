/**
 * Money that is in more than one asset, said exactly (SEN-210): `25.52 USDC ·
 * 20.89 AUSD`, `+0.96 AUSD · −0.13 USDC`, `50.00 AUSD · 0.00999 WETH`.
 *
 * USDC and AUSD are different tokens, so no screen adds them up as dollars
 * and prints the sum: each asset keeps its own amount, and a token with a
 * market price is listed as itself rather than converted. A chart or a bar
 * that needs one number may still sum internally; its text goes through here.
 *
 * Plain node, no React Native, so `assetAmounts.test.ts` runs with no device.
 */
import { BALANCE_PLACES } from './format.ts';
import { signedFigure } from './money.ts';
import { formatPrice as formatPlaces } from './chart/geometry.ts';

/** One asset's amount as an exact, plain decimal string. */
export type AssetAmount = { readonly asset: string; readonly amount: string };

/** The cash currencies, in the order every list prints them. */
const STABLE_ORDER: readonly string[] = ['USDC', 'AUSD'];

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

/** Plain decimals summed exactly; every one must already match `DECIMAL`. */
function sumExact(values: readonly string[]): string {
  const parsed = values.map((value) => DECIMAL.exec(value.trim())!);
  const scale = Math.max(0, ...parsed.map((match) => (match[3] ?? '').length));
  let total = 0n;
  for (const [, sign, whole = '0', fraction = ''] of parsed) {
    const atoms = BigInt(whole + fraction.padEnd(scale, '0'));
    total += sign === '-' ? -atoms : atoms;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - scale)}${fraction}`;
}

function isZero(amount: string): boolean {
  const match = DECIMAL.exec(amount.trim());
  return match !== null && /^0*$/u.test(`${match[2] ?? ''}${match[3] ?? ''}`);
}

/**
 * The amounts merged per asset and summed exactly: USDC, then AUSD, then every
 * other asset in the order it first appeared. A figure that does not parse is
 * left out, never read as zero.
 */
export function addAmounts(...lists: readonly (readonly AssetAmount[])[]): AssetAmount[] {
  const byAsset = new Map<string, string[]>();
  for (const list of lists) {
    for (const { asset, amount } of list) {
      if (!DECIMAL.test(amount.trim())) continue;
      byAsset.set(asset, [...(byAsset.get(asset) ?? []), amount]);
    }
  }
  const assets = [
    ...STABLE_ORDER.filter((asset) => byAsset.has(asset)),
    ...[...byAsset.keys()].filter((asset) => !STABLE_ORDER.includes(asset)),
  ];
  return assets.map((asset) => ({ asset, amount: sumExact(byAsset.get(asset) ?? []) }));
}

/** `{ USDC: '1', AUSD: '2' }` as a list, in the printed order. */
export function amountsOf(record: Readonly<Record<string, string>>): AssetAmount[] {
  return addAmounts(Object.entries(record).map(([asset, amount]) => ({ asset, amount })));
}

/**
 * How many places `asset` shows: 2 for a stablecoin, the token's balance
 * places otherwise (MON 4, anything else 4), and enough more for three
 * significant digits under 1, so `0.009991 WETH` reads `0.00999`, not `0.0099`.
 */
export function placesFor(asset: string, amount: string): number {
  const places = BALANCE_PLACES[asset] ?? 4;
  if (STABLE_ORDER.includes(asset)) return places;
  const match = DECIMAL.exec(amount.trim());
  if (match === null || !/^0*$/u.test(match[2] ?? '')) return places;
  const fraction = match[3] ?? '';
  const lead = fraction.length - fraction.replace(/^0+/u, '').length;
  return Math.min(8, Math.max(places, lead + 3));
}

/**
 * An amount TRUNCATED toward zero to `placesFor`, as a plain decimal
 * (`1284.50`): a holding never shows a hundredth it does not have. `null`
 * when `amount` is not a plain decimal.
 */
export function truncatedAmount(amount: string, asset: string): string | null {
  const places = placesFor(asset, amount);
  const match = DECIMAL.exec(amount.trim());
  if (match === null) return null;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const kept = fraction.slice(0, places).padEnd(places, '0');
  const zero = /^0*$/u.test(`${whole}${kept}`);
  return `${sign === '-' && !zero ? '-' : ''}${whole}${places > 0 ? `.${kept}` : ''}`;
}

/** `truncatedAmount`, grouped: `1,284.50`. */
export function amountFigure(amount: string, asset: string): string {
  const plain = truncatedAmount(amount, asset);
  return plain === null ? amount : (formatPlaces(plain, placesFor(asset, amount)) ?? amount);
}

export type AmountsTextOptions = {
  /** P&L: `+0.96 AUSD · −0.13 USDC`, rounded half away from zero to each asset's places. */
  signed?: boolean;
  /** Between assets: ` · ` on one line, `\n` for a column that stacks them. */
  separator?: string;
};

/**
 * `25.52 USDC · 20.89 AUSD`: each non-zero amount with its asset. With every
 * amount zero it is `0.00` and the asset when there is just one to name.
 */
export function amountsText(
  amounts: readonly AssetAmount[],
  { signed = false, separator = ' · ' }: AmountsTextOptions = {},
): string {
  const shown = amounts.filter(({ asset, amount }) =>
    signed ? signedFigure(amount, placesFor(asset, amount))?.tone !== null : !isZero(amount),
  );
  if (shown.length === 0) {
    const only = amounts.length === 1 ? ` ${amounts[0]!.asset}` : '';
    return `0.00${only}`;
  }
  return shown
    .map(({ asset, amount }) => {
      const figure = signed
        ? (signedFigure(amount, placesFor(asset, amount))?.text ?? amount)
        : amountFigure(amount, asset);
      return `${figure} ${asset}`;
    })
    .join(separator);
}

/** A signed list: `+0.96 AUSD · −0.13 USDC`, or `0.00` when nothing moved. */
export function signedAmountsText(amounts: readonly AssetAmount[]): string {
  return amountsText(amounts, { signed: true });
}

/** Every amount rounds to zero at its places: a P&L that moved nothing worth showing. */
export function roundsToZero(amounts: readonly AssetAmount[]): boolean {
  return amounts.every(
    ({ asset, amount }) => signedFigure(amount, placesFor(asset, amount))?.tone === null,
  );
}

/** `'up'` when every non-zero amount gains, `'down'` when every one loses, else `null`. */
export function amountsTone(amounts: readonly AssetAmount[]): 'up' | 'down' | null {
  const tones = new Set(
    amounts
      .map(({ asset, amount }) => signedFigure(amount, placesFor(asset, amount))?.tone ?? null)
      .filter((tone) => tone !== null),
  );
  return tones.size === 1 ? [...tones][0]! : null;
}

/** The amount of `asset` in the list, or `'0'`. */
export function amountOf(amounts: readonly AssetAmount[], asset: string): string {
  return amounts.find((a) => a.asset === asset)?.amount ?? '0';
}
