/**
 * Pins `MONAD_GAS_LIMITS` against measured gas.
 *
 * Monad charges the gas LIMIT, so a limit below the real cost is the worst of
 * both worlds: the call reverts AND the full limit is charged. That is what
 * `erc20Transfer: 65_000n` did to two real AUSD transfers. The measurements
 * live HERE, not next to the constants, so lowering a constant cannot quietly
 * lower its floor too.
 *
 * All measured with `eth_estimateGas` against Monad testnet on 2026-09-10 and
 * matching the gasUsed of real transactions the same day.
 *
 * `./client.ts` is imported with its extension because node's native type
 * stripping runs this file directly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MONAD_GAS_LIMITS, MONAD_TX_DEFAULTS } from './client.ts';

const MEASURED = {
  nativeTransfer: 21_000n, // MON -> fresh EOA
  nativeTransferToSmartAccount: 40_995n, // MON -> Kernel v0.3.1 account
  erc20Transfer: 72_918n, // AUSD -> zero-balance recipient (worst case)
  erc20Approve: 71_099n, // AUSD approve, fresh spender
} as const satisfies Record<keyof typeof MONAD_GAS_LIMITS, bigint>;

/** Headroom beyond this is money spent for nothing on every call. */
const MAX_HEADROOM_PERCENT = 20n;

for (const [name, measured] of Object.entries(MEASURED) as [keyof typeof MEASURED, bigint][]) {
  test(`${name}: at least the measured ${measured}, at most +${MAX_HEADROOM_PERCENT}%`, () => {
    const limit = MONAD_GAS_LIMITS[name];
    assert.ok(
      limit >= measured,
      `${name} = ${limit} is below the measured ${measured}: it reverts`,
    );
    assert.ok(
      limit <= (measured * (100n + MAX_HEADROOM_PERCENT)) / 100n,
      `${name} = ${limit} overpays: Monad charges the limit, re-measure instead of padding`,
    );
  });
}

test('every limit has a measurement', () => {
  assert.deepEqual(Object.keys(MONAD_GAS_LIMITS).sort(), Object.keys(MEASURED).sort());
});

test('the default is the EOA transfer, not the smart-account one', () => {
  assert.equal(MONAD_TX_DEFAULTS.gas, MONAD_GAS_LIMITS.nativeTransfer);
  assert.ok(MONAD_TX_DEFAULTS.gas < MEASURED.nativeTransferToSmartAccount);
});
