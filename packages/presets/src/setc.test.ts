/**
 * The preset catalog with Kuru's Set C active (SEN-189): the market mirror and
 * the BTC hedge follow `KURU_DEPLOYMENT`. Runs in `test:set-c`; skips otherwise.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPreset, isPresetOffered, listPresets, renderPreset } from './index.ts';
import {
  KURU_DEFAULT_SPOT_MARKET,
  KURU_OPEN_ORDERS_READABLE,
  KURU_SPOT_MARKETS,
  KURU_SPOT_MARKETS_BY_DEPLOYMENT,
  kuruDeploymentFromEnv,
  resolveParams,
} from './params.ts';

const SET_C = { skip: kuruDeploymentFromEnv() !== 'set-c' };

test('the Kuru market list is Set C’s', SET_C, () => {
  assert.equal(KURU_SPOT_MARKETS, KURU_SPOT_MARKETS_BY_DEPLOYMENT['set-c']);
  assert.deepEqual(KURU_SPOT_MARKETS, ['MON-USDC', 'WETH-USDC', 'cbBTC-USDC', 'XAUt-USDC']);
});

test('a BTC perp is hedged on cbBTC-USDC, and a Set D book is not a market', SET_C, () => {
  const def = getPreset('funding-harvester')!;
  const r = resolveParams(def, { market: 'BTC-PERP' });
  assert.ok(r.ok);
  assert.deepEqual(def.suggestedMandate(r.params).kuruMarkets, ['cbBTC-USDC']);

  const ranger = getPreset('range-trader')!;
  assert.equal(resolveParams(ranger, { market: 'WBTC-USDC' }).ok, false);
  assert.equal(resolveParams(ranger, { market: 'XAUt-USDC' }).ok, true);
});

// Set C's quoted books; MON-USDC has none (SEN-198).
const SET_C_LIQUID = ['cbBTC-USDC', 'WETH-USDC', 'XAUt-USDC'];

test('every Kuru preset starts on a quoted Set C book, never MON-USDC', SET_C, () => {
  assert.equal(KURU_DEFAULT_SPOT_MARKET, 'cbBTC-USDC');
  for (const def of listPresets().filter((p) => p.venues.includes('kuru'))) {
    const spec = def.params.find((s) => s.type === 'market' && s.venue === 'kuru');
    if (!spec || spec.type !== 'market') continue;
    const defaults = Array.isArray(spec.default) ? spec.default : [spec.default];
    assert.ok(
      defaults.some((m) => SET_C_LIQUID.includes(m)),
      `${def.id} defaults to ${defaults.join(', ')}`,
    );
    const r = resolveParams(def, {});
    assert.ok(r.ok, def.id);
  }
});

test('Guardian starts on cbBTC with BTC-sized placeholders', SET_C, () => {
  const def = getPreset('guardian')!;
  const r = resolveParams(def, {});
  assert.ok(r.ok);
  assert.equal(r.params['market'], 'cbBTC-USDC');
  assert.equal(r.params['amount'], 0.001);
  assert.ok((r.params['sellBelow'] as number) < (r.params['sellAbove'] as number));
});

// SEN-203: Set C lists no Kuru open orders, so a preset that must find its own
// resting sell on Kuru again cannot run there.
test('Range Trader is withheld and refused on Set C', SET_C, () => {
  assert.equal(KURU_OPEN_ORDERS_READABLE, false);
  assert.ok(!listPresets().some((p) => p.id === 'range-trader'));
  assert.equal(isPresetOffered('range-trader'), false);
  // Still known by id, for agents already hired from it.
  assert.equal(getPreset('range-trader')?.name, 'Range Trader');
  assert.equal(renderPreset('range-trader', {}).ok, false);
});

test('Mean Reverter trades Perpl only on Set C', SET_C, () => {
  const def = getPreset('mean-reverter')!;
  assert.deepEqual(def.venues, ['perpl']);
  const r = renderPreset('mean-reverter', {});
  assert.ok(r.ok);
  assert.equal(r.params['market'], 'BTC-PERP');
  assert.deepEqual(def.suggestedMandate(r.params).venues, ['perpl']);
  assert.equal(renderPreset('mean-reverter', { market: 'cbBTC-USDC' }).ok, false);
});
