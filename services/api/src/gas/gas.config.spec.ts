import { parseEther } from 'viem';

import { GAS_DRIP_DEFAULTS, loadGasDripConfig } from './gas.config';

const KEY_A = `0x${'11'.repeat(32)}`;
const KEY_B = `0x${'22'.repeat(32)}`;

describe('loadGasDripConfig', () => {
  it('defaults to 0.1 MON and a 21000 gas limit', () => {
    const config = loadGasDripConfig({});

    expect(config.amountWei).toBe(parseEther('0.1'));
    expect(config.gasLimit).toBe(21_000n);
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

  it('rejects a non-integer rate limit', () => {
    expect(() => loadGasDripConfig({ GAS_DRIP_RATE_LIMIT_MAX: '2.5' })).toThrow(
      /must be a positive integer/,
    );
  });
});
