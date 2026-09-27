/**
 * DCA Stacker (SEN-72, plan B-T14b): buys the same amount on a schedule,
 * whatever the price. Kuru spot only. Promise and parameters from
 * docs/design/trading/agents.html, "The catalog".
 */
import { formatNumber, marketAssets, num, str } from '../params.ts';
import type { Params, PresetDefinition } from '../types.ts';

const EVERY = {
  day: { seconds: 86_400, days: 1 },
  week: { seconds: 604_800, days: 7 },
} as const;

/** The catalog's "buy double after a 5% drop", measured from the 1-day high. */
const DIP_PCT = 5;

const SLIPPAGE_PCT = 1;

/** A mandate is a promise with an end; a year is the longest one it suggests. */
const MAX_EXPIRY_DAYS = 365;

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const { base, quote } = marketAssets(market);
  const amount = num(p, 'amount');
  const every = str(p, 'every');
  const budget = formatNumber(num(p, 'budget'));
  const dip = p['doubleOnDip'] === true;

  // SEN-72: an agent does not see its earlier runs, so "once a day" is the
  // run schedule, not something the agent tracks: each run is one buy. What
  // it can see is its balance, so "the budget is spent" is read from that.
  const strategy = [
    `Buy ${base} on ${market}, Kuru spot, a fixed amount each run, whatever the price. You only ever buy; never sell.`,
    '',
    `Every run (you are run once a ${every}):`,
    `1. Read the ${quote} in your Kuru account and your wallet. If you hold less than ${formatNumber(amount)} ${quote} in all, your ${budget} ${quote} budget is spent: say so and end the run.`,
    dip
      ? `2. Read the 1-day high of ${market} from 15-minute candles. If the mid price is at least ${DIP_PCT}% below it, this buy is double: ${formatNumber(amount * 2)} ${quote}. If no tool gives you candles, buy the normal amount.`
      : '2. The buy is the same size every run.',
    `3. Record a thesis, then buy ${formatNumber(amount)} ${quote}${dip ? ' (or the double)' : ''} of ${base} at market, all you hold if less, slippage limit ${SLIPPAGE_PCT}% above the best ask. Buy once per run, never more.`,
    '',
    `There is no stop and no target: you never sell, and each buy fills at the market price of that run. Buying once per run means that if you are run more often than once a ${every}, you buy more often; the budget is what stops you.`,
  ].join('\n');

  const systemPrompt = [
    'You are a DCA Stacker agent on Sente. Your owner chose this strategy and its numbers; follow it exactly and do not improvise.',
    '',
    `- One market only: ${market}. Buy only. Never sell ${base}, never time the market, never skip a buy because of the price.`,
    `- If your ${quote} sits in your wallet rather than your Kuru account, deposit it before you buy.`,
    '- Keep each thesis to one sentence: the scheduled buy, its size, and whether it was doubled.',
    '- When a read fails, buy nothing this run and say so in one sentence.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const dcaStacker: PresetDefinition = {
  id: 'dca-stacker',
  version: 1,
  name: 'DCA Stacker',
  tagline: 'Buys the same amount on a schedule, whatever the price.',
  description:
    'It buys a fixed amount of one coin every day or week and never sells, so your average ' +
    'price is the average of the market over time, for better or worse. It stops when the ' +
    'budget is spent. Each run is one buy, so it needs its own daily or weekly schedule; run ' +
    'more often, it buys more often.',
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
      label: 'Amount per buy',
      type: 'number',
      min: 1,
      max: 1_000,
      step: 1,
      unit: 'USDC',
      default: 10,
    },
    {
      key: 'every',
      label: 'Buy every',
      type: 'enum',
      options: [
        { value: 'day', label: 'Day' },
        { value: 'week', label: 'Week' },
      ],
      default: 'day',
    },
    {
      key: 'doubleOnDip',
      label: 'Buy double after a 5% drop',
      type: 'boolean',
      default: false,
      help: 'Measured from the 1-day high; needs price history, and buys the normal amount without it.',
    },
    {
      key: 'budget',
      label: 'Stop when this much is spent',
      type: 'number',
      min: 10,
      max: 10_000,
      step: 10,
      unit: 'USDC',
      default: 100,
    },
  ],
  tools: ['get_depth', 'get_balances', 'record_thesis', 'deposit', 'place_market'],
  suggestedCadenceSeconds: (p) => EVERY[str(p, 'every') as keyof typeof EVERY].seconds,
  suggestedMandate(p) {
    const market = str(p, 'market');
    const { quote } = marketAssets(market);
    const amount = num(p, 'amount');
    const biggest = amount * (p['doubleOnDip'] === true ? 2 : 1) * (1 + SLIPPAGE_PCT / 100);
    const buys = Math.ceil(num(p, 'budget') / amount);
    const days = buys * EVERY[str(p, 'every') as keyof typeof EVERY].days + 1;
    return {
      tier: 'cautious',
      venues: ['kuru'],
      kuruMarkets: [market],
      perplMarkets: [],
      maxOrderNotional: String(Math.ceil(biggest)),
      maxLeverage: null,
      depositCaps: [{ asset: quote, amount: formatNumber(num(p, 'budget')) }],
      perplCollateral: null,
      // Long enough for the whole budget at the chosen pace.
      expiryDays: Math.min(MAX_EXPIRY_DAYS, days),
      softRules: ['buy-only', 'one buy per run'],
    };
  },
  validate(p) {
    return num(p, 'budget') >= num(p, 'amount')
      ? []
      : [{ key: 'budget', message: 'must be at least one buy' }];
  },
  render,
};
