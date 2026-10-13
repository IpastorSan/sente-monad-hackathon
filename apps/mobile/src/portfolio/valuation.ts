/**
 * A total as ONE dollar figure and its breakdown by coin (SEN-215).
 *
 * The owner asked for a single number: `$560.12`, no `≈`, and under it what
 * it is made of — one row per coin with its amount, the price it was counted
 * at and the dollars that came to. The price is the one the hero's chart and
 * the allocation bar already use (`usdPrice`): USDC and AUSD at $1, any other
 * token at its Kuru last price. A coin nothing prices (MON while its Kuru book
 * is empty) is still a row, said "no price — not counted", never dropped and
 * never counted as zero.
 *
 * The headline is the SUM OF THE ROWS AS PRINTED: each row's dollars are
 * floored to the cent first and the total adds those, so the figures on the
 * screen always add up exactly, and no row or total shows a cent you don't
 * have.
 *
 * Pure, no React Native: `valuation.test.ts` pins it under plain node.
 */
import type { TickerDto } from '../markets/api.ts';
import { sumDecimals } from '../agents/ledgerView.ts';
import { compareAmounts, isZero, type AssetAmount } from '../ui/assetAmounts.ts';
import { formatPrice as formatPlaces } from '../ui/chart/geometry.ts';

import { floorTo, money, mulDecimal, STABLES, usdPrice } from './view.ts';

/** One coin of a total. */
export type CoinValue = {
  asset: string;
  /** Exact, as held. */
  amount: string;
  /** Dollars per unit; `null` when nothing prices it. */
  price: string | null;
  /** `stable` is the $1 rule, `kuru` the Kuru last price. */
  source: 'stable' | 'kuru' | null;
  /** `amount × price` floored to the cent; `null` when unpriced. */
  usd: string | null;
};

export type Valuation = {
  /** The headline: the rows' `usd`, summed exactly. Always 2 places. */
  usd: string;
  /** Priced coins, largest first, then the unpriced ones. */
  rows: CoinValue[];
  /** The coins left out of `usd` because nothing prices them. */
  unpriced: string[];
};

/** `amounts` valued at the app's prices. Zero amounts are not rows. */
export function valuation(
  amounts: readonly AssetAmount[],
  tickers: readonly TickerDto[],
): Valuation {
  const rows: CoinValue[] = [];
  for (const { asset, amount } of amounts) {
    if (isZero(amount) || compareAmounts(amount, '0') === null) continue;
    const price = usdPrice(asset, tickers);
    const product = price === null ? null : mulDecimal(amount, price);
    rows.push({
      asset,
      amount,
      price,
      source: price === null ? null : STABLES.includes(asset) ? 'stable' : 'kuru',
      usd: product === null ? null : floorTo(product),
    });
  }
  const priced = rows.filter((r) => r.usd !== null);
  const unpriced = rows.filter((r) => r.usd === null);
  priced.sort((a, b) => compareAmounts(b.usd!, a.usd!) ?? 0);
  const usd = floorTo(sumDecimals(priced.map((r) => r.usd!)) ?? '0') ?? '0.00';
  return { usd, rows: [...priced, ...unpriced], unpriced: unpriced.map((r) => r.asset) };
}

/** `$560.12`: a dollar figure as the screen prints it, floored to the cent. */
export function dollars(usd: string | null): string {
  if (usd === null) return '—';
  const text = money(usd);
  return text.startsWith('−') ? `−$${text.slice(1)}` : `$${text}`;
}

/** `@ $1` for a stablecoin, `@ $2,542.20 Kuru` for a token at its Kuru price. */
export function priceLabel(row: Pick<CoinValue, 'price' | 'source'>): string | null {
  if (row.price === null) return null;
  if (row.source === 'stable') return '@ $1';
  const places = Math.abs(Number(row.price)) < 10 ? 4 : 2;
  return `@ $${formatPlaces(row.price, places) ?? row.price} Kuru`;
}

/** What a breakdown says under the headline about the coins it could not count. */
export function unpricedNote(unpriced: readonly string[]): string | null {
  if (unpriced.length === 0) return null;
  return `${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no Kuru price, so ${
    unpriced.length === 1 ? 'it is' : 'they are'
  } not counted.`;
}
