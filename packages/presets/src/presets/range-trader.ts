/**
 * Range Trader (SEN-68): buys near the bottom of a recent range, sells at a
 * target or a stop. Kuru spot only. Promise and parameters from
 * docs/design/trading/agents.html, "The catalog" and "Configure · strategy".
 */
import {
  type CandleWindow,
  formatNumber,
  klinesHint,
  marketAssets,
  num,
  QUOTE_RULE,
  str,
} from '../params.ts';
import type { Params, PresetDefinition } from '../types.ts';

const LOOKBACKS = {
  '1d': { label: '1-day', candles: '15-minute', interval: '15m', limit: 96 },
  // Coarser candles for the longer windows keep one read within get_klines'
  // 200-candle limit (SEN-121).
  '3d': { label: '3-day', candles: '30-minute', interval: '30m', limit: 144 },
  '1w': { label: '1-week', candles: '1-hour', interval: '1h', limit: 168 },
} satisfies Record<string, CandleWindow>;

const CADENCE_SECONDS = { '5m': 300, '15m': 900, '1h': 3600 } as const;

/** Narrower than this and the band and the target overlap: no trade is worth it. */
const MIN_RANGE_PCT = 2;

/** The app's Standard mandate (apps/mobile/src/agents/presets.ts): 100 USDC held, 50 an order. */
const STANDARD_DEPOSIT = 100;
const STANDARD_MAX_ORDER = 50;

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const { base, quote } = marketAssets(market);
  const lookback = LOOKBACKS[str(p, 'lookback') as keyof typeof LOOKBACKS];
  const band = formatNumber(num(p, 'entryBand'));
  const target = num(p, 'target');
  const stop = formatNumber(num(p, 'stop'));
  const size = formatNumber(num(p, 'sizePct'));
  const targetFactor = formatNumber(1 + target / 100);

  // SEN-68: the target rests on Kuru as a real limit sell, and only the stop
  // is agent-watched. An agent does not see its earlier theses on a later run,
  // so without a resting order it could not know its entry, and a stop
  // "3% below the entry" would be unenforceable. The order's price is the
  // memory: entry = price ÷ (1 + target).
  //
  // SEN-121: the candles come from get_klines, named with its arguments, and
  // a failed read still means "do not buy" rather than a range the agent
  // guessed. Market orders are priced by QUOTE_RULE in the system prompt.
  const strategy = [
    `Trade ${market} on Kuru spot only. Buy near the bottom of the recent range; sell at a target or a stop.`,
    '',
    'Every run:',
    `1. Read the ${lookback.label} high and low of ${market} from ${lookback.candles} candles ${klinesHint('kuru', lookback)}. If the read fails, or the range is under ${MIN_RANGE_PCT}% wide, do not buy this run and say why.`,
    `2. If you hold no ${base} (dust under 1 ${quote} does not count) and have no open orders, and the mid price is within ${band}% of the range low: record a thesis, then buy at market with at most ${size}% of your ${quote}, slippage limit 0.5% above the best ask.`,
    `3. Right after a buy, place a GTC limit sell of the ${base} you bought at ${formatNumber(target)}% above your fill price. That order is the target, and its price tells later runs the entry: entry = its price ÷ ${targetFactor}.`,
    `4. If you hold ${base}: the stop is ${stop}% below the entry. If the best bid is at or below it, cancel the resting sell and sell all your ${base} at market. If you hold ${base} but no resting sell, you cannot know the entry: sell it at market.`,
    '5. Otherwise do nothing.',
    '',
    'The target rests on Kuru as a limit order. The stop is checked every run, not a venue order: between runs price can pass through it, and the sale fills at the price when it is seen.',
  ].join('\n');

  const systemPrompt = [
    'You are a Range Trader agent on Sente. Your owner chose this strategy and its numbers; follow it exactly and do not improvise.',
    '',
    `- One market only: ${market}. One position at a time: never buy while you hold ${base} or have an order open.`,
    '- Never move the stop further away, never average down, never cancel the target except to sell at the stop.',
    `- Keep each thesis short: the range low and high, your entry, the target and the stop, as ${quote} prices.`,
    `- If your ${quote} or ${base} sits in your wallet rather than your Kuru account, deposit it before you trade.`,
    QUOTE_RULE,
    '- When a read fails or the numbers are unclear, do nothing this run and say so in one sentence.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const rangeTrader: PresetDefinition = {
  id: 'range-trader',
  // SEN-121: the text now names get_klines and quote.
  version: 2,
  name: 'Range Trader',
  tagline: 'Buys near the bottom of a recent range, sells near the top.',
  description:
    'It finds the recent high and low of one market and buys near the low. It sells when price ' +
    'climbs to your target or falls through your stop. When the range is too narrow to trade, ' +
    'it waits.',
  venues: ['kuru'],
  params: [
    {
      key: 'market',
      label: 'Market',
      type: 'market',
      venue: 'kuru',
      multiple: false,
      default: 'MON-USDC',
    },
    {
      key: 'lookback',
      label: 'Range to watch',
      type: 'enum',
      options: [
        { value: '1d', label: '1 day' },
        { value: '3d', label: '3 days' },
        { value: '1w', label: '1 week' },
      ],
      default: '3d',
    },
    {
      key: 'entryBand',
      label: 'Buy within … of the low',
      type: 'number',
      min: 0.5,
      max: 3,
      step: 0.1,
      unit: '%',
      default: 1.5,
    },
    {
      key: 'target',
      label: 'Target',
      type: 'number',
      min: 1,
      max: 10,
      step: 0.5,
      unit: '%',
      default: 3,
      help: 'Rests on Kuru as a limit sell above your entry.',
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
      label: 'Each buy uses up to',
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
    'get_open_orders',
    'record_thesis',
    'deposit',
    'place_market',
    'place_limit',
    'cancel_order',
  ],
  suggestedCadenceSeconds: (p) =>
    CADENCE_SECONDS[str(p, 'cadence') as keyof typeof CADENCE_SECONDS],
  suggestedMandate(p) {
    const market = str(p, 'market');
    const { quote } = marketAssets(market);
    // The largest order is the target sell of the biggest buy the strategy
    // plans, so the cap is raised above Standard's when the size needs it.
    const biggest = (STANDARD_DEPOSIT * num(p, 'sizePct') * (1 + num(p, 'target') / 100)) / 100;
    return {
      tier: 'standard',
      venues: ['kuru'],
      kuruMarkets: [market],
      perplMarkets: [],
      maxOrderNotional: String(Math.max(STANDARD_MAX_ORDER, Math.ceil(biggest))),
      maxLeverage: null,
      depositCaps: [{ asset: quote, amount: String(STANDARD_DEPOSIT) }],
      perplCollateral: null,
      expiryDays: 7,
      softRules: ['one position at a time'],
    };
  },
  render,
};
