/**
 * Mean Reverter (SEN-72, plan B-T14b): fades sharp moves away from the
 * average, betting on a snap back. Kuru spot or Perpl perps. Promise and
 * parameters from docs/design/trading/agents.html, "The catalog".
 */
import {
  type CandleWindow,
  formatNumber,
  klinesHint,
  KURU_SPOT_MARKETS,
  marketAssets,
  num,
  QUOTE_RULE,
  str,
} from '../params.ts';
import type { Params, PresetDefinition } from '../types.ts';

const WINDOWS = {
  // Coarser candles for the longer window keep one read within get_klines'
  // 200-candle limit (SEN-121).
  '1d': { label: '1-day', candles: '15-minute', interval: '15m', limit: 96 },
  '3d': { label: '3-day', candles: '30-minute', interval: '30m', limit: 144 },
} satisfies Record<string, CandleWindow>;

const CADENCE_SECONDS = { '5m': 300, '15m': 900, '1h': 3600 } as const;

const SLIPPAGE_PCT = 0.5;

/**
 * The catalog lists no leverage for this preset, and its risk is "Med": on
 * Perpl it trades at 1x, so a short is a bet on the snap back, not a loan.
 */
const PERP_LEVERAGE = 1;

/** The app's Standard mandate (apps/mobile/src/agents/presets.ts): 100 held, 50 an order. */
const STANDARD_DEPOSIT = 100;
const STANDARD_MAX_ORDER = 50;

function isSpot(market: string): boolean {
  return KURU_SPOT_MARKETS.includes(market);
}

/** Target distance above (below, for a short) the entry, in %: the take-back share of the stretch. */
function targetPct(p: Params): number {
  return (num(p, 'stretch') * num(p, 'takeBack')) / 100;
}

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const window = WINDOWS[str(p, 'window') as keyof typeof WINDOWS];
  const stretch = formatNumber(num(p, 'stretch'));
  const takeBack = formatNumber(num(p, 'takeBack'));
  const target = formatNumber(targetPct(p));
  const stop = formatNumber(num(p, 'stop'));
  const size = formatNumber(num(p, 'sizePct'));
  const spot = isSpot(market);
  const read = `1. Read the ${window.label} average of ${market}: the mean close of its ${window.candles} candles ${klinesHint(spot ? 'kuru' : 'perpl', window)}. If the read fails, open nothing this run and say why; still manage what you hold.`;

  // SEN-72: the target rests on the venue as a real limit order and only the
  // stop is agent-watched, as in Range Trader. On Kuru the resting sell's
  // price is also the agent's memory of its entry; Perpl reports the entry
  // itself (get_positions), and its target is reduce-only so it can never
  // open a position. Kuru spot cannot short, so there only a drop is faded.
  const steps = spot
    ? (() => {
        const { base, quote } = marketAssets(market);
        const factor = formatNumber(1 + targetPct(p) / 100);
        return [
          read,
          `2. If you hold no ${base} (dust under 1 ${quote} does not count), have no open orders, and the mid price is ${stretch}% or more below the average: record a thesis, then buy at market with at most ${size}% of your ${quote}, slippage limit ${SLIPPAGE_PCT}% above the best ask.`,
          `3. Right after a buy, place a GTC limit sell of the ${base} you bought at ${target}% above your fill price (${takeBack}% of the ${stretch}% stretch). Its price tells later runs the entry: entry = its price / ${factor}.`,
          `4. If you hold ${base}: the stop is ${stop}% below the entry. If the best bid is at or below it, cancel the resting sell and sell all your ${base} at market. If you hold ${base} but no resting sell, you cannot know the entry: sell it at market.`,
          '5. Otherwise do nothing. Never short: Kuru spot only fades drops.',
        ];
      })()
    : [
        read,
        `2. If you have no ${market} position and no open orders, and the mid price is ${stretch}% or more away from the average: record a thesis, then open against the move at market (long below the average, short above it) with ${size}% of your AUSD collateral as margin at ${PERP_LEVERAGE}x leverage, slippage limit ${SLIPPAGE_PCT}% past the best price.`,
        `3. Right after it fills, place a GTC reduce-only limit order closing it at ${target}% from your entry toward the average (${takeBack}% of the ${stretch}% stretch).`,
        `4. If you hold a position: the stop is ${stop}% against your entry (get_positions gives it). If price has crossed it, cancel the resting order and close the position with close_position. If it has no resting order, place it as in step 3.`,
        '5. Otherwise do nothing.',
      ];

  const strategy = [
    `Trade ${market} on ${spot ? 'Kuru spot' : 'Perpl perps'} only. Fade sharp moves away from the average, betting on a snap back.`,
    '',
    'Every run:',
    ...steps,
    '',
    `The target rests on ${spot ? 'Kuru' : 'Perpl'} as a limit order. The stop is checked every run, not a venue order: between runs price can pass through it, and the ${spot ? 'sale' : 'close'} fills at the price when it is seen. A move that keeps going is exactly where this strategy loses.`,
  ].join('\n');

  const systemPrompt = [
    'You are a Mean Reverter agent on Sente. Your owner chose this strategy and its numbers; follow it exactly and do not improvise.',
    '',
    `- One market only: ${market}. One position at a time: never add to it while it moves against you.`,
    '- Never move the stop further away, never cancel the target except to exit at the stop.',
    spot
      ? `- If your ${marketAssets(market).quote} or ${marketAssets(market).base} sits in your wallet rather than your Kuru account, deposit it before you trade.`
      : `- Never use more than ${PERP_LEVERAGE}x leverage.`,
    '- Keep each thesis short: the average, how far price stretched, your entry, the target and the stop.',
    QUOTE_RULE,
    '- When a read fails or the numbers are unclear, open nothing this run and say so in one sentence.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const meanReverter: PresetDefinition = {
  id: 'mean-reverter',
  // SEN-121: the text now names get_klines and quote.
  version: 2,
  name: 'Mean Reverter',
  tagline: 'Fades sharp moves away from the average, betting on a snap back.',
  description:
    'When price stretches far from its recent average, it takes the other side and sells ' +
    'once price has taken back part of the move. On Kuru spot it only buys drops; on Perpl it ' +
    'can also short spikes, at 1x. The target rests on the venue; the stop is checked, not ' +
    'placed, so a fast move can fill past it. It needs price history to enter; without it, it ' +
    'waits.',
  venues: ['kuru', 'perpl'],
  params: [
    {
      key: 'market',
      label: 'Market',
      type: 'market',
      venue: 'any',
      multiple: false,
      default: 'MON-USDC',
    },
    {
      key: 'window',
      label: 'Average over',
      type: 'enum',
      options: [
        { value: '1d', label: '1 day' },
        { value: '3d', label: '3 days' },
      ],
      default: '1d',
    },
    {
      key: 'stretch',
      label: 'Act when price is this far from the average',
      type: 'number',
      min: 2,
      max: 6,
      step: 0.5,
      unit: '%',
      default: 3,
    },
    {
      key: 'takeBack',
      label: 'Take profit after it takes back',
      type: 'number',
      min: 25,
      max: 100,
      step: 5,
      unit: '%',
      default: 50,
      help: 'Share of the stretch. Rests on the venue as a limit order.',
    },
    {
      key: 'stop',
      label: 'Stop',
      type: 'number',
      min: 1,
      max: 10,
      step: 0.5,
      unit: '%',
      default: 3,
      help: 'Agent-watched: checked every run, not a venue order.',
    },
    {
      key: 'sizePct',
      label: 'Each trade uses up to',
      type: 'number',
      min: 10,
      max: 100,
      step: 5,
      unit: '%',
      default: 40,
      help: 'Share of the agent’s budget.',
    },
    {
      key: 'cadence',
      label: 'Runs',
      type: 'enum',
      options: [
        { value: '5m', label: '5 min' },
        { value: '15m', label: '15 min' },
        { value: '1h', label: 'Hourly' },
      ],
      default: '15m',
    },
  ],
  tools: [
    'get_klines',
    'quote',
    'get_depth',
    'get_balances',
    'get_positions',
    'get_open_orders',
    'record_thesis',
    'deposit',
    'place_market',
    'place_limit',
    'cancel_order',
    'close_position',
  ],
  suggestedCadenceSeconds: (p) =>
    CADENCE_SECONDS[str(p, 'cadence') as keyof typeof CADENCE_SECONDS],
  suggestedMandate(p) {
    const market = str(p, 'market');
    const spot = isSpot(market);
    // The largest order is the target of the biggest entry, so the cap is
    // raised above Standard's when the size needs it.
    const biggest = (STANDARD_DEPOSIT * num(p, 'sizePct') * (1 + targetPct(p) / 100)) / 100;
    return {
      tier: 'standard',
      venues: [spot ? 'kuru' : 'perpl'],
      kuruMarkets: spot ? [market] : [],
      perplMarkets: spot ? [] : [market],
      maxOrderNotional: String(Math.max(STANDARD_MAX_ORDER, Math.ceil(biggest))),
      maxLeverage: spot ? null : PERP_LEVERAGE,
      depositCaps: spot
        ? [{ asset: marketAssets(market).quote, amount: String(STANDARD_DEPOSIT) }]
        : [],
      perplCollateral: spot ? null : String(STANDARD_DEPOSIT),
      expiryDays: 7,
      softRules: ['one position at a time'],
    };
  },
  render,
};
