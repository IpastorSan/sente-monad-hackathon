/**
 * The ≈ $ a value snapshot records (SEN-152): the same figure the Portfolio
 * hero shows, so a chart point and the number above it agree.
 *
 * The user's total mirrors the phone's `portfolio/view.ts` (`holdings` then
 * `allocationParts`): USDC and AUSD at $1, every other token at its Kuru
 * `<asset>-USDC` last price (then mid), Perpl as free AUSD plus each position's
 * margin and unrealised P&L — plus what their agents hold, since the hero's
 * total includes "With agents". An agent's is its own portfolio's
 * `totals.approxUsd`, which the cockpit already shows.
 *
 * `partial` is set when a read failed — a section, an agent, the prices — so
 * the value leaves it out. A token no market prices is left out WITHOUT the
 * flag, as the phone does: that gap is permanent, not a failed read, and
 * flagging it would mark every point.
 *
 * Exact decimals throughout: `Number` never touches the money.
 */
import {
  addScaled,
  decimalOf,
  decimalString,
  subScaled,
  type Scaled,
} from '../../agents/events/verdict';
import { mulDecimal } from '../../agents/tools/decimal';
import type {
  AgentPortfolioDto,
  BalanceDto,
  Decimal,
  TickerDto,
} from '../../venues/dto/markets.dto';
import type { PortfolioDto } from '../dto/portfolio.dto';

/** Kuru quotes in USDC, Perpl settles in AUSD: both counted as $1 (the phone's `STABLES`). */
const STABLES: readonly string[] = ['USDC', 'AUSD'];

export interface Valuation {
  readonly usd: Decimal;
  readonly partial: boolean;
}

/** Dollar prices by asset, from Kuru's tickers; `null` when the tickers could not be read. */
export type PriceBook = ReadonlyMap<string, Decimal> | null;

export function priceBook(tickers: readonly TickerDto[]): Map<string, Decimal> {
  const prices = new Map<string, Decimal>();
  for (const ticker of tickers) {
    if (ticker.venue !== 'kuru' || !ticker.symbol.endsWith('-USDC')) continue;
    const price = ticker.last ?? ticker.mid;
    if (price !== null) prices.set(ticker.symbol.slice(0, -'-USDC'.length), price);
  }
  return prices;
}

export function agentValuation(portfolio: AgentPortfolioDto): Valuation {
  const partial =
    !portfolio.wallet.ok ||
    !portfolio.kuru.ok ||
    !portfolio.perpl.ok ||
    // A null value is a holding whose mark could not be read: left out of the total.
    portfolio.holdings.some((holding) => holding.value === null);
  return { usd: portfolio.totals.approxUsd, partial };
}

/**
 * The user's own holdings plus `agents` (their agents' valuations; `null` for
 * one whose read failed).
 */
export function userValuation(
  portfolio: PortfolioDto,
  prices: PriceBook,
  agents: readonly (Valuation | null)[],
): Valuation {
  const parts: Decimal[] = [];
  let partial = false;
  const priced = (asset: string, amount: Decimal) => {
    if (STABLES.includes(asset)) return parts.push(amount);
    if (!/[1-9]/.test(amount)) return;
    if (prices === null) {
      partial = true;
      return;
    }
    const price = prices.get(asset);
    if (price !== undefined) parts.push(mulDecimal(amount, price));
  };

  const { wallet, kuru, perpl } = portfolio;
  if (wallet.ok) for (const b of wallet.balances) priced(b.symbol, b.amount);
  else partial = true;

  if (kuru.ok) for (const b of kuru.balances) priced(b.asset, b.total);
  else partial = true;

  if (perpl.ok) {
    const positions = perpl.status === 'ok' ? (perpl.positions ?? []) : [];
    parts.push(
      perplFree(
        perpl.balances ?? [],
        positions.map((p) => p.margin),
      ),
    );
    for (const p of positions) parts.push(p.margin, p.unrealizedPnl);
  } else {
    partial = true;
  }

  for (const agent of agents) {
    if (agent === null) {
      partial = true;
      continue;
    }
    parts.push(agent.usd);
    if (agent.partial) partial = true;
  }
  return { usd: sum(parts), partial };
}

/**
 * Free AUSD in the Perpl account: with `ok` its balance includes the margin
 * the positions already count, so that comes off (the phone's `perplCash`).
 */
function perplFree(balances: readonly BalanceDto[], margins: readonly Decimal[]): Decimal {
  const total = scaledSum(balances.filter((b) => b.asset === 'AUSD').map((b) => b.total));
  const free = subScaled(total, scaledSum(margins));
  return free.units < 0n ? '0' : decimalString(free);
}

function scaledSum(values: readonly Decimal[]): Scaled {
  let total: Scaled = { units: 0n, scale: 0 };
  for (const value of values) {
    const parsed = decimalOf(value);
    // An unparsable figure is a bug upstream; summing it as zero would hide it.
    if (!parsed) throw new RangeError(`value history: "${value}" is not a decimal`);
    total = addScaled(total, parsed);
  }
  return total;
}

export function sum(values: readonly Decimal[]): Decimal {
  return decimalString(scaledSum(values));
}
