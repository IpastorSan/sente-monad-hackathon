/**
 * The preset catalog with Kuru's Set C active (SEN-189): the market mirror and
 * the BTC hedge follow `KURU_DEPLOYMENT`. Runs in `test:set-c`; skips otherwise.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPreset } from './index.ts';
import {
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
