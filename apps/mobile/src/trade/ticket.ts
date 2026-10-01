/**
 * The spot order ticket's rules (SEN-119, plan U-13; the study's `trade.html`
 * → "Spot ticket on Kuru" and "Results"). Plain TS, no React Native, so
 * `ticket.test.ts` runs under plain node; `trade/TicketScreen.tsx`
 * only lays out what this decides.
 *
 * What the ticket owns, and why it is here rather than in the screen:
 *
 * - **Amount ↔ size.** A market buy is typed in USDC ("what you spend") but
 *   Kuru orders are sized in the base, so the size is derived. It is derived
 *   against the WORST price the order may pay plus the taker fee, not the
 *   estimated fill: then the most the order can lock (`depositCapAtoms`, the
 *   bound the verifier enforces) never exceeds what was typed, and "Max"
 *   really is spendable. The est. fill only decorates the "≈" line.
 * - **The CTA's label.** The button carries the reason it is disabled
 *   ("Enter an amount", "Insufficient USDC", "Below Kuru's minimum (1.00
 *   USDC)") and never reads a bare "Buy".
 * - **The disclosure line.** It is the order's contract: est. fill, fee and
 *   the slippage that becomes the IOC's limit.
 * - **The result.** Filled, partly filled or resting, said plainly: "Filled
 *   62% · rest cancelled", and where the unspent money is right now.
 *
 * All money is bigint atoms or decimal strings; nothing here goes through a
 * float except the display-only fill percentage.
 */
import { fromUnits, precisionDecimals, ratioToDecimal } from '@sente/venues/kuru';

import { formatPrice } from '../ui/tradingFormat.ts';
import { groupThousands, normalizeDecimal } from '../agents/amounts.ts';
import { depositCapAtoms } from './kuruMarket.ts';
import type { KuruPlaceResult, StepStatus, TradeFunds } from './types.ts';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

/** Kuru fee rates are parts per ten million (as in `kuruMarket.ts`). */
const PPS = 10_000_000n;
const BPS = 10_000;

/** The default slippage: the study's 0.5%. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** What the gear offers: the study's 0.1–3%. */
export const SLIPPAGE_CHOICES_BPS: readonly number[] = [10, 50, 100, 300];

/**
 * Monad keeps 10 MON in an account that sends (the API's `reserve_balance`
 * refusal), so a MON sell can only draw the wallet's MON above that.
 */
export const MON_RESERVE_ATOMS = 10n * 10n ** 18n;

/** A review older than this falls back to "Refresh quote" (the study's 10 s). */
export const QUOTE_MAX_AGE_MS = 10_000;

/** What the ticket needs to know about one Kuru market. */
export type TicketMarket = {
  readonly symbol: string;
  readonly base: { readonly symbol: string; readonly decimals: number };
  readonly quote: { readonly symbol: string; readonly decimals: number };
  /** Book price units per 1 quote-per-base. */
  readonly pricePrecision: bigint;
  /** Book size units per 1 base. */
  readonly sizePrecision: bigint;
  /** Book price units. */
  readonly tickSize: bigint;
  readonly takerFeePps: bigint;
  readonly makerFeePps: bigint;
  /** Kuru's minimum order value, in quote units; `null` when the venue has none. */
  readonly minNotional: string | null;
};

/** The quote fields the ticket reads (`QuoteDto`). */
export type TicketQuote = {
  readonly averagePrice: string | null;
  readonly estimatedFee: string;
  readonly minNotionalOk: boolean | null;
  readonly partial: boolean;
  readonly stale: boolean;
};

// ─── Units ──────────────────────────────────────────────────────────────────

/**
 * A typed decimal → integer units at `precision` (a power of ten), truncated.
 * Unlike the adapter's `toUnits` this truncates instead of refusing, because
 * a person typing "0.1234567" into a 6-decimal field meant roughly that much.
 * `null` for anything that is not a plain non-negative decimal.
 */
export function toUnits(value: string, precision: bigint): bigint | null {
  const normal = normalizeDecimal(value);
  if (normal === null) return null;
  const digits = precisionDecimals(precision);
  const [whole = '0', fraction = ''] = normal.split('.');
  return BigInt(whole + fraction.padEnd(digits, '0').slice(0, digits));
}

/** Integer units at `precision` → an exact decimal string, no grouping. */
export function unitsToDecimal(units: bigint, precision: bigint): string {
  return fromUnits(units, precisionDecimals(precision));
}

/** A fee fraction as `/markets` sends it (`'0.0007'` = 7 bps) → Kuru's parts per ten million. */
export function feePpsOf(fraction: string): bigint {
  return toUnits(fraction, PPS) ?? 0n;
}

/**
 * The largest size (book size units) whose worst-case cost at `priceUnits`
 * plus `feePps` fits in `spendAtoms` of the quote token.
 *
 * The inverse of `depositCapAtoms` for a buy, floored: for the size returned,
 * `depositCapAtoms(...) <= spendAtoms` always holds, which is what makes a
 * typed amount (and "Max") an honest ceiling on what the order can lock.
 */
export function sizeForSpend(
  spendAtoms: bigint,
  priceUnits: bigint,
  feePps: bigint,
  market: Pick<TicketMarket, 'pricePrecision' | 'sizePrecision' | 'quote'>,
): bigint {
  if (spendAtoms <= 0n || priceUnits <= 0n) return 0n;
  const numerator = spendAtoms * market.pricePrecision * market.sizePrecision * PPS;
  const denominator = priceUnits * 10n ** BigInt(market.quote.decimals) * (PPS + feePps);
  return numerator / denominator;
}

/** Base atoms a sell of `sizeUnits` locks: exactly its size, rounded up (as `depositCapAtoms`). */
function baseAtomsFor(sizeUnits: bigint, market: TicketMarket): bigint {
  const numerator = sizeUnits * 10n ** BigInt(market.base.decimals);
  return (numerator + market.sizePrecision - 1n) / market.sizePrecision;
}

/**
 * What the user can fund an order with: the wallet (above any reserve the
 * chain insists on) plus what already sits free in their Kuru account —
 * "have" means both, as the study says.
 */
export function spendable(walletAtoms: bigint, kuruAtoms: bigint, reserveAtoms = 0n): bigint {
  const fromWallet = walletAtoms > reserveAtoms ? walletAtoms - reserveAtoms : 0n;
  return fromWallet + kuruAtoms;
}

// ─── Display ────────────────────────────────────────────────────────────────

/**
 * A size for a sentence ("Buy 203.8 MON"): at least four significant digits,
 * truncated, trailing zeros dropped. Truncated, never rounded up, so the
 * label never promises a fraction more than the order carries.
 */
export function shortSize(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const wholeDigits = whole.replace(/^0+/, '').length;
  let keep: number;
  if (wholeDigits >= 4) keep = 0;
  else if (wholeDigits > 0) keep = 4 - wholeDigits;
  else {
    const lead = fraction.length - fraction.replace(/^0+/, '').length;
    keep = lead + 4;
  }
  const cut = fraction.slice(0, keep).replace(/0+$/, '');
  return `${groupThousands(whole)}${cut ? `.${cut}` : ''}`;
}

/** A price as the kit prints one without a tick: 4 places under 10, else 2. */
export function priceText(value: string): string {
  return formatPrice(value) ?? value;
}

/** Quote money (USDC) at 2 places, grouped. */
export function moneyText(value: string): string {
  return formatPrice(value, '0.01') ?? value;
}

/** Atoms → money at 2 places, rounded UP: for "at most" figures, which must not understate. */
function moneyCeil(atoms: bigint, decimals: number): string {
  const drop = decimals > 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const cents = (atoms + drop - 1n) / drop;
  return moneyText(fromUnits(cents, 2));
}

/** Atoms → money at 2 places, truncated: for balances and "at least" figures. */
function moneyFloor(atoms: bigint, decimals: number): string {
  const drop = decimals > 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const cents = atoms / drop;
  return (
    groupThousands((cents / 100n).toString()) + '.' + (cents % 100n).toString().padStart(2, '0')
  );
}

/** A basis-point slippage as the gear shows it: `0.5%`. */
export function slippageText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** `bps` as the fraction `/markets/quote` takes for `maxSlippage`: 50 → `'0.005'`. */
export function slippageFraction(bps: number): string {
  return ratioToDecimal(BigInt(bps), BigInt(BPS), 6);
}

/** decimal × decimal, exact, as a decimal string. */
function mulDecimal(a: string, b: string): string {
  const [aw = '0', af = ''] = a.split('.');
  const [bw = '0', bf = ''] = b.split('.');
  const product = BigInt(aw + af) * BigInt(bw + bf);
  return fromUnits(product, af.length + bf.length);
}

// ─── Keypad and presets ─────────────────────────────────────────────────────

export type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';

/** The longest thing the amount line can show without shrinking. */
const MAX_CHARS = 12;

/**
 * One keypad press. Refuses input rather than correcting it: a second dot, a
 * decimal past what the field holds, a leading zero before a digit.
 */
export function pressKey(current: string, key: Key, maxDecimals: number): string {
  if (key === 'back') return current.slice(0, -1);
  if (current.length >= MAX_CHARS) return current;
  const dot = current.indexOf('.');
  if (key === '.') {
    if (dot !== -1 || maxDecimals === 0) return current;
    return current === '' ? '0.' : `${current}.`;
  }
  if (dot !== -1 && current.length - dot - 1 >= maxDecimals) return current;
  if (current === '0') return key;
  return current + key;
}

export type Preset = { readonly pct: 10 | 25 | 50 | 100; readonly label: string };
export const PRESETS: readonly Preset[] = [
  { pct: 10, label: '10%' },
  { pct: 25, label: '25%' },
  { pct: 50, label: '50%' },
  { pct: 100, label: 'Max' },
];

/** What the amount field holds for this ticket: quote for a market buy, else base. */
export function amountAsset(side: Side, orderType: OrderType): 'quote' | 'base' {
  return side === 'buy' && orderType === 'market' ? 'quote' : 'base';
}

/** Decimals the amount field accepts: cents for USDC, the book's size step for the base. */
export function amountDecimals(market: TicketMarket, side: Side, orderType: OrderType): number {
  return amountAsset(side, orderType) === 'quote'
    ? Math.min(2, market.quote.decimals)
    : precisionDecimals(market.sizePrecision);
}

/**
 * A % preset → the amount field's new text, or `null` when it can't be
 * computed yet (a limit buy with no price, a balance still loading).
 *
 * `available` is atoms of the funding asset (quote for a buy, base for a
 * sell). Every branch truncates, so "Max" is never a hair over what you have.
 */
export function presetAmount(input: {
  pct: Preset['pct'];
  side: Side;
  orderType: OrderType;
  available: bigint | null;
  limitPriceUnits: bigint | null;
  market: TicketMarket;
}): string | null {
  const { pct, side, orderType, available, limitPriceUnits, market } = input;
  if (available === null) return null;
  const share = (available * BigInt(pct)) / 100n;
  if (amountAsset(side, orderType) === 'quote') {
    const drop = 10n ** BigInt(market.quote.decimals - amountDecimals(market, side, orderType));
    return fromUnits((share / drop) * drop, market.quote.decimals);
  }
  if (side === 'sell') {
    const size = (share * market.sizePrecision) / 10n ** BigInt(market.base.decimals);
    return unitsToDecimal(size, market.sizePrecision);
  }
  if (limitPriceUnits === null || limitPriceUnits <= 0n) return null;
  return unitsToDecimal(
    sizeForSpend(share, limitPriceUnits, market.makerFeePps, market),
    market.sizePrecision,
  );
}

// ─── The ticket ─────────────────────────────────────────────────────────────

export type TicketInput = {
  readonly market: TicketMarket;
  readonly side: Side;
  readonly orderType: OrderType;
  /** The amount field: quote for a market buy, base otherwise. */
  readonly amount: string;
  /** Limit orders only. */
  readonly limitPrice: string;
  readonly slippageBps: number;
  /**
   * The phone's worst price for a market order (`worstPriceUnits` over its own
   * `readMarketFacts`): `undefined` while the book is being read, `null` when
   * the side is empty.
   */
  readonly worstUnits: bigint | null | undefined;
  /** Atoms of the funding asset the user has; `null` while loading. */
  readonly available: bigint | null;
  /** Market orders only; `null` until one arrives. */
  readonly quote: TicketQuote | null;
};

export type TicketProblem =
  | { readonly kind: 'insufficient'; readonly short: string; readonly have: string }
  | { readonly kind: 'minimum'; readonly minimum: string };

export type Ticket = {
  /** Book size units the order carries; `null` until there is one. */
  readonly sizeUnits: bigint | null;
  /** Book price units: the limit, or the market order's worst price. */
  readonly priceUnits: bigint | null;
  /** Atoms of the funding asset the order can lock at most. */
  readonly needAtoms: bigint | null;
  readonly cta: { readonly label: string; readonly enabled: boolean };
  readonly problem: TicketProblem | null;
  /** The line under the amount: `≈ 203.8 MON · at 0.9812`, or the limit's total. */
  readonly sub: string | null;
  /** The contract under the button, one string per line. */
  readonly disclosure: readonly string[];
};

const SIDE_WORD: Record<Side, string> = { buy: 'Buy', sell: 'Sell' };

/**
 * Everything the ticket shows below the amount, from what was typed and what
 * the phone read. The CTA's reasons come in the order a person fixes them:
 * type something, have enough, be big enough, then wait for a fresh quote.
 */
export function evaluateTicket(input: TicketInput): Ticket {
  const { market, side, orderType, quote } = input;
  const base = market.base.symbol;
  const quoteSym = market.quote.symbol;
  const funding = side === 'buy' ? market.quote : market.base;
  const disclosure = disclosureFor(input, null);
  const disabled = (label: string, extra: Partial<Ticket> = {}): Ticket => ({
    sizeUnits: null,
    priceUnits: null,
    needAtoms: null,
    cta: { label, enabled: false },
    problem: null,
    sub: null,
    disclosure,
    ...extra,
  });

  const typed = input.amount === '' ? null : toUnits(input.amount, amountPrecision(input));
  if (typed === null || typed === 0n) return disabled('Enter an amount');

  let priceUnits: bigint | null;
  if (orderType === 'limit') {
    priceUnits = input.limitPrice === '' ? null : toUnits(input.limitPrice, market.pricePrecision);
    if (priceUnits === null || priceUnits === 0n) return disabled('Enter a price');
    if (priceUnits % market.tickSize !== 0n) {
      return disabled(
        `Price must be a multiple of ${unitsToDecimal(market.tickSize, market.pricePrecision)}`,
      );
    }
  } else {
    if (input.worstUnits === undefined) return disabled('Reading the book…');
    if (input.worstUnits === null) {
      return disabled(
        side === 'buy' ? 'No one is selling right now' : 'No one is buying right now',
      );
    }
    priceUnits = input.worstUnits;
  }

  // Size and what it locks, per the four ticket shapes.
  let sizeUnits: bigint;
  let needAtoms: bigint;
  if (side === 'buy' && orderType === 'market') {
    needAtoms = typed;
    sizeUnits = sizeForSpend(typed, priceUnits, market.takerFeePps, market);
  } else {
    sizeUnits = typed;
    needAtoms =
      side === 'sell'
        ? baseAtomsFor(sizeUnits, market)
        : depositCapAtoms({ side, price: priceUnits, quantity: sizeUnits, tif: 'gtc' }, market, {
            quote: market.quote.decimals,
            base: market.base.decimals,
          });
  }

  const size = unitsToDecimal(sizeUnits, market.sizePrecision);
  const price = unitsToDecimal(priceUnits, market.pricePrecision);
  const fillPrice = orderType === 'market' ? (quote?.averagePrice ?? null) : price;
  const sub = subLine(input, size, fillPrice);
  const shared = { sizeUnits, priceUnits, needAtoms, sub, disclosure: disclosureFor(input, size) };

  if (input.available !== null && needAtoms > input.available) {
    return {
      ...shared,
      cta: { label: `Insufficient ${funding.symbol}`, enabled: false },
      problem: {
        kind: 'insufficient',
        short: `${fundText(needAtoms - input.available, funding.decimals, side)} ${funding.symbol}`,
        have: `${fundText(input.available, funding.decimals, side)} ${funding.symbol}`,
      },
    };
  }

  const minimum = market.minNotional;
  const notional =
    side === 'buy' && orderType === 'market'
      ? fromUnits(typed, market.quote.decimals)
      : fillPrice !== null
        ? mulDecimal(size, fillPrice)
        : null;
  const belowMin =
    sizeUnits === 0n ||
    (orderType === 'market' && quote?.minNotionalOk === false) ||
    (minimum !== null && notional !== null && compareDecimal(notional, minimum) < 0);
  if (belowMin) {
    const minLabel = minimum !== null ? ` (${moneyText(minimum)} ${quoteSym})` : '';
    return {
      ...shared,
      cta: { label: `Below Kuru's minimum${minLabel}`, enabled: false },
      problem: { kind: 'minimum', minimum: minimum ?? '' },
    };
  }

  if (orderType === 'market') {
    if (quote === null)
      return { ...shared, cta: { label: 'Getting a quote…', enabled: false }, problem: null };
    if (quote.stale) {
      return {
        ...shared,
        cta: { label: 'Quote is stale, refreshing', enabled: false },
        problem: null,
      };
    }
    return {
      ...shared,
      cta: { label: `${SIDE_WORD[side]} ${shortSize(size)} ${base}`, enabled: true },
      problem: null,
    };
  }
  return { ...shared, cta: { label: `Place limit ${side}`, enabled: true }, problem: null };
}

function amountPrecision(input: TicketInput): bigint {
  return amountAsset(input.side, input.orderType) === 'quote'
    ? 10n ** BigInt(input.market.quote.decimals)
    : input.market.sizePrecision;
}

/** Funding amounts in words: USDC to the cent (rounded up when it's a shortfall), base exact. */
function fundText(atoms: bigint, decimals: number, side: Side): string {
  if (side === 'buy') return moneyCeil(atoms, decimals);
  return shortSize(fromUnits(atoms, decimals));
}

function subLine(input: TicketInput, size: string, fillPrice: string | null): string | null {
  const { market, side, orderType } = input;
  if (orderType === 'limit') {
    if (fillPrice === null) return null;
    return `Total ${moneyText(mulDecimal(size, fillPrice))} ${market.quote.symbol}`;
  }
  if (fillPrice === null) return null;
  if (side === 'buy')
    return `≈ ${shortSize(size)} ${market.base.symbol} · at ${priceText(fillPrice)}`;
  return `≈ ${moneyText(mulDecimal(size, fillPrice))} ${market.quote.symbol} · at ${priceText(fillPrice)}`;
}

function disclosureFor(input: TicketInput, size: string | null): string[] {
  const { market, orderType, quote, slippageBps } = input;
  const q = market.quote.symbol;
  if (orderType === 'limit') {
    const priceUnits =
      input.limitPrice === '' ? null : toUnits(input.limitPrice, market.pricePrecision);
    if (size === null || priceUnits === null || priceUnits === 0n)
      return ['Limit · may fill in parts'];
    const notional = mulDecimal(size, unitsToDecimal(priceUnits, market.pricePrecision));
    const fee = mulDecimal(notional, unitsToDecimal(market.makerFeePps, PPS));
    return [`Limit · may fill in parts · fee on fill ≈ ${moneyText(fee)} ${q}`];
  }
  const slip = `Max slippage ${slippageText(slippageBps)}`;
  if (quote === null || quote.averagePrice === null || size === null) {
    return [`Market · ${slip.toLowerCase()}`];
  }
  return [
    `Market · est. fill ${priceText(quote.averagePrice)} · fee ${moneyText(quote.estimatedFee)} ${q}`,
    slip,
    // Said before the confirm, not discovered on the result screen.
    ...(quote.partial ? ['The book is thin: only part may fill; the rest is cancelled'] : []),
  ];
}

/** Sign of `a - b` for two plain decimals. */
export function compareDecimal(a: string, b: string): number {
  const [aw = '0', af = ''] = a.split('.');
  const [bw = '0', bf = ''] = b.split('.');
  const places = Math.max(af.length, bf.length);
  const x = BigInt(aw + af.padEnd(places, '0'));
  const y = BigInt(bw + bf.padEnd(places, '0'));
  return x === y ? 0 : x > y ? 1 : -1;
}

// ─── Review ─────────────────────────────────────────────────────────────────

export type ReviewRow = {
  readonly label: string;
  readonly value: string;
  readonly chain?: boolean;
};

/**
 * The review sheet's rows. Worst price and the "at most / at least" bound are
 * the numbers the order is signed with, not decoration.
 */
export function reviewRows(input: TicketInput, ticket: Ticket): ReviewRow[] {
  const { market, side, orderType, quote, slippageBps } = input;
  const q = market.quote.symbol;
  const b = market.base.symbol;
  if (ticket.sizeUnits === null || ticket.priceUnits === null || ticket.needAtoms === null)
    return [];
  const size = unitsToDecimal(ticket.sizeUnits, market.sizePrecision);
  const price = unitsToDecimal(ticket.priceUnits, market.pricePrecision);
  const rows: ReviewRow[] = [];

  if (orderType === 'market') {
    if (quote?.averagePrice)
      rows.push({ label: 'Est. fill', value: `${priceText(quote.averagePrice)} ${q}` });
    const sign = side === 'buy' ? '+' : '−';
    rows.push({
      label: 'Worst price',
      value: `${priceText(price)} ${q} · ${sign}${slippageText(slippageBps)}`,
    });
  } else {
    rows.push({ label: 'Limit price', value: `${priceText(price)} ${q}` });
  }
  rows.push({ label: 'Size', value: `${shortSize(size)} ${b}` });

  if (side === 'buy') {
    rows.push({
      label: 'You pay at most',
      value: `${moneyCeil(ticket.needAtoms, market.quote.decimals)} ${q} with fee`,
    });
  } else {
    // A sell's proceeds at the worst (or limit) price, less the taker/maker fee.
    const fee = orderType === 'market' ? market.takerFeePps : market.makerFeePps;
    const gross = mulDecimal(size, price);
    const grossAtoms = toUnits(gross, 10n ** BigInt(market.quote.decimals)) ?? 0n;
    const net = (grossAtoms * (PPS - fee)) / PPS;
    rows.push({
      label: 'You get at least',
      value: `${moneyFloor(net, market.quote.decimals)} ${q}`,
    });
  }
  if (orderType === 'market') {
    if (quote) rows.push({ label: 'Fee', value: `${moneyText(quote.estimatedFee)} ${q}` });
    rows.push({ label: `If it can't fill at ${priceText(price)}`, value: 'the rest is cancelled' });
  } else {
    rows.push({ label: 'Expires', value: "Never · Kuru limits don't expire" });
  }
  rows.push({ label: 'Venue', value: `Kuru · ${market.symbol} book`, chain: true });
  return rows;
}

// ─── Execution ──────────────────────────────────────────────────────────────

/** How a step's stone reads: landed (solid), landing (breathing), waiting (empty), failed. */
export type StepState = 'done' | 'now' | 'wait' | 'failed';

export function stepState(status: StepStatus): StepState {
  switch (status) {
    case 'included':
      return 'done';
    case 'submitted':
      return 'now';
    case 'reverted':
    case 'not_sent':
      return 'failed';
    default:
      return 'wait';
  }
}

export function stepCaption(status: StepStatus): string {
  switch (status) {
    case 'awaiting_signature':
    case 'queued':
      return 'waiting';
    case 'submitted':
      return 'landing';
    case 'included':
      return 'landed';
    case 'reverted':
      return 'reverted';
    case 'not_sent':
      return 'not sent';
    case 'unknown':
      return 'unknown';
  }
}

/** The sheet's opening line, which warns up front that a first trade takes several transactions. */
export function stepsIntro(count: number): string {
  if (count <= 1) return 'One transaction.';
  return `This takes ${count} transactions. Each one lands on its own.`;
}

/** Where money is, as the results and the failure note name it. */
export function fundsLines(funds: TradeFunds | undefined): string[] {
  const where = {
    wallet: 'in your wallet',
    kuru: 'in your Kuru account',
    perpl: 'in your Perpl account',
  };
  return (funds ?? [])
    .filter((f) => compareDecimal(f.amount, '0') > 0)
    .map(
      (f) =>
        `${f.symbol === 'USDC' || f.symbol === 'AUSD' ? moneyText(f.amount) : shortSize(f.amount)} ${f.symbol} · ${where[f.where]}`,
    );
}

// ─── Results ────────────────────────────────────────────────────────────────

export type ResultMark = 'full' | 'half' | 'ring' | 'none';

export type ResultView = {
  readonly mark: ResultMark;
  /** "You bought", "On the book", … */
  readonly lead: string;
  /** The big figure: the filled size (or the resting size), a decimal. */
  readonly amount: string;
  readonly unit: string;
  readonly detail: string;
  /** 0..100, truncated: never claims more filled than was. */
  readonly filledPct: number;
  /** "Filled 62% · rest cancelled"; `null` when it filled whole or not at all. */
  readonly fillLine: string | null;
  /** Why the rest didn't fill, in one sentence; `null` when there is nothing to explain. */
  readonly why: string | null;
  readonly fills: readonly ReviewRow[];
};

/**
 * A place result, said plainly. A partial fill is a half stone, not an error:
 * it says what happened, why, and where the unspent money is.
 */
export function resultView(
  result: KuruPlaceResult,
  ctx: {
    side: Side;
    orderType: OrderType;
    base: string;
    quote: string;
    /** The limit, or the market order's worst price, as a decimal. */
    price: string;
    slippageBps: number;
  },
): ResultView {
  const { side, orderType, base, quote, price, slippageBps } = ctx;
  const filled = result.filledSize;
  const requested = result.requestedSize;
  const pct = filledPct(filled, requested);
  const avg = result.avgPrice ? priceText(result.avgPrice) : null;
  const spent = result.avgPrice ? moneyText(mulDecimal(filled, result.avgPrice)) : null;
  const fee = moneyText(result.fee);
  const verb = side === 'buy' ? 'You bought' : 'You sold';
  const fills = result.fills.map((fill) => ({
    label: `${shortSize(fill.size)} ${base}`,
    value: `at ${priceText(fill.price)} · ${moneyText(mulDecimal(fill.size, fill.price))} ${quote}`,
  }));

  switch (result.status) {
    case 'filled':
      return {
        mark: 'full',
        lead: verb,
        amount: filled,
        unit: base,
        detail:
          avg && spent ? `at ${avg} avg · ${spent} ${quote} + ${fee} fee` : `${fee} ${quote} fee`,
        filledPct: 100,
        fillLine: null,
        why: null,
        fills,
      };
    case 'partially_filled': {
      const resting = orderType === 'limit' && result.unfilledCancelled === undefined;
      return {
        mark: 'half',
        lead: verb,
        amount: filled,
        unit: base,
        detail: `of ${shortSize(requested)}${avg ? ` · at ${avg} avg` : ''}`,
        filledPct: pct,
        fillLine: `Filled ${pct}% · ${resting ? 'rest on the book' : 'rest cancelled'}`,
        why: resting
          ? `The rest waits at ${priceText(price)} until it fills or you cancel it.`
          : `The price moved past your worst price (${priceText(price)}, max slippage ${slippageText(slippageBps)}) before the rest could fill.`,
        fills,
      };
    }
    case 'resting':
      return {
        mark: 'ring',
        lead: 'On the book',
        amount: requested,
        unit: base,
        detail: `${side} at ${priceText(price)} · ${moneyText(mulDecimal(requested, price))} ${quote}`,
        filledPct: pct,
        fillLine: null,
        why: null,
        fills,
      };
    case 'cancelled':
    case 'rejected':
      return {
        mark: 'none',
        lead: 'Nothing filled',
        amount: '0',
        unit: base,
        detail:
          result.status === 'rejected' ? 'Kuru rejected the order' : 'The order was cancelled',
        filledPct: 0,
        fillLine: null,
        why:
          orderType === 'market'
            ? `Nothing on the book matched within your worst price (${priceText(price)}, max slippage ${slippageText(slippageBps)}).`
            : null,
        fills,
      };
  }
}

/** `filled / requested` as a whole percent, truncated. Display only. */
export function filledPct(filled: string, requested: string): number {
  if (compareDecimal(requested, '0') <= 0) return 0;
  const scale = 10n ** 18n;
  const f = toUnits(filled, scale) ?? 0n;
  const r = toUnits(requested, scale) ?? 0n;
  if (r === 0n) return 0;
  const pct = Number((f * 100n) / r);
  return Math.max(0, Math.min(100, pct));
}

// ─── Market picker ──────────────────────────────────────────────────────────

/**
 * The picker's "You hold" rows: spot markets whose base the wallet holds a
 * non-zero balance of, with the holding as the row's caption, so the sheet
 * doubles as a quick "sell / add to" entry. Perp stakes need `/portfolio`
 * (M-T19) and are left out rather than guessed.
 */
export function heldMarkets<M extends { kind: 'spot' | 'perp'; base: string }>(
  markets: readonly M[],
  balances: readonly { symbol: string; raw: bigint; amount: string }[],
): { market: M; holding: string }[] {
  const held = new Map(balances.filter((b) => b.raw > 0n).map((b) => [b.symbol, b.amount]));
  return markets.flatMap((market) => {
    const amount = market.kind === 'spot' ? held.get(market.base) : undefined;
    return amount === undefined ? [] : [{ market, holding: `${shortSize(amount)} ${market.base}` }];
  });
}
