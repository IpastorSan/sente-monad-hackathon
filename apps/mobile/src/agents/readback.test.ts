/** The one-sentence read-back under the mandate step (SEN-59). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultMandateForm, KURU_MARKETS, type MandateForm } from './mandate.ts';
import { presetValues } from './presets.ts';
import { formatDay, orderUnit, readBack } from './readback.ts';

// 2026-09-25 00:00 UTC.
const NOW = 1_790_294_400;
const DAY = 86_400;

function market(symbol: string) {
  const found = KURU_MARKETS.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`no market ${symbol}`);
  return found.address;
}

function form(patch: Partial<MandateForm> = {}): MandateForm {
  return { ...defaultMandateForm(NOW), ...patch };
}

test('formatDay prints the UTC day, month first', () => {
  assert.equal(formatDay(NOW), 'Sep 25');
  assert.equal(formatDay(NOW + 7 * DAY), 'Oct 2');
  // 23:59 UTC is still the same day, whatever the device's zone.
  assert.equal(formatDay(NOW + DAY - 60), 'Sep 25');
});

test('the default form reads back as one sentence', () => {
  assert.equal(
    readBack(form(), NOW + 7 * DAY),
    'May trade MON-USDC on Kuru, up to 50 USDC an order, until Oct 2.',
  );
});

test('two venues name both, with leverage and either quote token', () => {
  const { form: wide } = presetValues('wide', NOW);
  assert.equal(
    readBack(wide, NOW + 30 * DAY),
    'May trade MON-USDC and WETH-USDC on Kuru and BTC-PERP and ETH-PERP on Perpl at up to 2× leverage, up to 250 USDC or AUSD an order, until Oct 25.',
  );
});

test('three markets are listed with a final "and"', () => {
  const kuruMarkets = [market('MON-USDC'), market('WETH-USDC'), market('WBTC-USDC')];
  assert.match(
    readBack(form({ kuruMarkets }), NOW),
    /^May trade MON-USDC, WETH-USDC and WBTC-USDC on Kuru,/,
  );
});

test('large orders are grouped the way the review step groups them', () => {
  assert.match(
    readBack(form({ maxOrderNotional: '12500.5' }), NOW),
    /up to 12,500\.5 USDC an order/,
  );
});

test('a half-filled form says what is missing rather than guessing', () => {
  assert.equal(readBack(form({ kuru: false }), NOW), 'Can’t trade anywhere yet. Pick a venue.');
  assert.equal(
    readBack(form({ kuruMarkets: [], maxOrderNotional: '' }), NOW),
    'May trade on Kuru once you pick a market, until Sep 25.',
  );
  assert.equal(
    readBack(
      form({ kuru: false, perpl: true, perplMarkets: '', maxLeverage: 'x', maxOrderNotional: '0' }),
      NOW,
    ),
    'May trade on Perpl once you name a market, until Sep 25.',
  );
});

test('orderUnit follows the venues picked', () => {
  assert.equal(orderUnit({ kuru: true, perpl: false }), 'USDC');
  assert.equal(orderUnit({ kuru: false, perpl: true }), 'AUSD');
  assert.equal(orderUnit({ kuru: true, perpl: true }), 'USDC or AUSD');
  assert.equal(orderUnit({ kuru: false, perpl: false }), undefined);
});
