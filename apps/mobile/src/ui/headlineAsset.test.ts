/** The headline asset of a multi-asset total (SEN-213). Plain node, no device. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compareAmounts } from './assetAmounts.ts';
import {
  createHeadlinePreference,
  defaultHeadline,
  HEADLINE_KEY,
  headlineFor,
  heldAmounts,
  type PreferenceStore,
} from './headlineAsset.ts';

const OWNER = [
  { asset: 'USDC', amount: '160.47' },
  { asset: 'AUSD', amount: '400.48' },
  { asset: 'MON', amount: '0.8073' },
  { asset: 'cbBTC', amount: '0.000159' },
  { asset: 'WETH', amount: '0.00999' },
];

test('compareAmounts compares exact decimals of any scale and sign', () => {
  assert.equal(compareAmounts('400.48', '160.47'), 1);
  assert.equal(compareAmounts('10', '10.000'), 0);
  assert.equal(compareAmounts('0.000001', '0.00001'), -1);
  assert.equal(compareAmounts('-1', '0'), -1);
  assert.equal(compareAmounts('nope', '0'), null);
});

test('the default headline is the largest stablecoin holding', () => {
  assert.equal(defaultHeadline(OWNER), 'AUSD');
  assert.equal(
    defaultHeadline([
      { asset: 'USDC', amount: '25.52' },
      { asset: 'AUSD', amount: '20.89' },
    ]),
    'USDC',
  );
});

test('a stablecoin tie goes to USDC, whatever the scale or order', () => {
  assert.equal(
    defaultHeadline([
      { asset: 'AUSD', amount: '50.000000' },
      { asset: 'USDC', amount: '50' },
    ]),
    'USDC',
  );
});

test('with no stablecoin held the first asset leads; with nothing, there is none', () => {
  assert.equal(
    defaultHeadline([
      { asset: 'MON', amount: '0.8' },
      { asset: 'WETH', amount: '1' },
    ]),
    'MON',
  );
  assert.equal(defaultHeadline([]), null);
});

test('zero and unparseable lines are not held, so they are never the headline', () => {
  const amounts = [
    { asset: 'USDC', amount: '0.000000' },
    { asset: 'AUSD', amount: 'n/a' },
    { asset: 'WETH', amount: '0.01' },
  ];
  assert.deepEqual(heldAmounts(amounts), [{ asset: 'WETH', amount: '0.01' }]);
  assert.equal(headlineFor(amounts, null)?.line.asset, 'WETH');
});

test('headlineFor honours a held pick and falls back to the default otherwise', () => {
  assert.deepEqual(headlineFor(OWNER, 'MON')?.line, { asset: 'MON', amount: '0.8073' });
  assert.equal(headlineFor(OWNER, 'MON')?.choices.length, 5);
  // Picked on another total, not held by this one.
  assert.equal(headlineFor(OWNER, 'LINK')?.line.asset, 'AUSD');
  assert.equal(headlineFor([{ asset: 'USDC', amount: '1' }], 'AUSD')?.line.asset, 'USDC');
});

test('with nothing held the headline is the first line, with no choices', () => {
  const empty = headlineFor([{ asset: 'USDC', amount: '0' }], 'AUSD');
  assert.deepEqual(empty, { line: { asset: 'USDC', amount: '0' }, choices: [] });
  assert.equal(headlineFor([], null), null);
});

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const store: PreferenceStore = {
    getItemAsync: async (key) => data.get(key) ?? null,
    setItemAsync: async (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return { store, writes };
}

test('the pick is read back from the store and notifies subscribers', async () => {
  const { store } = fakeStore({ [HEADLINE_KEY]: 'MON' });
  const preference = createHeadlinePreference(store);
  let calls = 0;
  preference.subscribe(() => calls++);
  assert.equal(preference.get(), null);
  await preference.load();
  assert.equal(preference.get(), 'MON');
  assert.equal(calls, 1);
});

test('a pick is saved under the versioned key', async () => {
  const { store, writes } = fakeStore();
  const preference = createHeadlinePreference(store);
  await preference.set('WETH');
  assert.equal(preference.get(), 'WETH');
  assert.deepEqual(writes, [[HEADLINE_KEY, 'WETH']]);
});

test('a pick made before the read lands is not overwritten by the older stored one', async () => {
  let release: (value: string) => void = () => {};
  const store: PreferenceStore = {
    getItemAsync: () => new Promise((resolve) => (release = resolve)),
    setItemAsync: async () => {},
  };
  const preference = createHeadlinePreference(store);
  const loading = preference.load();
  await preference.set('USDC');
  release('AUSD');
  await loading;
  assert.equal(preference.get(), 'USDC');
});

test('a failing store is tolerated: no pick read, and a pick that cannot be saved still applies', async () => {
  const broken: PreferenceStore = {
    getItemAsync: () => Promise.reject(new Error('SecurityError')),
    setItemAsync: () => Promise.reject(new Error('QuotaExceededError')),
  };
  const preference = createHeadlinePreference(broken);
  await preference.load();
  assert.equal(preference.get(), null);
  await preference.set('AUSD');
  assert.equal(preference.get(), 'AUSD');
});

test('junk in the store is ignored', async () => {
  const { store } = fakeStore({ [HEADLINE_KEY]: '{"asset":"USDC"}' });
  const preference = createHeadlinePreference(store);
  await preference.load();
  assert.equal(preference.get(), null);
});
