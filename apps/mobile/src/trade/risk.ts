/**
 * The risk disclosure before a wallet's first manual trade on a venue
 * (SEN-179). Pure, so `risk.test.ts` pins every claim under plain node; the
 * review steps draw it with `RiskDisclosure.tsx`.
 *
 * Each claim is one the code makes true, and says where:
 *
 * - Market orders are bounded and may partially fill: a Kuru market order is
 *   an IOC limit at the ticket's max slippage (`TicketScreen.tsx`), a Perpl
 *   one an IOC at 1% of the mark (`PERP_MAX_SLIPPAGE`); whatever can't fill
 *   inside the bound is cancelled.
 * - Perps are isolated-margin positions with leverage, which Perpl liquidates.
 * - On the web, Perpl orders go through Sente's relay (docs/web.md, SEN-175):
 *   it can never withdraw, but it holds the signed-in socket.
 * - Neither venue offers stop-loss or take-profit on testnet (brief: "SL/TP are
 *   never venue orders").
 * - Monad testnet tokens have no value.
 */

export type RiskVenue = 'kuru' | 'perpl';

export type RiskPoint = {
  readonly key: string;
  readonly text: string;
  /** An in-app page that explains it further. */
  readonly link?: { readonly label: string; readonly href: string };
};

/** The "How trading works" page and its anchors (built with the help pages). */
export const HOW_TRADING_WORKS = '/how-it-works#trading';
export const HOW_THE_RELAY_WORKS = '/how-it-works#relay';

export function riskTitle(venue: RiskVenue): string {
  return venue === 'perpl' ? 'Before your first perp trade' : 'Before your first spot trade';
}

export function riskPoints(venue: RiskVenue, web: boolean): RiskPoint[] {
  const perps = venue === 'perpl';
  const points: RiskPoint[] = [
    { key: 'loss', text: 'You can lose money. Prices move against you as easily as for you.' },
  ];
  if (perps) {
    points.push({
      key: 'leverage',
      text: 'Perps use leverage: a move against you costs a multiple of it, and Perpl can liquidate the position, and you lose its margin.',
    });
  }
  points.push({
    key: 'market',
    text: perps
      ? 'A market order can fill up to 1% away from the mark, and may fill only in part; the rest is cancelled.'
      : 'A market order can fill worse than the price shown, up to the max slippage on the ticket, and may fill only in part; the rest is cancelled.',
  });
  if (perps && web) {
    points.push({
      key: 'relay',
      text: 'In the browser, your perp orders go through Sente’s relay to Perpl. It can’t withdraw, but it sits between you and Perpl.',
      link: { label: 'How the relay works', href: HOW_THE_RELAY_WORKS },
    });
  }
  points.push(
    {
      key: 'stops',
      text: 'There’s no stop-loss or take-profit on testnet: nothing closes a position for you.',
    },
    { key: 'testnet', text: 'This is Monad testnet. The tokens have no value.' },
  );
  return points;
}

/** Where a wallet's acknowledgement for a venue is kept (`platform/kv`; `[A-Za-z0-9._-]` only). */
export function riskAckKey(venue: RiskVenue, wallet: string): string {
  return `sente.riskAck.v1.${venue}.${wallet.toLowerCase()}`;
}
