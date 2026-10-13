/** SEN-215: one dollar total and its breakdown by coin. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TickerDto } from '../markets/api.ts';

import { dollars, priceLabel, unpricedNote, valuation } from './valuation.ts';

function ticker(symbol: string, last: string | null): TickerDto {
  return {
    venue: 'kuru',
    symbol,
    quote: 'USDC',
    last,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct: null,
    quoteVolume24h: null,
    funding: null,
    stale: false,
    asOf: 0,
  };
}

// MON's Kuru book is empty: no last, no mid.
const TICKERS = [ticker('WETH-USDC', '2542.20'), ticker('MON-USDC', null)];

const OWNER = [
  { asset: 'USDC', amount: '120.004' },
  { asset: 'AUSD', amount: '295.409' },
  { asset: 'WETH', amount: '0.0098' },
  { asset: 'MON', amount: '0.2952' },
];

test('the headline is exactly the sum of the rows as printed', () => {
  const v = valuation(OWNER, TICKERS);
  const printed = v.rows.flatMap((r) => (r.usd === null ? [] : [Number(r.usd) * 100]));
  assert.equal(
    printed.reduce((a, b) => a + b, 0),
    Math.round(Number(v.usd) * 100),
  );
  // Each row floored to the cent first: 120.00 + 295.40 + 24.91 (0.0098 × 2542.20 = 24.91356).
  assert.deepEqual(
    v.rows.map((r) => [r.asset, r.usd]),
    [
      ['AUSD', '295.40'],
      ['USDC', '120.00'],
      ['WETH', '24.91'],
      ['MON', null],
    ],
  );
  assert.equal(v.usd, '440.31');
  assert.equal(dollars(v.usd), '$440.31');
});

test('a coin with no price is listed and named, and left out of the total', () => {
  const v = valuation(OWNER, TICKERS);
  assert.deepEqual(v.unpriced, ['MON']);
  const mon = v.rows.at(-1);
  assert.equal(mon?.asset, 'MON');
  assert.equal(mon?.price, null);
  assert.equal(mon?.source, null);
  assert.equal(valuation([{ asset: 'MON', amount: '0.15' }], TICKERS).usd, '0.00');
  assert.equal(unpricedNote(v.unpriced), 'MON has no Kuru price, so it is not counted.');
  assert.equal(unpricedNote([]), null);
});

test('stablecoins count at $1 and tokens at their Kuru last price, each labelled', () => {
  const v = valuation(OWNER, TICKERS);
  const usdc = v.rows.find((r) => r.asset === 'USDC');
  const weth = v.rows.find((r) => r.asset === 'WETH');
  assert.equal(usdc && priceLabel(usdc), '@ $1');
  assert.equal(weth && priceLabel(weth), '@ $2,542.20 Kuru');
  assert.equal(priceLabel({ price: '0.02613', source: 'kuru' }), '@ $0.0261 Kuru');
});

test('zero amounts are not rows; nothing held is $0.00', () => {
  const v = valuation([{ asset: 'USDC', amount: '0' }], TICKERS);
  assert.deepEqual(v.rows, []);
  assert.equal(v.usd, '0.00');
  assert.equal(dollars('-3.456'), '−$3.46');
});
