/**
 * Guardian (SEN-68): hand it a position and two price lines; it sells when
 * price crosses either. It is the preset answer to "where is my stop-loss?",
 * so its one job is to say honestly what kind of stop it is: a line checked
 * every run, never an order resting on the venue (Kuru has no stop orders).
 * Promise and parameters from docs/design/trading/agents.html, "The catalog".
 */
import { formatNumber, marketAssets, num, str } from '../params.ts';
import type { Params, PresetDefinition } from '../types.ts';

const CADENCE_SECONDS = { '1m': 60, '5m': 300 } as const;

/** How far below the best bid a line's market sell may fill, in %. */
const EXIT_SLIPPAGE_PCT = 2;

/**
 * Head-room on the order cap: a line is seen at a check, so price may already
 * be well past `sellAbove` when the sale goes out, and a refused exit is the
 * worst outcome this preset has.
 */
const ORDER_CAP_HEADROOM = 2;

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const { base, quote } = marketAssets(market);
  const amount = formatNumber(num(p, 'amount'));
  const above = formatNumber(num(p, 'sellAbove'));
  const below = formatNumber(num(p, 'sellBelow'));

  const strategy = [
    `Guard up to ${amount} ${base} on ${market}, Kuru spot. You only ever sell; never buy.`,
    '',
    'Every run:',
    `1. If you hold no ${base}, your job is done: say so in one sentence and end the run.`,
    `2. Read the best bid for ${market}.`,
    `3. If the best bid is at or above ${above} ${quote}, or at or below ${below} ${quote}: record a thesis naming the line that was crossed and the bid you saw, then sell up to ${amount} ${base} (all you hold, if less) at market, slippage limit ${EXIT_SLIPPAGE_PCT}% below the best bid.`,
    '4. Otherwise do nothing and end the run in one sentence.',
    '',
    'Both lines are checked every run, not venue orders: between runs price can pass through a line, and the sale fills at the market price when it is seen, which can be past the line.',
  ].join('\n');

  const systemPrompt = [
    'You are a Guardian agent on Sente. Your owner handed you a position and two price lines; you sell it when price crosses either.',
    '',
    `- Sell only. Never buy ${base} or anything else, and never trade a market other than ${market}.`,
    '- The lines are your owner’s. Never move them, and never wait for a better price once a line is crossed.',
    `- If your ${base} sits in your wallet rather than your Kuru account, deposit it before you sell.`,
    '- If a sale is refused or does not fill, say so; the next run checks the lines again.',
    '- When a read fails, do nothing this run and say so in one sentence.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const guardian: PresetDefinition = {
  id: 'guardian',
  version: 1,
  name: 'Guardian',
  tagline: 'Hand it a position and your two lines. It sells when price crosses either.',
  description:
    'It holds the coins you hand it and checks the price on every run. When price is above your ' +
    'upper line or below your lower one, it sells. The lines are checked, not placed on the ' +
    'venue, so a fast move can fill past them. It can only guard coins you hand to it; your own ' +
    'wallet stays yours.',
  venues: ['kuru'],
  params: [
    {
      key: 'market',
      label: 'Asset',
      type: 'market',
      venue: 'kuru',
      multiple: false,
      default: 'MON-USDC',
    },
    {
      key: 'amount',
      label: 'Amount to hand over',
      type: 'number',
      min: 0.000001,
      max: 1_000_000,
      step: 0.000001,
      default: 100,
      help: 'In units of the asset. It never sells more than this.',
    },
    {
      key: 'sellAbove',
      label: 'Sell above',
      type: 'number',
      min: 0.000001,
      max: 1_000_000,
      step: 0.000001,
      unit: 'USDC',
      default: 0.05,
      help: 'Agent-watched: checked every run, not a venue order.',
    },
    {
      key: 'sellBelow',
      label: 'Sell below',
      type: 'number',
      min: 0.000001,
      max: 1_000_000,
      step: 0.000001,
      unit: 'USDC',
      default: 0.01,
      help: 'Agent-watched: checked every run, not a venue order.',
    },
    {
      key: 'cadence',
      label: 'Check every',
      type: 'enum',
      options: [
        { value: '1m', label: '1 min' },
        { value: '5m', label: '5 min' },
      ],
      default: '1m',
    },
  ],
  tools: ['get_depth', 'get_balances', 'record_thesis', 'deposit', 'place_market'],
  suggestedCadenceSeconds: (p) =>
    CADENCE_SECONDS[str(p, 'cadence') as keyof typeof CADENCE_SECONDS],
  suggestedMandate(p) {
    const market = str(p, 'market');
    const { base } = marketAssets(market);
    const cap = num(p, 'amount') * num(p, 'sellAbove') * ORDER_CAP_HEADROOM;
    return {
      tier: 'cautious',
      venues: ['kuru'],
      kuruMarkets: [market],
      perplMarkets: [],
      maxOrderNotional: String(Math.max(1, Math.ceil(cap))),
      maxLeverage: null,
      depositCaps: [{ asset: base, amount: formatNumber(num(p, 'amount')) }],
      perplCollateral: null,
      // A guard is left running; Cautious's one-day expiry would silently drop it.
      expiryDays: 30,
      softRules: ['sell-only'],
    };
  },
  validate(p) {
    return num(p, 'sellBelow') < num(p, 'sellAbove')
      ? []
      : [{ key: 'sellBelow', message: 'must be below the sell-above line' }];
  },
  render,
};
