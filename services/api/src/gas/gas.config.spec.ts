import { parseEther } from 'viem';

import { GAS_DRIP_DEFAULTS, loadGasDripConfig } from './gas.config';

const KEY_A = `0x${'11'.repeat(32)}`;
const KEY_B = `0x${'22'.repeat(32)}`;

/**
 * Measured gas for the two sends the drip makes, pinned HERE rather than next
 * to the defaults so lowering a default cannot quietly lower its floor too.
 * Same numbers and pattern as apps/mobile/src/chain/client.test.ts — measured
 * with eth_estimateGas on Monad testnet (2026-09-10) and matching real gasUsed.
 */
const MEASURED = {
  gasLimit: 21_000n, // MON -> fresh EOA
  gasLimitContract: 40_995n, // MON -> deployed Kernel v0.3.1 account (runs receive())
} as const;

/** Monad charges the LIMIT, so headroom beyond this is money spent on every drip. */
const MAX_HEADROOM_PERCENT = 20n;

describe('GAS_DRIP_DEFAULTS gas limits', () => {
  it.each(Object.entries(MEASURED) as [keyof typeof MEASURED, bigint][])(
    '%s: at least the measured %s, at most +20%',
    (name, measured) => {
      const limit = GAS_DRIP_DEFAULTS[name];
      // Below the measurement the send reverts AND the whole limit is charged.
      expect(limit).toBeGreaterThanOrEqual(measured);
      expect(limit).toBeLessThanOrEqual((measured * (100n + MAX_HEADROOM_PERCENT)) / 100n);
    },
  );

  it('keeps the EOA limit below what a contract recipient needs', () => {
    // The whole point of choosing per recipient: EOAs must not pay for receive().
    expect(GAS_DRIP_DEFAULTS.gasLimit).toBeLessThan(MEASURED.gasLimitContract);
  });
});

describe('loadGasDripConfig', () => {
  it('defaults to 0.1 MON, 21000 gas to an EOA and 46000 to a contract', () => {
    const config = loadGasDripConfig({});

    expect(config.amountWei).toBe(parseEther('0.1'));
    expect(config.gasLimit).toBe(21_000n);
    expect(config.gasLimitContract).toBe(46_000n);
    expect(config.dailyCapWei).toBe(parseEther(GAS_DRIP_DEFAULTS.dailyCapMon));
    expect(config.senderKeys).toEqual([]);
    expect(config.dryRun).toBe(false);
  });

  it('reads keys from GAS_DRIP_PRIVATE_KEYS, comma separated', () => {
    const config = loadGasDripConfig({ GAS_DRIP_PRIVATE_KEYS: ` ${KEY_A}, ${KEY_B} ` });

    expect(config.senderKeys).toEqual([KEY_A, KEY_B]);
  });

  it.each([
    ['not hex', 'nope'],
    ['too short', `0x${'11'.repeat(31)}`],
  ])('rejects a %s private key without echoing it', (_label, key) => {
    expect(() => loadGasDripConfig({ GAS_DRIP_PRIVATE_KEYS: key })).toThrow(
      /not a 0x-prefixed 32-byte hex private key/,
    );
    expect(() => loadGasDripConfig({ GAS_DRIP_PRIVATE_KEYS: key })).not.toThrow(
      new RegExp(key.slice(2, 12)),
    );
  });

  it('rejects duplicate keys, which would defeat rotation', () => {
    expect(() => loadGasDripConfig({ GAS_DRIP_PRIVATE_KEYS: `${KEY_A},${KEY_A}` })).toThrow(
      /duplicate keys/,
    );
  });

  it('caps the number of rotating keys at five', () => {
    const keys = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(64)}`).join(',');
    expect(() => loadGasDripConfig({ GAS_DRIP_PRIVATE_KEYS: keys })).toThrow(/max is 5/);
  });

  it('rejects a daily cap below one drip', () => {
    expect(() =>
      loadGasDripConfig({ GAS_DRIP_AMOUNT_MON: '0.5', GAS_DRIP_DAILY_CAP_MON: '0.1' }),
    ).toThrow(/below GAS_DRIP_AMOUNT_MON/);
  });

  it('refuses dry run in production', () => {
    expect(() => loadGasDripConfig({ GAS_DRIP_DRY_RUN: 'true', NODE_ENV: 'production' })).toThrow(
      /cannot be enabled with NODE_ENV=production/,
    );
  });

  it('reads the contract gas limit from GAS_DRIP_GAS_LIMIT_CONTRACT', () => {
    const config = loadGasDripConfig({ GAS_DRIP_GAS_LIMIT_CONTRACT: '48000' });
    expect(config.gasLimitContract).toBe(48_000n);
    expect(config.gasLimit).toBe(21_000n);
  });

  it.each(['0', '-1', '45000.5', 'lots'])('rejects a GAS_DRIP_GAS_LIMIT_CONTRACT of %s', (raw) => {
    expect(() => loadGasDripConfig({ GAS_DRIP_GAS_LIMIT_CONTRACT: raw })).toThrow(
      /GAS_DRIP_GAS_LIMIT_CONTRACT must be a positive integer/,
    );
  });

  it('rejects a non-integer rate limit', () => {
    expect(() => loadGasDripConfig({ GAS_DRIP_RATE_LIMIT_MAX: '2.5' })).toThrow(
      /must be a positive integer/,
    );
  });
});
