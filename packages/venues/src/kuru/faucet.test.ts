/** `kuru:faucet` argument parsing and the claim call (SEN-189). Plain node, no network. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KURU_FAUCET } from './constants.ts';
import { kuruFaucetClaimCall, kuruFaucetWaitSeconds, parseKuruFaucetArgs } from './faucet.ts';

test('defaults to the treasury key, live', () => {
  assert.deepEqual(parseKuruFaucetArgs([]), {
    key: 'treasury',
    envVar: 'TREASURY_PRIVATE_KEY',
    dryRun: false,
  });
  // pnpm passes the `--` separator through.
  assert.equal(parseKuruFaucetArgs(['--']).key, 'treasury');
});

test('--key starter claims with the starter-kit key; --dry-run and --rpc are read', () => {
  assert.deepEqual(
    parseKuruFaucetArgs(['--', '--key', 'starter', '--dry-run', '--rpc', 'http://x']),
    {
      key: 'starter',
      envVar: 'STARTER_DRIP_PRIVATE_KEY',
      dryRun: true,
      rpcUrl: 'http://x',
    },
  );
});

test('refuses an unknown key, a missing value and any other argument', () => {
  assert.throws(() => parseKuruFaucetArgs(['--key', 'gas']), /treasury or starter/);
  assert.throws(() => parseKuruFaucetArgs(['--key']), /needs a value/);
  assert.throws(() => parseKuruFaucetArgs(['--key', '--dry-run']), /needs a value/);
  assert.throws(() => parseKuruFaucetArgs(['--yes']), /unknown argument/);
});

test('the claim is a bare claim() to Set C’s faucet, at its measured gas', () => {
  assert.deepEqual(kuruFaucetClaimCall(), {
    to: '0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9',
    data: '0x4e71d92d',
    gas: KURU_FAUCET.claimGas,
  });
});

test('the cooldown: seconds left, or 0 when a claim may be made', () => {
  assert.equal(kuruFaucetWaitSeconds(0n, 1_000), 0);
  assert.equal(kuruFaucetWaitSeconds(1_000n, 1_000), 0);
  assert.equal(kuruFaucetWaitSeconds(1_600n, 1_000.9), 600);
});
