/**
 * Order ticket rules (SEN-119). Plain node, no device.
 *
 * The load-bearing property is the amount → size direction for a market buy:
 * whatever is typed, the order's deposit cap (the bound the verifier enforces)
 * never exceeds it, so "Max" can always be placed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { depositCapAtoms } from './kuruMarket.ts';
import {
  evaluateTicket,
  feePpsOf,
  fundsLines,
  filledPct,
  heldMarkets,
  presetAmount,
  pressKey,
  resultView,
  reviewRows,
  shortSize,
  sizeForSpend,
  slippageFraction,
  spendable,
  stepState,
  toUnits,
  type TicketInput,
  type TicketMarket,
} from './ticket.ts';
import type { KuruPlaceResult } from './types.ts';

/** MON-USDC as configured, with a 0.04% taker and 0.02% maker fee and a 1 USDC minimum. */
const MON: TicketMarket = {
  symbol: 'MON-USDC',
  base: { symbol: 'MON', decimals: 18 },
  quote: { symbol: 'USDC', decimals: 6 },
  pricePrecision: 1_000_000n,
  sizePrecision: 100_000_000n,
  tickSize: 1n,
  takerFeePps: 4_000n,
  makerFeePps: 2_000n,
  minNotional: '1',
};

const USDC = (n: string) => toUnits(n, 1_000_000n)!;
const MON_ATOMS = (n: string) => toUnits(n, 10n ** 18n)!;

const QUOTE = {
  averagePrice: '0.9812',
  estimatedFee: '0.04',
  minNotionalOk: true,
  partial: false,
  stale: false,
};

function marketBuy(overrides: Partial<TicketInput> = {}): TicketInput {
  return {
    market: MON,
    side: 'buy',
    orderType: 'market',
    amount: '200',
    limitPrice: '',
    slippageBps: 50,
    // 0.9812 best ask + 0.5% → 0.986106 (floored to the tick)
    worstUnits: 986_106n,
    available: USDC('500'),
    quote: QUOTE,
    ...overrides,
  };
}

test('toUnits truncates past the precision and refuses what is not a decimal', () => {
  assert.equal(toUnits('1.2345678', 1_000_000n), 1_234_567n);
  assert.equal(toUnits('.5', 100n), 50n);
  assert.equal(toUnits('1,5', 100n), null);
  assert.equal(toUnits('-1', 100n), null);
});

test('feePpsOf reads the /markets fraction as parts per ten million', () => {
  assert.equal(feePpsOf('0.0004'), 4_000n);
  assert.equal(feePpsOf('0'), 0n);
});

test('sizeForSpend never produces an order whose deposit cap exceeds the spend', () => {
  const decimals = { quote: 6, base: 18 };
  for (const spend of ['1', '200', '500', '0.37', '12345.67']) {
    for (const price of [986_106n, 1n, 999_999n, 123_456n]) {
      const atoms = USDC(spend);
      const size = sizeForSpend(atoms, price, MON.takerFeePps, MON);
      if (size === 0n) continue;
      const cap = depositCapAtoms(
        { side: 'buy', price, quantity: size, tif: 'ioc' },
        MON,
        decimals,
      );
      assert.ok(cap <= atoms, `${spend} at ${price}: cap ${cap} > ${atoms}`);
      // …and one more size unit would not fit, so it is the largest.
      const over = depositCapAtoms(
        { side: 'buy', price, quantity: size + 1n, tif: 'ioc' },
        MON,
        decimals,
      );
      assert.ok(over > atoms || over === atoms);
    }
  }
});

test('spendable counts the Kuru account and keeps the chain reserve', () => {
  assert.equal(spendable(USDC('300'), USDC('200')), USDC('500'));
  assert.equal(spendable(MON_ATOMS('12'), MON_ATOMS('1'), MON_ATOMS('10')), MON_ATOMS('3'));
  assert.equal(spendable(MON_ATOMS('4'), 0n, MON_ATOMS('10')), 0n);
});

test('pressKey refuses a second dot, extra decimals and a leading zero', () => {
  assert.equal(pressKey('', '.', 2), '0.');
  assert.equal(pressKey('1.', '.', 2), '1.');
  assert.equal(pressKey('1.25', '9', 2), '1.25');
  assert.equal(pressKey('0', '7', 2), '7');
  assert.equal(pressKey('12', 'back', 2), '1');
  assert.equal(pressKey('5', '.', 0), '5');
});

test('presets: a market buy splits USDC to the cent; Max is exactly what you have', () => {
  const base = { side: 'buy', orderType: 'market', limitPriceUnits: null, market: MON } as const;
  assert.equal(presetAmount({ ...base, pct: 100, available: USDC('500.456789') }), '500.45');
  assert.equal(presetAmount({ ...base, pct: 25, available: USDC('500') }), '125');
  assert.equal(presetAmount({ ...base, pct: 10, available: null }), null);
});

test('presets: a sell splits the base, a limit buy converts at the limit with the maker fee', () => {
  const sell = presetAmount({
    pct: 50,
    side: 'sell',
    orderType: 'market',
    available: MON_ATOMS('412'),
    limitPriceUnits: null,
    market: MON,
  });
  assert.equal(sell, '206');
  const limit = presetAmount({
    pct: 100,
    side: 'buy',
    orderType: 'limit',
    available: USDC('142.5'),
    limitPriceUnits: 950_000n,
    market: MON,
  });
  // 142.5 / (0.95 × 1.0002) = 149.97…, floored to the size step.
  assert.equal(limit, '149.97000599');
  assert.equal(
    presetAmount({
      pct: 10,
      side: 'buy',
      orderType: 'limit',
      available: USDC('1'),
      limitPriceUnits: null,
      market: MON,
    }),
    null,
  );
});

test('the CTA names why it is disabled, in the order you fix things', () => {
  assert.deepEqual(evaluateTicket(marketBuy({ amount: '' })).cta, {
    label: 'Enter an amount',
    enabled: false,
  });
  assert.equal(evaluateTicket(marketBuy({ amount: '0.' })).cta.label, 'Enter an amount');
  assert.equal(evaluateTicket(marketBuy({ worstUnits: undefined })).cta.label, 'Reading the book…');
  assert.equal(
    evaluateTicket(marketBuy({ worstUnits: null })).cta.label,
    'No one is selling right now',
  );

  const short = evaluateTicket(marketBuy({ amount: '620' }));
  assert.deepEqual(short.cta, { label: 'Insufficient USDC', enabled: false });
  assert.deepEqual(short.problem, {
    kind: 'insufficient',
    short: '120.00 USDC',
    have: '500.00 USDC',
  });

  assert.equal(
    evaluateTicket(marketBuy({ amount: '0.5' })).cta.label,
    "Below Kuru's minimum (1.00 USDC)",
  );
  assert.equal(
    evaluateTicket(marketBuy({ quote: { ...QUOTE, minNotionalOk: false } })).cta.label,
    "Below Kuru's minimum (1.00 USDC)",
  );
  assert.equal(evaluateTicket(marketBuy({ quote: null })).cta.label, 'Getting a quote…');
  assert.equal(
    evaluateTicket(marketBuy({ quote: { ...QUOTE, stale: true } })).cta.label,
    'Quote is stale, refreshing',
  );
});

test('a market buy is sized against the worst price, and says so', () => {
  const ticket = evaluateTicket(marketBuy());
  // 200 / (0.986106 × 1.0004) = 202.73… MON
  assert.equal(ticket.sizeUnits, 20_273_685_789n);
  assert.equal(ticket.priceUnits, 986_106n);
  assert.equal(ticket.needAtoms, USDC('200'));
  assert.deepEqual(ticket.cta, { label: 'Buy 202.7 MON', enabled: true });
  assert.equal(ticket.sub, '≈ 202.7 MON · at 0.9812');
  assert.deepEqual(ticket.disclosure, [
    'Market · est. fill 0.9812 · fee 0.04 USDC',
    'Max slippage 0.5%',
  ]);
  assert.equal(
    evaluateTicket(marketBuy({ quote: { ...QUOTE, partial: true } })).disclosure[2],
    'The book is thin: only part may fill; the rest is cancelled',
  );
  assert.deepEqual(evaluateTicket(marketBuy({ quote: null })).disclosure, [
    'Market · max slippage 0.5%',
  ]);
});

test('a market sell is typed in the base and needs that much base', () => {
  const ticket = evaluateTicket(
    marketBuy({ side: 'sell', amount: '150', worstUnits: 976_000n, available: MON_ATOMS('100') }),
  );
  assert.deepEqual(ticket.cta, { label: 'Insufficient MON', enabled: false });
  assert.deepEqual(ticket.problem, { kind: 'insufficient', short: '50 MON', have: '100 MON' });
  const ok = evaluateTicket(
    marketBuy({ side: 'sell', amount: '150', worstUnits: 976_000n, available: MON_ATOMS('412') }),
  );
  assert.deepEqual(ok.cta, { label: 'Sell 150 MON', enabled: true });
  assert.equal(ok.sub, '≈ 147.18 USDC · at 0.9812');
  assert.equal(ok.needAtoms, MON_ATOMS('150'));
});

test('a limit buy: price first, on the tick, then the total with the maker fee', () => {
  const limit = (over: Partial<TicketInput>) =>
    evaluateTicket(
      marketBuy({ orderType: 'limit', amount: '150', limitPrice: '0.95', quote: null, ...over }),
    );
  assert.equal(limit({ limitPrice: '' }).cta.label, 'Enter a price');
  assert.equal(
    evaluateTicket({
      ...marketBuy({ orderType: 'limit', amount: '1', limitPrice: '1.50005' }),
      market: { ...MON, tickSize: 100n },
    }).cta.label,
    'Price must be a multiple of 0.0001',
  );
  const ticket = limit({});
  assert.deepEqual(ticket.cta, { label: 'Place limit buy', enabled: true });
  assert.equal(ticket.sub, 'Total 142.50 USDC');
  assert.deepEqual(ticket.disclosure, ['Limit · may fill in parts · fee on fill ≈ 0.03 USDC']);
  // 142.5 + 0.02% maker headroom, rounded up to the atom.
  assert.equal(ticket.needAtoms, 142_528_500n);
});

test('review rows carry the bound the order is signed with', () => {
  const input = marketBuy();
  const rows = reviewRows(input, evaluateTicket(input));
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ['Est. fill', '0.9812 USDC'],
      ['Worst price', '0.9861 USDC · +0.5%'],
      ['Size', '202.7 MON'],
      ['You pay at most', '200.00 USDC with fee'],
      ['Fee', '0.04 USDC'],
      ["If it can't fill at 0.9861", 'the rest is cancelled'],
      ['Venue', 'Kuru · MON-USDC book'],
    ],
  );
  const sell = marketBuy({
    side: 'sell',
    amount: '100',
    worstUnits: 976_000n,
    available: MON_ATOMS('412'),
  });
  const got = reviewRows(sell, evaluateTicket(sell)).find((r) => r.label === 'You get at least');
  // 100 × 0.976 = 97.6, less 0.04% = 97.56096 → 97.56
  assert.equal(got?.value, '97.56 USDC');
});

test('slippage goes to the quote as a fraction', () => {
  assert.equal(slippageFraction(50), '0.005');
  assert.equal(slippageFraction(300), '0.03');
});

test('shortSize keeps four significant digits and truncates', () => {
  assert.equal(shortSize('203.83'), '203.8');
  assert.equal(shortSize('150'), '150');
  assert.equal(shortSize('0.0031239'), '0.003123');
  assert.equal(shortSize('12345.6'), '12,345');
  assert.equal(shortSize('1.99999'), '1.999');
});

const FILLS = [
  { price: '0.9818', size: '81.48', tradeId: 'a' },
  { price: '0.9848', size: '44.68', tradeId: 'b' },
];

const CTX = {
  side: 'buy',
  orderType: 'market',
  base: 'MON',
  quote: 'USDC',
  price: '0.9861',
  slippageBps: 50,
} as const;

test('a partial fill says how much, why, and never rounds the percent up', () => {
  const result: KuruPlaceResult = {
    status: 'partially_filled',
    requestedSize: '203.83',
    filledSize: '126.16',
    avgPrice: '0.9829',
    fee: '0.02',
    feeAsset: 'USDC',
    fills: FILLS,
    unfilledCancelled: '77.67',
  };
  const view = resultView(result, CTX);
  assert.equal(view.mark, 'half');
  assert.equal(view.filledPct, 61);
  assert.equal(view.fillLine, 'Filled 61% · rest cancelled');
  assert.equal(view.detail, 'of 203.8 · at 0.9829 avg');
  assert.match(view.why ?? '', /worst price \(0\.9861, max slippage 0\.5%\)/);
  assert.deepEqual(view.fills[0], { label: '81.48 MON', value: 'at 0.9818 · 80.00 USDC' });

  const resting = resultView(
    { ...result, unfilledCancelled: undefined },
    { ...CTX, orderType: 'limit', price: '0.95' },
  );
  assert.equal(resting.fillLine, 'Filled 61% · rest on the book');
});

test('filled and resting results', () => {
  const filled = resultView(
    {
      status: 'filled',
      requestedSize: '203.83',
      filledSize: '203.83',
      avgPrice: '0.9812',
      fee: '0.04',
      feeAsset: 'USDC',
      fills: [{ price: '0.9812', size: '203.83', tradeId: 'x' }],
    },
    CTX,
  );
  assert.equal(filled.mark, 'full');
  assert.equal(filled.detail, 'at 0.9812 avg · 200.00 USDC + 0.04 fee');

  const resting = resultView(
    {
      status: 'resting',
      requestedSize: '150',
      filledSize: '0',
      fee: '0',
      feeAsset: 'USDC',
      fills: [],
    },
    { ...CTX, orderType: 'limit', price: '0.95' },
  );
  assert.equal(resting.mark, 'ring');
  assert.equal(resting.lead, 'On the book');
  assert.equal(resting.detail, 'buy at 0.9500 · 142.50 USDC');
  assert.equal(filledPct('0', '150'), 0);
});

test('funds name where the money is; steps read as stones', () => {
  assert.deepEqual(
    fundsLines([
      { where: 'kuru', symbol: 'USDC', amount: '76.02' },
      { where: 'wallet', symbol: 'MON', amount: '0' },
    ]),
    ['76.02 USDC · in your Kuru account'],
  );
  assert.equal(stepState('included'), 'done');
  assert.equal(stepState('submitted'), 'now');
  assert.equal(stepState('reverted'), 'failed');
  assert.equal(stepState('queued'), 'wait');
});

test('the picker lists spot markets whose base you hold', () => {
  const markets = [
    { kind: 'spot', base: 'MON', symbol: 'MON-USDC' },
    { kind: 'perp', base: 'MON', symbol: 'MON-PERP' },
    { kind: 'spot', base: 'WETH', symbol: 'WETH-USDC' },
  ] as const;
  const held = heldMarkets(markets, [
    { symbol: 'MON', raw: 412n, amount: '412.00123' },
    { symbol: 'WETH', raw: 0n, amount: '0' },
  ]);
  assert.deepEqual(
    held.map((h) => [h.market.symbol, h.holding]),
    [['MON-USDC', '412 MON']],
  );
});
