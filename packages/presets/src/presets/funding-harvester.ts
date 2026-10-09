/**
 * Funding Harvester (SEN-72, plan B-T14b): shorts a Perpl perp while funding
 * pays shorts, optionally holding the same coin on Kuru spot. Promise and
 * parameters from docs/design/trading/agents.html, "The catalog".
 */
import { formatNumber, marketAssets, num, str } from '../params.ts';
import type { ParamError, Params, PresetDefinition } from '../types.ts';

/**
 * The Kuru spot market that holds the same coin as each perp. Only these
 * perps can be hedged; the tokenised names (WBTC, WETH) are what Kuru lists.
 */
const HEDGE_MARKETS: Readonly<Record<string, string>> = {
  BTC: 'WBTC-USDC',
  ETH: 'WETH-USDC',
  MON: 'MON-USDC',
};

/**
 * Half the collateral as margin: the rest is the buffer that keeps an
 * isolated short away from liquidation while it waits for funding.
 */
const MARGIN_SHARE_PCT = 50;

/** Close the short when the mark is this close to its liquidation price, in %. */
const LIQUIDATION_GUARD_PCT = 10;

/** Legs further apart than this, in %, get the Kuru leg traded back into line. */
const HEDGE_DRIFT_PCT = 5;

const SLIPPAGE_PCT = 0.5;

/** The app's Cautious mandate is sized for spot; perps get a small collateral of their own. */
const CAUTIOUS_COLLATERAL = 50;

function perpBase(market: string): string {
  return market.split('-')[0] ?? market;
}

function hedgeMarket(p: Params): string | undefined {
  return p['hedge'] === true ? HEDGE_MARKETS[perpBase(str(p, 'market'))] : undefined;
}

function render(p: Params): { strategy: string; systemPrompt: string } {
  const market = str(p, 'market');
  const base = perpBase(market);
  const hedge = hedgeMarket(p);
  // Kuru lists the tokenised coin (WBTC, WETH), so the spot leg names it.
  const coin = hedge ? marketAssets(hedge).base : base;
  const min = formatNumber(num(p, 'minFunding'));
  const leverage = formatNumber(num(p, 'leverage'));
  const exit =
    p['exitOnFlip'] === true
      ? 'below zero (shorts now pay)'
      : `at or below -${min}% / 8h (shorts pay as much as you asked to earn)`;
  const unwind = hedge
    ? ` and sell the ${coin} you hold on ${hedge} at market, slippage limit ${SLIPPAGE_PCT}% below the best bid`
    : '';

  // SEN-145: get_funding reports the rate already per 8 hours, so the model
  // compares it with the thresholds instead of converting Perpl's 43-minute
  // interval itself. A failed or empty read still means "open nothing", as a
  // failed get_klines does in the candle presets.
  const steps = [
    `1. Read the funding rate of ${market} with get_funding: ratePctPer8h is the rate as a % per 8 hours, positive when longs pay shorts (shorts are paid). If the read fails or has no funding, open nothing this run and say why; keep any position you hold.`,
    `2. If you have no ${market} short and funding is at or above +${min}% / 8h (shorts are paid): record a thesis, then short at market with ${MARGIN_SHARE_PCT}% of your AUSD collateral as margin at ${leverage}x leverage, size = margin x leverage / price, slippage limit ${SLIPPAGE_PCT}% below the best bid.${hedge ? ` Then buy the same size of ${coin} on ${hedge} at market with USDC, slippage limit ${SLIPPAGE_PCT}% above the best ask.` : ''}`,
    `3. If you hold the short and funding is ${exit}: close it with close_position${unwind}.`,
    `4. If you hold the short and the mark price is within ${LIQUIDATION_GUARD_PCT}% of its liquidation price: close it with close_position${unwind}.`,
    ...(hedge
      ? [
          `5. If the ${coin} you hold on Kuru and the short differ in size by more than ${HEDGE_DRIFT_PCT}%, buy or sell ${coin} on ${hedge} until they match.`,
        ]
      : []),
    `${hedge ? 6 : 5}. Otherwise do nothing.`,
  ];

  const strategy = [
    `Earn funding on ${market}, Perpl perps${hedge ? `, hedged with ${coin} held on ${hedge}, Kuru spot` : ', unhedged'}. You only ever short the perp; never go long it.`,
    '',
    'Every run:',
    ...steps,
    '',
    `The liquidation guard is checked every run, not a venue order: a fast move between runs can liquidate the short first, and it is isolated margin, so that loses its margin. Funding can flip at any time. ${
      hedge
        ? 'The hedge is your rule, not the mandate’s: nothing ties the two legs together, so check both every run.'
        : `Unhedged, a rising price loses on the short at ${leverage}x.`
    }`,
  ].join('\n');

  const systemPrompt = [
    'You are a Funding Harvester agent on Sente. Your owner chose this strategy and its numbers; follow it exactly and do not improvise.',
    '',
    `- Perp: ${market} only, short only, one position, never more than ${leverage}x leverage.`,
    hedge
      ? `- Spot: ${hedge} only, and only to hold the same size of ${coin} as the short. Never hold ${coin} without the short.`
      : '- Never trade on Kuru.',
    '- You earn only while funding pays shorts. Never open a short because you expect the price to fall.',
    '- Keep each thesis short: the funding rate you read, the size, the leverage and the liquidation price.',
    '- When a read fails, open nothing this run and say so in one sentence; still close a short that step 3 or 4 says to close.',
  ].join('\n');

  return { strategy, systemPrompt };
}

export const fundingHarvester: PresetDefinition = {
  id: 'funding-harvester',
  version: 2,
  name: 'Funding Harvester',
  tagline: 'Shorts a perp while funding pays shorts, and can hold the same coin on Kuru.',
  description:
    'When funding on a Perpl market pays shorts enough, it opens a small short and collects ' +
    'the payments. With the hedge on, it buys the same amount of the coin on Kuru so price ' +
    'moves mostly cancel out; the pairing is its rule, not something the mandate can enforce. ' +
    'Funding can turn at any time, and it needs a funding-rate read to open anything.',
  venues: ['perpl', 'kuru'],
  params: [
    {
      key: 'market',
      label: 'Market',
      type: 'market',
      venue: 'perpl',
      multiple: false,
      default: 'BTC-PERP',
      help: 'Hedging needs BTC-PERP, ETH-PERP or MON-PERP: the coins Kuru lists.',
    },
    {
      key: 'minFunding',
      label: 'Open when funding pays shorts at least',
      type: 'number',
      min: 0.005,
      max: 0.1,
      step: 0.005,
      unit: '%',
      default: 0.01,
      help: 'Per 8 hours.',
    },
    {
      key: 'leverage',
      label: 'Leverage',
      type: 'number',
      min: 1,
      max: 2,
      step: 0.5,
      unit: 'x',
      default: 2,
      help: 'Isolated margin, set per order.',
    },
    {
      key: 'hedge',
      label: 'Hold the same coin on Kuru',
      type: 'boolean',
      default: true,
      help: 'The agent’s rule, not the mandate’s: nothing forces the two legs to match.',
    },
    {
      key: 'exitOnFlip',
      label: 'Close when funding flips',
      type: 'boolean',
      default: true,
      help: 'Off: it holds until shorts pay as much as your entry threshold.',
    },
  ],
  tools: [
    'get_funding',
    'get_depth',
    'get_balances',
    'get_positions',
    'record_thesis',
    'deposit',
    'place_market',
    'close_position',
  ],
  // Funding accrues over hours; checking more often only spends credits.
  suggestedCadenceSeconds: () => 3600,
  suggestedMandate(p) {
    const market = str(p, 'market');
    const hedge = hedgeMarket(p);
    // The short and the hedge buy are the same notional: margin x leverage.
    const notional = (CAUTIOUS_COLLATERAL * MARGIN_SHARE_PCT * num(p, 'leverage')) / 100;
    const cap = String(Math.ceil(notional * (1 + SLIPPAGE_PCT / 100)));
    return {
      tier: 'cautious',
      venues: hedge ? ['perpl', 'kuru'] : ['perpl'],
      kuruMarkets: hedge ? [hedge] : [],
      perplMarkets: [market],
      maxOrderNotional: cap,
      maxLeverage: num(p, 'leverage'),
      depositCaps: hedge ? [{ asset: 'USDC', amount: cap }] : [],
      perplCollateral: String(CAUTIOUS_COLLATERAL),
      // Funding is harvested over weeks; a one-day expiry would end it at once.
      expiryDays: 30,
      softRules: hedge ? ['short only', 'Kuru leg matches the short'] : ['short only'],
    };
  },
  validate(p) {
    const errors: ParamError[] = [];
    if (p['hedge'] === true && !hedgeMarket(p)) {
      errors.push({ key: 'market', message: 'has no Kuru spot market to hedge on' });
    }
    return errors;
  },
  render,
};
