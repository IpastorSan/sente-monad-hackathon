/**
 * Trend Rider (SEN-72, plan B-T14b): joins a breakout on Perpl perps and
 * trails a stop behind it. Promise and parameters from
 * docs/design/trading/agents.html, "The catalog".
 */
import { type CandleWindow, formatNumber, klinesHint, num, QUOTE_RULE, str } from '../params.ts';
import type { Params, PresetDefinition } from '../types.ts';

const LOOKBACKS = {
  // Candle sizes keep one read within get_klines' 200-candle limit. Each
  // limit is one over the window because the newest candle is still open and
  // the text leaves it out (SEN-121).
  '12h': { label: '12-hour', candles: '15-minute', interval: '15m', limit: 49 },
  '1d': { label: '1-day', candles: '15-minute', interval: '15m', limit: 97 },
  '3d': { label: '3-day', candles: '1-hour', interval: '1h', limit: 73 },
} satisfies Record<string, CandleWindow>;

const CADENCE_SECONDS = { '5m': 300, '15m': 900 } as const;

/** How far past the best price an entry may fill, in %. */
const ENTRY_SLIPPAGE_PCT = 0.5;

/** The app's Wide mandate (apps/mobile/src/agents/presets.ts): 250 AUSD collateral, 250 an order. */
const WIDE_COLLATERAL = 250;
const WIDE_MAX_ORDER = 250;

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const lookback = LOOKBACKS[str(p, 'lookback') as keyof typeof LOOKBACKS];
  const both = str(p, 'direction') === 'both';
  const leverage = formatNumber(num(p, 'leverage'));
  const trail = formatNumber(num(p, 'trailingStop'));
  const size = formatNumber(num(p, 'sizePct'));

  // SEN-72: a trailing stop needs the best price since entry, and an agent
  // does not see its earlier runs. The venue remembers the entry
  // (get_positions) and the candles remember the high, so the trail hangs off
  // the higher of the two: a chandelier exit, with no memory of its own. If
  // get_klines fails it falls back to the entry, so an open position is never
  // left without a stop just because price history is missing.
  const strategy = [
    `Trade ${market} on Perpl perps only, ${both ? 'long or short' : 'long only'}. Join a breakout and trail a stop behind it.`,
    '',
    'Every run:',
    `1. Read your ${market} position. If you have one, go to step 4.`,
    `2. Read the ${lookback.label} high and low of ${market} from ${lookback.candles} candles ${klinesHint('perpl', lookback)}, leaving out the last one, which is still open. If the read fails, do not open a position this run and say why.`,
    `3. If the mid price is above that high${both ? ', or below that low' : ''}: record a thesis, then open a ${both ? 'long above the high, or a short below the low,' : 'long'} at market with ${size}% of your AUSD collateral as margin at ${leverage}x leverage (the market's maximum from list_markets, if lower), size = margin x leverage / price, slippage limit ${ENTRY_SLIPPAGE_PCT}% past the best price. Otherwise do nothing.`,
    `4. Long: the stop is ${trail}% below the higher of your entry price and the ${lookback.label} high. ${both ? `Short: the stop is ${trail}% above the lower of your entry price and the ${lookback.label} low. ` : ''}If the candle read failed, use your entry price alone. If the price has crossed the stop, close the whole position with close_position. Otherwise hold.`,
    '',
    'The trailing stop is checked every run, not a venue order: between runs price can pass through it, and the close fills at the price when it is seen. The position is isolated margin: it can lose at most its margin, and a fast move can liquidate it before a run sees the stop.',
  ].join('\n');

  const systemPrompt = [
    'You are a Trend Rider agent on Sente. Your owner chose this strategy and its numbers; follow it exactly and do not improvise.',
    '',
    `- One market only: ${market}. One position at a time: never add to it, never open a second one.${both ? '' : ' Never short.'}`,
    `- Never use more than ${leverage}x leverage, and never more than the market allows.`,
    '- Never move the stop further away. A stop only ever tightens as the high (or low) moves in your favour.',
    '- Keep each thesis short: the breakout level, your entry, the leverage and the stop, in AUSD prices.',
    QUOTE_RULE,
    '- When a read fails or the numbers are unclear, open nothing this run and say so in one sentence; still close a position whose stop is crossed.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const trendRider: PresetDefinition = {
  id: 'trend-rider',
  // SEN-121: the text now names get_klines and quote.
  version: 2,
  name: 'Trend Rider',
  tagline: 'Joins a breakout on perps and trails a stop behind it.',
  description:
    'It watches one Perpl market for price breaking out of its recent high (or low, if you let ' +
    'it short) and joins the move with the leverage you choose. A trailing stop follows the ' +
    'move and closes the position when price turns. The stop is checked, not placed on the ' +
    'venue, and with leverage a fast move can liquidate the position first. It needs price ' +
    'history to enter; without it, it waits.',
  venues: ['perpl'],
  params: [
    {
      key: 'market',
      label: 'Market',
      type: 'market',
      venue: 'perpl',
      multiple: false,
      default: 'BTC-PERP',
    },
    {
      key: 'lookback',
      label: 'Breakout of the last',
      type: 'enum',
      options: [
        { value: '12h', label: '12 hours' },
        { value: '1d', label: '1 day' },
        { value: '3d', label: '3 days' },
      ],
      default: '1d',
    },
    {
      key: 'direction',
      label: 'Direction',
      type: 'enum',
      options: [
        { value: 'long', label: 'Long only' },
        { value: 'both', label: 'Long and short' },
      ],
      default: 'long',
    },
    {
      key: 'leverage',
      label: 'Leverage',
      type: 'number',
      min: 1,
      max: 5,
      step: 1,
      unit: 'x',
      default: 2,
      help: 'Isolated margin, set per order; never above the market’s maximum.',
    },
    {
      key: 'trailingStop',
      label: 'Trailing stop',
      type: 'number',
      min: 1,
      max: 10,
      step: 0.5,
      unit: '%',
      default: 4,
      help: 'Agent-watched: checked every run, not a venue order.',
    },
    {
      key: 'sizePct',
      label: 'Each position uses up to',
      type: 'number',
      min: 10,
      max: 100,
      step: 5,
      unit: '%',
      default: 25,
      help: 'Share of the agent’s collateral posted as margin.',
    },
    {
      key: 'cadence',
      label: 'Runs',
      type: 'enum',
      options: [
        { value: '5m', label: '5 min' },
        { value: '15m', label: '15 min' },
      ],
      default: '5m',
    },
  ],
  tools: [
    'list_markets',
    'get_klines',
    'quote',
    'get_depth',
    'get_balances',
    'get_positions',
    'record_thesis',
    'place_market',
    'close_position',
  ],
  suggestedCadenceSeconds: (p) =>
    CADENCE_SECONDS[str(p, 'cadence') as keyof typeof CADENCE_SECONDS],
  suggestedMandate(p) {
    const market = str(p, 'market');
    // The one order is the entry: margin x leverage, valued by the cap at its
    // slippage ceiling, so a full-size entry fits its own cap (SEN-137).
    const biggest =
      (WIDE_COLLATERAL * num(p, 'sizePct') * num(p, 'leverage') * (1 + ENTRY_SLIPPAGE_PCT / 100)) /
      100;
    return {
      tier: 'wide',
      venues: ['perpl'],
      kuruMarkets: [],
      perplMarkets: [market],
      maxOrderNotional: String(Math.max(WIDE_MAX_ORDER, Math.ceil(biggest))),
      maxLeverage: num(p, 'leverage'),
      depositCaps: [],
      perplCollateral: String(WIDE_COLLATERAL),
      expiryDays: 30,
      softRules:
        str(p, 'direction') === 'long'
          ? ['one position at a time', 'long only']
          : ['one position at a time'],
    };
  },
  render,
};
