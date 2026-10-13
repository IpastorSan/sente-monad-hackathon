/** The build's Kuru deployment against the API's (SEN-189). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KURU_DEPLOYMENTS } from '@sente/venues/kuru';

import {
  KURU_DEPLOYMENT_PIN,
  kuruDeploymentAgrees,
  kuruDeploymentNote,
  parseKuruDeploymentPin,
} from './kuruDeployment.ts';
import { isTradingEnabled } from './api.ts';

const C = KURU_DEPLOYMENTS['set-c'];
const D = KURU_DEPLOYMENTS['set-d'];
const server = (d: typeof C) => ({ id: d.id, accountCore: d.contracts.accountCore });

test('the pin parses like the server switch, and a bad value fails closed', () => {
  assert.equal(parseKuruDeploymentPin(undefined), 'set-d');
  assert.equal(parseKuruDeploymentPin('set-c'), 'set-c');
  assert.equal(parseKuruDeploymentPin('setc'), null);
});

test('agrees only on the same deployment and AccountCore', () => {
  assert.equal(kuruDeploymentAgrees(server(C), 'set-c', C), true);
  assert.equal(kuruDeploymentAgrees(server(D), 'set-d', D), true);
  assert.equal(kuruDeploymentAgrees(server(D), 'set-c', C), false);
  assert.equal(kuruDeploymentAgrees(server(C), 'set-d', D), false);
  // Right id, wrong AccountCore: refused.
  assert.equal(
    kuruDeploymentAgrees({ id: 'set-c', accountCore: D.contracts.accountCore }, 'set-c', C),
    false,
  );
  // An API older than SEN-189 says nothing, and it was Set D.
  assert.equal(kuruDeploymentAgrees(undefined, 'set-d', D), true);
  assert.equal(kuruDeploymentAgrees(undefined, 'set-c', C), false);
  // A broken pin, or a venues package that resolved another deployment, never agrees.
  assert.equal(kuruDeploymentAgrees(server(C), null, C), false);
  assert.equal(kuruDeploymentAgrees(server(C), 'set-c', D), false);
});

test('manual Kuru trading is off when the API trades the other deployment', () => {
  const capabilities = {
    enabled: true,
    atomicBatch: false,
    chainId: 10143,
    venues: { kuru: true, perpl: false },
    kuruBuilder: null,
  };
  const input = { buildFlag: '1', network: 'testnet' as const, builderPin: null };
  const mine = KURU_DEPLOYMENT_PIN === 'set-c' ? C : D;
  const other = mine === C ? D : C;
  assert.equal(
    isTradingEnabled({ ...input, capabilities: { ...capabilities, kuruDeployment: server(mine) } }),
    true,
  );
  assert.equal(
    isTradingEnabled({
      ...input,
      capabilities: { ...capabilities, kuruDeployment: server(other) },
    }),
    false,
  );
});

test('the Set C note says why, and Set D has none', () => {
  const note = kuruDeploymentNote('set-c')!;
  assert.equal(
    `${note.title}: ${note.detail}`,
    "Kuru testnet: earlier deployment: Sente trades Kuru Spot V2 on its earlier testnet deployment. Kuru's newest testnet deployment hands out its test USDC on request only, so new users couldn't fund a trade there. The same Kuru Spot V2 contracts, with real on-chain fills.",
  );
  assert.equal(kuruDeploymentNote('set-d'), null);
});
