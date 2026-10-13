/**
 * The formatting rules every screen shares. Plain node, no React Native, so
 * `format.test.ts` runs with no device.
 */
import { formatAtoms, formatFixedAtoms } from '../agents/amounts.ts';
import { displayAmount } from './displayAmount.ts';
import type { TokenBalance } from '../wallet/api.ts';

/**
 * How many decimals each token shows, by symbol.
 *
 * NOT the token's own precision: six decimals of AUSD is an account number, not
 * a number anyone reads. Two is what a stablecoin means; MON gets four because
 * gas amounts live below 0.01. An unlisted token falls back to two.
 *
 * It lives here, not in a screen, because every screen that shows a balance —
 * home today, the send sheet in SEN-42 — has to agree. Two screens quoting the
 * same wallet at different precisions reads as a bug in the balance.
 */
export const BALANCE_PLACES: Record<string, number> = { AUSD: 2, USDC: 2, MON: 4 };

/**
 * A balance as a figure, or an em dash for one the API did not send.
 *
 * The dash is deliberate: a token missing from the response means the server's
 * token list and ours disagree, and `0.00` would be a confident lie about
 * money. A stablecoin is truncated (`formatFixedAtoms`), so the figure is
 * never larger than the balance behind it; any other token follows the one
 * token rule, at most 4 places (`displayAmount`, SEN-215).
 */
export function formatBalance(balance: TokenBalance | null): string {
  if (balance === null) return '—';
  return formatTokenAtoms(balance.raw, balance.decimals, balance.symbol);
}

/** `formatBalance` for atoms already in hand: stablecoins truncated to 2, tokens at most 4. */
export function formatTokenAtoms(atoms: bigint, decimals: number, symbol: string): string {
  if (symbol === 'USDC' || symbol === 'AUSD') {
    return formatFixedAtoms(atoms, decimals, { places: BALANCE_PLACES[symbol] ?? 2 });
  }
  return displayAmount(formatAtoms(atoms, decimals, { group: false }));
}

/** `0x1234…abcd`. Lists only — screens that ask for trust show the whole address. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The date part of an ISO timestamp, e.g. `2026-09-11`. Same on every device. */
export function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}
