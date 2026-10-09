import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';

import { STARTER_KIT_GAS, loadStarterKitConfig } from './starter-kit.config';

const KEY = `0x${'33'.repeat(32)}`;
const OTHER = `0x${'44'.repeat(32)}`;

/**
 * Measured gas for an ERC-20 `transfer` to an address holding none of the token
 * (`eth_estimateGas` on Monad testnet, SEN-170, 2026-10-09). Pinned HERE, not
 * beside the limits, so lowering a limit cannot quietly lower its floor.
 */
const MEASURED = { AUSD: 72_918n, USDC: 63_976n } as const;
const MAX_HEADROOM_PERCENT = 20n;

describe('STARTER_KIT_GAS', () => {
  it.each(Object.entries(MEASURED) as [keyof typeof MEASURED, bigint][])(
    '%s: at least the measured %s, at most +20%',
    (symbol, measured) => {
      const limit = STARTER_KIT_GAS[symbol];
      // Below the measurement the transfer reverts AND the whole limit is charged.
      expect(limit).toBeGreaterThanOrEqual(measured);
      expect(limit).toBeLessThanOrEqual((measured * (100n + MAX_HEADROOM_PERCENT)) / 100n);
    },
  );
});

describe('loadStarterKitConfig', () => {
  it('is off when STARTER_DRIP_PRIVATE_KEY is unset or blank', () => {
    expect(loadStarterKitConfig({})).toEqual({ enabled: false });
    expect(loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: '  ' })).toEqual({ enabled: false });
  });

  it('defaults to 250 AUSD + 100 USDC for 50 users a day, AUSD first', () => {
    const config = loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY });

    if (!config.enabled) throw new Error('expected enabled');
    expect(config.senderKey).toBe(KEY);
    expect(config.dailyCapUsers).toBe(50);
    expect(config.tokens).toEqual([
      {
        symbol: 'AUSD',
        address: PERPL_TESTNET_CONTRACTS.collateral,
        decimals: 6,
        atoms: 250_000_000n,
        gasLimit: 82_000n,
      },
      {
        symbol: 'USDC',
        address: KURU_TESTNET_TOKENS.USDC.address,
        decimals: 6,
        atoms: 100_000_000n,
        gasLimit: 72_000n,
      },
    ]);
  });

  it('reads the amounts and the cap', () => {
    const config = loadStarterKitConfig({
      STARTER_DRIP_PRIVATE_KEY: KEY,
      STARTER_DRIP_AUSD: '120.5',
      STARTER_DRIP_USDC: '15',
      STARTER_DRIP_DAILY_CAP_USERS: '7',
    });

    if (!config.enabled) throw new Error('expected enabled');
    expect(config.tokens.map((token) => token.atoms)).toEqual([120_500_000n, 15_000_000n]);
    expect(config.dailyCapUsers).toBe(7);
  });

  it('leaves the Kuru USDC leg out at STARTER_DRIP_USDC=0, and still sends AUSD (SEN-185)', () => {
    // Kuru's current USDC has no faucet; a sender short of one token sends nothing.
    const config = loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY, STARTER_DRIP_USDC: '0' });
    if (!config.enabled) throw new Error('expected enabled');
    expect(config.tokens.map((token) => token.symbol)).toEqual(['AUSD']);
  });

  it.each([
    ['not hex', 'nope'],
    ['too short', `0x${'33'.repeat(31)}`],
    ['missing 0x', '33'.repeat(32)],
  ])('rejects a %s key without echoing it', (_label, key) => {
    let message = '';
    try {
      loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: key });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/STARTER_DRIP_PRIVATE_KEY/);
    expect(message).not.toContain(key);
  });

  it.each([
    ['the only gas drip key', { GAS_DRIP_PRIVATE_KEYS: KEY }],
    ['one of several gas drip keys', { GAS_DRIP_PRIVATE_KEYS: `${OTHER}, ${KEY}` }],
    [
      'a gas drip key in another case',
      { GAS_DRIP_PRIVATE_KEYS: KEY.toUpperCase().replace('0X', '0x') },
    ],
    ['the ERC-8004 registrar key', { ERC8004_REGISTRAR_KEY: KEY }],
  ])('refuses a key that is also %s, without echoing it', (_label, env) => {
    let message = '';
    try {
      loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY, ...env });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/collide on nonces/);
    expect(message.toLowerCase()).not.toContain(KEY.slice(2));
  });

  it('accepts a key distinct from the gas drip keys', () => {
    expect(
      loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY, GAS_DRIP_PRIVATE_KEYS: OTHER }).enabled,
    ).toBe(true);
  });

  it.each([
    ['STARTER_DRIP_AUSD', '0'],
    ['STARTER_DRIP_AUSD', '-5'],
    ['STARTER_DRIP_USDC', 'lots'],
    ['STARTER_DRIP_USDC', '1e6'],
    ['STARTER_DRIP_DAILY_CAP_USERS', '0'],
    ['STARTER_DRIP_DAILY_CAP_USERS', '2.5'],
  ])('refuses %s=%s at boot', (name, value) => {
    expect(() => loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY, [name]: value })).toThrow(
      name,
    );
  });
});
