import { KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { getAddress, type Address } from 'viem';

import { generateAuthorizationKey } from '../agents/privy/authorization-key';
import { PrivyClient } from '../agents/privy/privy.client';
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  fakePrivy,
  type CapturedRequest,
} from '../agents/privy/testing/fake-privy';
import type { Principal } from '../auth/principal';
import {
  ViemTokenBalanceReader,
  type BalanceReadClient,
  type TokenBalanceReader,
} from './balances/token-balances';
import { InMemoryUserWalletRegistry, type UserWalletRegistry } from './store/user-wallet-registry';
import {
  PrivyUserWalletProvider,
  UnconfiguredUserWalletProvider,
  type UserWalletProvider,
} from './user-wallet.provider';
import { UserWalletService } from './user-wallet.service';
import { WalletRefusedError } from './wallet.errors';

const USER: Principal = { userId: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' };
const OTHER: Principal = { userId: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' };

/** The address `fakePrivy` answers with, lowercase — the API must checksum it. */
const WALLET_ADDRESS = getAddress('0x3de96375140717193f52c220df5ec460971cbe84');

const deviceKey = generateAuthorizationKey();
const otherDeviceKey = generateAuthorizationKey();

/**
 * A chain that holds 1.5 MON, 12.5 USDC and 250 AUSD at any address. Three
 * lines because `BalanceReadClient` is the two methods a balance read needs,
 * not a whole viem client.
 */
function balances(overrides: Partial<Record<Address, bigint>> = {}): TokenBalanceReader {
  const client: BalanceReadClient = {
    getBalance: () => Promise.resolve(overrides[NATIVE_TOKEN] ?? 1_500_000_000_000_000_000n),
    readContract: ({ address }) =>
      Promise.resolve(
        overrides[address] ??
          (address === KURU_TESTNET_TOKENS.USDC.address ? 12_500_000n : 250_000_000n),
      ),
  };
  return new ViemTokenBalanceReader(client);
}

function setup(
  options: {
    handle?: Parameters<typeof fakePrivy>[0];
    wallets?: UserWalletProvider;
    registry?: UserWalletRegistry;
    balances?: TokenBalanceReader;
  } = {},
) {
  const fake = fakePrivy(options.handle);
  const wallets =
    options.wallets ??
    new PrivyUserWalletProvider(
      new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: fake.fetch }),
    );
  const registry = options.registry ?? new InMemoryUserWalletRegistry();
  const service = new UserWalletService(wallets, registry, options.balances ?? balances());
  return { fake, service, registry };
}

const refusal = async (run: Promise<unknown>): Promise<WalletRefusedError> => {
  try {
    await run;
  } catch (error) {
    return error as WalletRefusedError;
  }
  throw new Error('expected a refusal');
};

describe('UserWalletService.register', () => {
  it('creates one Privy wallet owned by the device key', async () => {
    const { service, fake } = setup();

    const view = await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    expect(view.address).toBe(WALLET_ADDRESS);
    expect(view.userId).toBe(USER.userId);
    expect(view.walletId).toMatch(/^w\d+$/);
    expect(view.ownerQuorumId).toMatch(/^kq\d+$/);
    expect(view.devicePublicKey).toBe(deviceKey.publicKey);

    const create = fake.calls.find(
      (call: CapturedRequest) => call.method === 'POST' && call.url.endsWith('/v1/wallets'),
    );
    expect(create?.body).toMatchObject({ owner_id: view.ownerQuorumId });
    // Named after the user, short enough for Privy's 50 characters.
    expect((create?.body as { display_name: string }).display_name).toBe(
      `sente-user-${USER.userId.slice(-6)}`,
    );
  });

  it('is idempotent: a second call returns the same wallet and creates nothing', async () => {
    const { service, fake } = setup();

    const first = await service.register(USER, { devicePublicKey: deviceKey.publicKey });
    const walletCalls = fake.calls.length;
    const second = await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    expect(second.walletId).toBe(first.walletId);
    expect(second.address).toBe(first.address);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(fake.calls.slice(walletCalls).filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('collapses concurrent registrations into ONE wallet', async () => {
    const { service, fake } = setup();

    const [a, b, c] = await Promise.all([
      service.register(USER, { devicePublicKey: deviceKey.publicKey }),
      service.register(USER, { devicePublicKey: deviceKey.publicKey }),
      service.register(USER, { devicePublicKey: deviceKey.publicKey }),
    ]);

    expect(b.walletId).toBe(a.walletId);
    expect(c.walletId).toBe(a.walletId);
    const created = fake.calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/wallets'),
    );
    expect(created).toHaveLength(1);
  });

  it('refuses a different device key for a known user', async () => {
    const { service } = setup();
    await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    const error = await refusal(
      service.register(USER, { devicePublicKey: otherDeviceKey.publicKey }),
    );

    expect(error.reason).toBe('device_key_mismatch');
  });

  it('refuses a key that is not a P-256 public key, before calling Privy', async () => {
    const { service, fake } = setup();

    const error = await refusal(service.register(USER, { devicePublicKey: deviceKey.privateKey }));

    expect(error.reason).toBe('invalid_device_key');
    expect(fake.calls).toEqual([]);
  });

  it('gives each user their own wallet', async () => {
    const { service } = setup();

    const mine = await service.register(USER, { devicePublicKey: deviceKey.publicKey });
    const theirs = await service.register(OTHER, { devicePublicKey: otherDeviceKey.publicKey });

    expect(theirs.walletId).not.toBe(mine.walletId);
  });

  it('never attaches an approval, because the server holds no key for this wallet', async () => {
    const { service, fake } = setup();

    await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    for (const call of fake.calls) {
      expect(call.headers['privy-authorization-signature']).toBeUndefined();
    }
    const create = fake.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/wallets'),
    );
    expect(create?.body).not.toHaveProperty('additional_signers');
    expect(create?.body).not.toHaveProperty('policy_ids');
  });

  it('refuses cleanly when Privy is not configured', async () => {
    const { service } = setup({ wallets: new UnconfiguredUserWalletProvider() });

    const error = await refusal(service.register(USER, { devicePublicKey: deviceKey.publicKey }));

    expect(error.reason).toBe('user_wallets_unconfigured');
  });

  it('turns a Privy failure into a refusal rather than a 500', async () => {
    const { service } = setup({
      handle: (request) =>
        request.url.endsWith('/v1/wallets') && request.method === 'POST'
          ? { status: 500, body: { error: 'Privy is having a day', code: 'internal' } }
          : undefined,
    });

    const error = await refusal(service.register(USER, { devicePublicKey: deviceKey.publicKey }));

    expect(error.reason).toBe('user_wallet_provider_failed');
    expect(error.message).toContain('Privy is having a day');
  });

  it('does not bind anything when Privy refuses, so a retry still works', async () => {
    let fail = true;
    const { service } = setup({
      handle: (request) =>
        fail && request.method === 'POST' && request.url.endsWith('/v1/wallets')
          ? { status: 503, body: { error: 'nope' } }
          : undefined,
    });
    await refusal(service.register(USER, { devicePublicKey: deviceKey.publicKey }));

    fail = false;
    const view = await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    expect(view.address).toBe(WALLET_ADDRESS);
  });
});

describe('UserWalletService.account', () => {
  it('404s until the wallet is registered', async () => {
    const { service } = setup();

    const error = await refusal(service.account(USER));

    expect(error.reason).toBe('account_not_registered');
  });

  it('returns MON, USDC and AUSD as decimal strings, in that order', async () => {
    const { service } = setup();
    await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    const view = await service.account(USER);

    expect(view.address).toBe(WALLET_ADDRESS);
    expect(view.chainId).toBe(10143);
    expect(view.balances).toEqual([
      {
        symbol: 'MON',
        address: NATIVE_TOKEN,
        decimals: 18,
        raw: 1_500_000_000_000_000_000n,
        amount: '1.5',
      },
      {
        symbol: 'USDC',
        address: KURU_TESTNET_TOKENS.USDC.address,
        decimals: 6,
        raw: 12_500_000n,
        amount: '12.5',
      },
      {
        symbol: 'AUSD',
        // Agora's AUSD, Perpl's collateral — NOT Kuru's USDC, and 6 decimals.
        address: PERPL_TESTNET_CONTRACTS.collateral,
        decimals: 6,
        raw: 250_000_000n,
        amount: '250',
      },
    ]);
  });

  it('reads the balances of the registered address, not of the caller', async () => {
    const seen: Address[] = [];
    const reader: TokenBalanceReader = {
      balances: (address) => {
        seen.push(address);
        return Promise.resolve([]);
      },
    };
    const { service } = setup({ balances: reader });
    await service.register(USER, { devicePublicKey: deviceKey.publicKey });

    await service.account(USER);

    expect(new Set(seen)).toEqual(new Set([WALLET_ADDRESS]));
  });
});
