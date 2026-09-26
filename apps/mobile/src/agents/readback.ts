/**
 * The mandate read back as one sentence, while it is being drawn (SEN-59).
 *
 * The mandate step pins this under the fields so the review step confirms
 * rather than surprises: "May trade MON-USDC on Kuru, up to 50 USDC an order,
 * until Oct 3." It reads the FORM, not a built mandate, because it has to keep
 * talking while the form is half-filled; a missing piece is said as missing
 * rather than guessed at. The full, enforcer-by-enforcer read-back is still
 * `describeMandate` on the review step.
 *
 * Plain node, no React Native, so `readback.test.ts` runs without a device.
 */
import { normalizeDecimal } from './amounts.ts';
import { formatNotional, marketFor, parsePerplMarkets, type MandateForm } from './mandate.ts';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `Oct 2`, in UTC — the same day `formatExpiry` prints, on every device. */
export function formatDay(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}`;
}

/**
 * What "largest single order" is counted in: the quote token of the venues
 * picked. USDC on Kuru, AUSD on Perpl; with both, either.
 */
export function orderUnit(form: Pick<MandateForm, 'kuru' | 'perpl'>): string | undefined {
  if (form.kuru && form.perpl) return 'USDC or AUSD';
  if (form.kuru) return 'USDC';
  if (form.perpl) return 'AUSD';
  return undefined;
}

/** `A`, `A and B`, `A, B and C`. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

export function readBack(form: MandateForm, expiresAt: number): string {
  if (!form.kuru && !form.perpl) return 'Can’t trade anywhere yet. Pick a venue.';

  const places: string[] = [];
  if (form.kuru) {
    const markets = form.kuruMarkets.map((address) => marketFor(address)?.symbol ?? address);
    places.push(
      markets.length > 0 ? `${listOf(markets)} on Kuru` : 'on Kuru once you pick a market',
    );
  }
  if (form.perpl) {
    const markets = parsePerplMarkets(form.perplMarkets);
    const leverage = normalizeDecimal(form.maxLeverage);
    places.push(
      (markets.length > 0 ? `${listOf(markets)} on Perpl` : 'on Perpl once you name a market') +
        (leverage !== null && Number(leverage) > 0 ? ` at up to ${leverage}× leverage` : ''),
    );
  }

  const notional = normalizeDecimal(form.maxOrderNotional);
  const order =
    notional !== null && notional !== '0'
      ? `, up to ${formatNotional(notional)} ${orderUnit(form) ?? ''} an order`
      : '';

  return `May trade ${places.join(' and ')}${order}, until ${formatDay(expiresAt)}.`;
}
