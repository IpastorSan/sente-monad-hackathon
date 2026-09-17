/**
 * The agent's mandate as one line, for the leaderboard row (SEN-26).
 *
 * A leaderboard that ranks agents without saying what each one is allowed to
 * do is comparing them on nothing: an agent capped at 50 per order and one
 * capped at 5,000 are not running the same race. This is the caption, not an
 * audit — `apps/mobile/src/agents/mandate.ts#describeMandate` is the full
 * reading, with each limit labelled by who enforces it.
 */
import type { Mandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS } from '@sente/venues/kuru';

/** Markets named per venue before the list is elided. A row is one line. */
export const SUMMARY_MARKETS = 2;

export function summariseMandate(mandate: Mandate): string {
  const parts: string[] = [];
  if (mandate.venues.includes('kuru')) {
    parts.push(`Kuru ${list(mandate.kuru.markets.map(kuruSymbol))}`);
  }
  if (mandate.venues.includes('perpl')) {
    parts.push(`Perpl ${list([...mandate.perpl.markets])}`);
  }
  parts.push(`max ${mandate.maxOrderNotional} per order`);
  return parts.join(' · ');
}

/** Kuru's mandate holds OrderBook addresses; the table names their markets. */
function kuruSymbol(address: string): string {
  const market = KURU_TESTNET_MARKETS.find(
    (candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
  );
  return market?.symbol ?? address;
}

function list(markets: readonly string[]): string {
  if (markets.length === 0) return 'no markets';
  const shown = markets.slice(0, SUMMARY_MARKETS).join(', ');
  return markets.length > SUMMARY_MARKETS ? `${shown} +${markets.length - SUMMARY_MARKETS}` : shown;
}
