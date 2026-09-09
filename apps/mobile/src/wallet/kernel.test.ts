/**
 * Deterministic address derivation. Plain node, no device.
 *
 * The offline half runs always: `kernelFactoryArgs` is pure, so a fixed owner
 * key must always produce the same `initCode`, and that `initCode` — together
 * with the pinned MetaFactory — is what fixes the CREATE2 address. If this file
 * ever needs updating, every existing user's smart account moved.
 *
 * The live half needs an RPC round trip (EntryPoint's `getSenderAddress`), so
 * it is opt-in behind SENTE_LIVE_RPC_TESTS=1 rather than making `pnpm test`
 * depend on Monad testnet being up. Run it with:
 *
 *     SENTE_LIVE_RPC_TESTS=1 mise exec -- pnpm --filter @sente/mobile test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { kernelFactoryArgs, KERNEL_ADDRESSES, toSenteKernelAccount } from './kernel.ts';

/**
 * Two fixed owner keys and the accounts they own. These are the well-known
 * anvil test keys #1 and #0 — public by construction, deliberately not secret,
 * and used here only as stable derivation inputs.
 *
 * `address` was observed against Monad testnet (chain 10143) on 2026-09-09 via
 * EntryPoint v0.7 `getSenderAddress`, and `factoryData` came from
 * `permissionless`'s own `toKernelSmartAccount(...).getFactoryArgs()`.
 */
const VECTORS = [
  {
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    address: '0xEC4b217240f0292c65Bf136b341e400e2D28cA6F',
    factoryData:
      '0x' +
      'c5265d5d000000000000000000000000aac5d4240af87249b3f71bc8e4a2cae0' +
      '74a3e41900000000000000000000000000000000000000000000000000000000' +
      '0000006000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '000001243c3b752b01845ADb2C711129d4f3966735eD98a9F09fC4cE57000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000000000a0000000000000000000000000000000000000000000000000' +
      '00000000000000e0000000000000000000000000000000000000000000000000' +
      '0000000000000100000000000000000000000000000000000000000000000000' +
      '000000000000001470997970C51812dc3A010C7d01b50e0d17dc79C800000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000',
  },
  {
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    address: '0xB3729F7e1Ab0B4a50E7De5599Ecc321B8775d30d',
  },
] as const;

const lower = (value: string): string => value.toLowerCase();

test('the fixed owner keys still produce the expected owner addresses', () => {
  for (const vector of VECTORS) {
    assert.equal(privateKeyToAccount(vector.privateKey).address, vector.owner);
  }
});

test('factory args are pinned for a fixed owner key', () => {
  const args = kernelFactoryArgs(VECTORS[0].owner);
  assert.equal(args.factory, KERNEL_ADDRESSES.metaFactory);
  assert.equal(lower(args.factoryData), lower(VECTORS[0].factoryData));
});

test('the owner address is the only variable input to the init code', () => {
  // Same shape, one 20-byte field different — so a wrong owner cannot produce
  // the right address, and nothing else (time, nonce, chain) can move it.
  const a = kernelFactoryArgs(VECTORS[0].owner).factoryData;
  const b = kernelFactoryArgs(VECTORS[1].owner).factoryData;
  assert.equal(a.length, b.length);
  assert.notEqual(lower(a), lower(b));
  assert.ok(lower(a).includes(lower(VECTORS[0].owner).slice(2)));
  assert.ok(lower(b).includes(lower(VECTORS[1].owner).slice(2)));
  assert.equal(
    lower(a).replace(lower(VECTORS[0].owner).slice(2), ''),
    lower(b).replace(lower(VECTORS[1].owner).slice(2), ''),
  );
});

test('derivation is idempotent and case-insensitive in the owner', () => {
  const canonical = kernelFactoryArgs(VECTORS[0].owner).factoryData;
  assert.equal(kernelFactoryArgs(VECTORS[0].owner).factoryData, canonical);
  // A lowercased owner is the same account: `kernelFactoryArgs` checksums it.
  assert.equal(kernelFactoryArgs(lower(VECTORS[0].owner) as `0x${string}`).factoryData, canonical);
});

test('a different salt index is a different account', () => {
  assert.notEqual(
    lower(kernelFactoryArgs(VECTORS[0].owner, 0n).factoryData),
    lower(kernelFactoryArgs(VECTORS[0].owner, 1n).factoryData),
  );
});

// ---------------------------------------------------------------------------
// Live derivation against Monad testnet. Opt-in.
// ---------------------------------------------------------------------------

const live = process.env.SENTE_LIVE_RPC_TESTS === '1';

test(
  'the counterfactual address on Monad testnet matches the pinned vectors',
  { skip: live ? false : 'set SENTE_LIVE_RPC_TESTS=1 to run against Monad testnet' },
  async () => {
    const client = createPublicClient({ chain: monadTestnet, transport: http() });
    for (const vector of VECTORS) {
      const account = await toSenteKernelAccount({
        client,
        owner: privateKeyToAccount(vector.privateKey),
      });
      assert.equal(account.address, vector.address);

      // permissionless must agree with our pure implementation, or the client
      // would refuse a perfectly good deployment.
      const args = await account.getFactoryArgs();
      const ours = kernelFactoryArgs(vector.owner);
      assert.equal(lower(args.factory ?? ''), lower(ours.factory));
      assert.equal(lower(args.factoryData ?? ''), lower(ours.factoryData));
    }
  },
);
