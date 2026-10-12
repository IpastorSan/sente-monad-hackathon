/**
 * The two Kuru deployments the indexer can follow (SEN-189): each config file
 * names exactly its deployment's books and AccountCore, and the seeds the
 * handlers use follow `ENVIO_KURU_DEPLOYMENT`. `npm test` runs this file a
 * second time with `ENVIO_KURU_DEPLOYMENT=set-c`, so the active-deployment
 * checks run for both.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { accountAddressCall } from './accountAddress.ts';
import {
  KURU_ACCOUNT_CORE,
  KURU_DEPLOYMENT,
  KURU_DEPLOYMENT_SEEDS,
  KURU_MARKET_SEEDS,
  DEFAULT_KURU_DEPLOYMENT,
  kuruDeploymentFromEnv,
  kuruMarketByAddress,
  kuruTokenDecimals,
  type KuruDeploymentId,
} from './seeds.ts';

const CONFIGS: Readonly<Record<KuruDeploymentId, string>> = {
  'set-d': 'config.yaml',
  'set-c': 'config.setc.yaml',
};

/** The addresses under each `- name:` of the `chains:` block, lowercase. */
function chainAddresses(file: string): { books: string[]; accountCore: string[] } {
  const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const chains = text.slice(text.indexOf('\nchains:'), text.indexOf('\ncontracts:'));
  const books = chains.slice(
    chains.indexOf('name: KuruOrderBook'),
    chains.indexOf('name: KuruAccountCore'),
  );
  const core = chains.slice(chains.indexOf('name: KuruAccountCore'));
  const all = (s: string) => [...s.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
  return { books: all(books), accountCore: all(core) };
}

for (const id of ['set-c', 'set-d'] as const) {
  test(`${CONFIGS[id]} indexes exactly ${id}'s books and AccountCore`, () => {
    const seeds = KURU_DEPLOYMENT_SEEDS[id];
    const { books, accountCore } = chainAddresses(CONFIGS[id]);
    assert.deepEqual([...books].sort(), seeds.markets.map((m) => m.address).sort());
    assert.deepEqual(accountCore, [seeds.accountCore]);
  });
}

test('config.setc.yaml declares AccountRegistered in Set C’s shape, config.yaml in Set D’s', () => {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.match(
    read('config.setc.yaml'),
    /AccountRegistered\(address indexed account, uint40 indexed accountId/,
  );
  assert.match(
    read('config.yaml'),
    /AccountRegistered\(uint40 indexed accountId, uint40 indexed rootAccountId, address indexed rootOwner/,
  );
});

test('the deployment comes from ENVIO_KURU_DEPLOYMENT, then KURU_DEPLOYMENT, else the committed default', () => {
  assert.equal(kuruDeploymentFromEnv({}), DEFAULT_KURU_DEPLOYMENT);
  assert.equal(kuruDeploymentFromEnv({ KURU_DEPLOYMENT: 'set-d' }), 'set-d');
  assert.equal(kuruDeploymentFromEnv({ KURU_DEPLOYMENT: 'set-c' }), 'set-c');
  assert.equal(
    kuruDeploymentFromEnv({ ENVIO_KURU_DEPLOYMENT: 'SET-C', KURU_DEPLOYMENT: 'set-d' }),
    'set-c',
  );
  assert.throws(() => kuruDeploymentFromEnv({ ENVIO_KURU_DEPLOYMENT: 'c' }), /set-c or set-d/);
});

test('the handlers use the active deployment’s tables, and only them', () => {
  assert.equal(KURU_DEPLOYMENT.id, kuruDeploymentFromEnv());
  assert.equal(KURU_ACCOUNT_CORE, KURU_DEPLOYMENT.accountCore);
  assert.equal(accountAddressCall(1n).to, KURU_DEPLOYMENT.accountCore);
  assert.equal(KURU_MARKET_SEEDS.length, KURU_DEPLOYMENT.markets.length);
  const other = KURU_DEPLOYMENT_SEEDS[KURU_DEPLOYMENT.id === 'set-c' ? 'set-d' : 'set-c'];
  for (const market of KURU_DEPLOYMENT.markets) assert.ok(kuruMarketByAddress(market.address));
  // A fill from the other deployment's book is skipped, never decoded at its precision.
  for (const market of other.markets) assert.equal(kuruMarketByAddress(market.address), undefined);
  assert.equal(kuruTokenDecimals(Object.keys(KURU_DEPLOYMENT.tokenDecimals)[1]!), 6); // USDC
});

test('Set C: MON-USDC sizes in 10^8, cbBTC has 8 decimals, ids resolve via userAddressById', () => {
  const setC = KURU_DEPLOYMENT_SEEDS['set-c'];
  const mon = setC.markets.find((m) => m.symbol === 'MON-USDC')!;
  assert.equal(mon.sizePrecision, 100_000_000n);
  assert.equal(setC.tokenDecimals['0xef2a20a161ac9ed1117d721336226b6399f15b4d'], 8);
  assert.equal(setC.accountAddressGetter, 'userAddressById');
});
