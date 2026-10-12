/**
 * The address table is hand-copied from deployment docs, and viem refuses a
 * mixed-case address whose EIP-55 checksum is wrong — at call time, deep in an
 * encoder. Catch a bad copy here instead of mid-run.
 *
 * Also the deployment switch (SEN-189): this file runs once per deployment
 * (`pnpm run test` and `test:set-c`), so the `KURU_TESTNET_*` assertions hold
 * for whichever one `KURU_DEPLOYMENT` selects.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAddress } from 'viem';

import {
  DEFAULT_KURU_DEPLOYMENT,
  KURU_DEPLOYMENT,
  KURU_DEPLOYMENTS,
  KURU_DEPLOYMENT_IDS,
  KURU_FAUCET,
  KURU_RETIRED_DEPLOYMENT,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  kuruDeployment,
  kuruMarketSuccessor,
  kuruTokenSuccessor,
  NATIVE_TOKEN,
  parseKuruDeploymentId,
  retiredKuruMarket,
} from './constants.ts';

test('every configured address, on both deployments, is a valid checksummed address', () => {
  const addresses: [string, string][] = [['faucet', KURU_FAUCET.address]];
  for (const deployment of Object.values(KURU_DEPLOYMENTS)) {
    addresses.push(
      ...Object.entries(deployment.contracts).map(([k, v]): [string, string] => [k, v]),
      ...Object.values(deployment.tokens).map((t): [string, string] => [t.symbol, t.address]),
      ...deployment.markets.map((m): [string, string] => [m.symbol, m.address]),
    );
  }
  for (const [name, address] of addresses) {
    assert.ok(isAddress(address, { strict: true }), `${name}: ${address}`);
  }
});

test('the switch: unset is set-d, both ids parse, anything else throws', () => {
  assert.equal(DEFAULT_KURU_DEPLOYMENT, 'set-d');
  assert.equal(parseKuruDeploymentId(undefined), 'set-d');
  assert.equal(parseKuruDeploymentId('  '), 'set-d');
  assert.equal(parseKuruDeploymentId('set-c'), 'set-c');
  assert.equal(parseKuruDeploymentId(' SET-D '), 'set-d');
  assert.throws(() => parseKuruDeploymentId('setc'), /must be one of set-c, set-d/);
  assert.deepEqual(KURU_DEPLOYMENT_IDS, ['set-c', 'set-d']);
});

test('the active deployment is the one the environment names, and the exports are its tables', () => {
  const expected = parseKuruDeploymentId(
    process.env.KURU_DEPLOYMENT || process.env.EXPO_PUBLIC_KURU_DEPLOYMENT,
  );
  assert.equal(KURU_DEPLOYMENT.id, expected);
  assert.equal(kuruDeployment(), KURU_DEPLOYMENT);
  assert.equal(kuruDeployment('set-c'), KURU_DEPLOYMENTS['set-c']);
  assert.equal(KURU_TESTNET_CONTRACTS, KURU_DEPLOYMENT.contracts);
  assert.equal(KURU_TESTNET_TOKENS, KURU_DEPLOYMENT.tokens);
  assert.equal(KURU_TESTNET_MARKETS, KURU_DEPLOYMENT.markets);
  assert.notEqual(KURU_RETIRED_DEPLOYMENT.id, KURU_DEPLOYMENT.id);
});

test('each deployment carries its own custody model, catalog and faucet', () => {
  const c = KURU_DEPLOYMENTS['set-c'];
  const d = KURU_DEPLOYMENTS['set-d'];
  assert.equal(c.custody, 'address-keyed');
  assert.equal(d.custody, 'account-id');
  assert.equal(c.catalogListed, false);
  assert.equal(d.catalogListed, true);
  assert.equal(c.contracts.accountCore, '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22');
  assert.equal(d.contracts.accountCore, '0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038');
  assert.equal(c.contracts.testnetTokenFaucet, KURU_FAUCET.address);
  assert.equal(d.contracts.testnetTokenFaucet, undefined);
  assert.equal(c.tokens.USDC.address, '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E');
  assert.deepEqual(
    c.markets.map((m) => m.symbol),
    ['MON-USDC', 'WETH-USDC', 'cbBTC-USDC', 'XAUt-USDC'],
  );
  assert.equal(c.markets[0]!.sizePrecision, 100_000_000n, 'Set C MON-USDC is 10^8');
  assert.equal(d.markets[0]!.sizePrecision, 1_000_000n, 'Set D MON-USDC is 10^6');
});

test('every market is quoted in its own deployment USDC, not AUSD', () => {
  for (const deployment of Object.values(KURU_DEPLOYMENTS)) {
    for (const market of deployment.markets) {
      assert.equal(market.quote, deployment.tokens.USDC, `${deployment.id} ${market.symbol}`);
    }
  }
});

test('every retired market and token maps to an active one, or to nothing', () => {
  for (const old of KURU_RETIRED_DEPLOYMENT.markets) {
    const next = kuruMarketSuccessor(old.address);
    if (old.successor === null) {
      assert.equal(next, null, old.symbol);
      continue;
    }
    assert.ok(next && KURU_TESTNET_MARKETS.includes(next), old.symbol);
    assert.equal(retiredKuruMarket(next.address), undefined, `${next.symbol} is not retired`);
  }
  for (const old of KURU_RETIRED_DEPLOYMENT.tokens) {
    const next = kuruTokenSuccessor(old.address);
    if (old.successor === null) assert.equal(next, null, old.symbol);
    else assert.ok(next && Object.values(KURU_TESTNET_TOKENS).includes(next), old.symbol);
  }
  const cbBtc = KURU_DEPLOYMENTS['set-c'].markets.find((m) => m.symbol === 'cbBTC-USDC')!;
  const wbtc = KURU_DEPLOYMENTS['set-d'].markets.find((m) => m.symbol === 'WBTC-USDC')!;
  if (KURU_DEPLOYMENT.id === 'set-d') {
    assert.equal(kuruMarketSuccessor(cbBtc.address)?.symbol, 'WBTC-USDC');
  } else {
    assert.equal(kuruMarketSuccessor(wbtc.address)?.symbol, 'cbBTC-USDC');
    const usdt = KURU_DEPLOYMENTS['set-d'].markets.find((m) => m.symbol === 'USDT-USDC')!;
    assert.equal(kuruMarketSuccessor(usdt.address), null, 'Set C has no USDT book');
  }
  assert.throws(() => kuruMarketSuccessor(KURU_TESTNET_MARKETS[0]!.address));
});

test('no address is both active and retired', () => {
  const retired = [
    ...Object.values(KURU_RETIRED_DEPLOYMENT.contracts),
    ...KURU_RETIRED_DEPLOYMENT.tokens.map((t) => t.address),
    ...KURU_RETIRED_DEPLOYMENT.markets.map((m) => m.address),
  ].map((a) => a.toLowerCase());
  const current = [
    ...Object.values(KURU_TESTNET_CONTRACTS),
    ...Object.values(KURU_TESTNET_TOKENS).map((t) => t.address),
    ...KURU_TESTNET_MARKETS.map((m) => m.address),
  ]
    .map((a) => a.toLowerCase())
    .filter((a) => a !== NATIVE_TOKEN);
  for (const address of current) assert.ok(!retired.includes(address), address);
});
