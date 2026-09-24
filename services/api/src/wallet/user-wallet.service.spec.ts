import { KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hash } from 'viem';

import {
  generateAuthorizationKey,
  signAuthorizationPayload,
} from '../agents/privy/authorization-key';
import { PrivyClient } from '../agents/privy/privy.client';
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  fakePrivy,
  requestSignedByAny,
  type CapturedRequest,
} from '../agents/privy/testing/fake-privy';
import { testAgent } from '../agents/tools/testing/agent-fixture';
import type { AgentRecord } from '../agents/store/agent-store';
import type { Principal } from '../auth/principal';
import {
  ViemTokenBalanceReader,
  type BalanceReadClient,
  type TokenBalanceReader,
} from './balances/token-balances';
import type { OperationTracker, TrackedOperation } from './confirmation/operation-tracker';
import { WriteSpacer } from '../spacing/write-spacer';
import { InMemoryUserWalletRegistry, type UserWalletRegistry } from './store/user-wallet-registry';
import {
  PrivyUserWalletProvider,
  UnconfiguredUserWalletProvider,
  type UserWalletProvider,
} from './user-wallet.provider';
import {
  UserWalletService,
  type SendCommand,
  type SendRecipientAgents,
} from './user-wallet.service';
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

/** The agents the send allowlist can see. Two lines, one lookup. */
function agentDirectory(agents: readonly AgentRecord[] = []): SendRecipientAgents {
  return {
    findByAddress: (address) =>
      Promise.resolve(
        agents.find((agent) => agent.address.toLowerCase() === address.toLowerCase()),
      ),
  };
}

/** Records what was tracked, so a spec can check WHICH hash is being followed. */
function recordingTracker() {
  const tracked: Pick<TrackedOperation, 'userOpHash' | 'sender' | 'sponsored'>[] = [];
  const tracker: OperationTracker = {
    track: (operation) => void tracked.push(operation),
    status: (userOpHash: Hash) =>
      tracked.some((operation) => operation.userOpHash === userOpHash)
        ? ({ userOpHash, status: 'pending' } as TrackedOperation)
        : undefined,
  };
  return { tracker, tracked };
}

function setup(
  options: {
    handle?: Parameters<typeof fakePrivy>[0];
    wallets?: UserWalletProvider;
    registry?: UserWalletRegistry;
    balances?: TokenBalanceReader;
    agents?: readonly AgentRecord[];
    spacingMs?: number;
  } = {},
) {
  const fake = fakePrivy(options.handle);
  const wallets =
    options.wallets ??
    new PrivyUserWalletProvider(
      new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: fake.fetch }),
    );
  const registry = options.registry ?? new InMemoryUserWalletRegistry();
  const { tracker, tracked } = recordingTracker();
  // Nothing sleeps in real time; `slept` is how a spec sees the spacing.
  const slept: number[] = [];
  let clock = 100_000;
  const spacer = new WriteSpacer({
    spacingMs: options.spacingMs ?? 4_000,
    sleep: (ms: number) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });
  const service = new UserWalletService(
    wallets,
    registry,
    options.balances ?? balances(),
    agentDirectory(options.agents),
    tracker,
    spacer,
  );
  return { fake, service, registry, tracked, slept };
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

// ---------------------------------------------------------------------------
// SEN-42: prepare -> sign on the phone -> execute
// ---------------------------------------------------------------------------

/** One of USER's agents, at a known address. */
const MY_AGENT = testAgent({ userId: USER.userId, address: getAddress(`0x${'a1'.repeat(20)}`) });
/** Somebody else's agent. Funding it from this account must be refused. */
const THEIR_AGENT = testAgent({
  id: '33333333-3333-4333-8333-333333333333',
  userId: OTHER.userId,
  address: getAddress(`0x${'b2'.repeat(20)}`),
});

const USDC = KURU_TESTNET_TOKENS.USDC;

const sendCommand = (over: Partial<SendCommand> = {}): SendCommand => ({
  to: MY_AGENT.address,
  token: USDC.address,
  amount: '2500000',
  ...over,
});

/** Registers USER's wallet and returns the service with its agents visible. */
async function registered(options: Parameters<typeof setup>[0] = {}) {
  const context = setup({ agents: [MY_AGENT, THEIR_AGENT], ...options });
  const wallet = await context.service.register(USER, { devicePublicKey: deviceKey.publicKey });
  return { ...context, wallet };
}

/** What the phone does: sign the payload it was handed with the device key. */
const signOnDevice = (payload: Parameters<typeof signAuthorizationPayload>[1]) =>
  signAuthorizationPayload(deviceKey.privateKey, payload);

const rpcCalls = (calls: readonly CapturedRequest[]) =>
  calls.filter((call) => call.url.endsWith('/rpc'));

describe('UserWalletService.prepareSend', () => {
  it('composes the exact sponsored send, and sends NOTHING', async () => {
    const { service, fake, wallet } = await registered();
    const before = fake.calls.length;

    const prepared = await service.prepareSend(USER, sendCommand());

    expect(prepared.payload).toEqual({
      version: 1,
      method: 'POST',
      url: `https://api.privy.io/v1/wallets/${wallet.walletId}/rpc`,
      headers: { 'privy-app-id': FAKE_APP_ID },
      body: {
        method: 'eth_sendTransaction',
        caip2: 'eip155:10143',
        sponsor: true,
        params: {
          transaction: {
            to: getAddress(USDC.address),
            data: expect.stringMatching(/^0xa9059cbb/) as unknown as string,
            chain_id: 10143,
          },
        },
      },
    });
    // A prepare that reached Privy would be a transfer without an approval.
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it('encodes the transfer the caller asked for, to the agent, not to the token', async () => {
    const { service } = await registered();

    const prepared = await service.prepareSend(USER, sendCommand());

    const body = prepared.payload.body as {
      params: { transaction: { data: `0x${string}` } };
    };
    const decoded = decodeFunctionData({ abi: erc20Abi, data: body.params.transaction.data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([MY_AGENT.address, 2_500_000n]);
  });

  it('summarises it in the caller’s terms, naming the agent it funds', async () => {
    const { service, wallet } = await registered();

    const prepared = await service.prepareSend(USER, sendCommand());

    expect(prepared.summary).toEqual({
      from: wallet.address,
      to: MY_AGENT.address,
      recipient: { kind: 'agent', agentId: MY_AGENT.id, agentName: MY_AGENT.name },
      symbol: 'USDC',
      tokenAddress: getAddress(USDC.address),
      decimals: 6,
      atoms: '2500000',
      amount: '2.5',
      chainId: 10143,
      sponsored: true,
    });
    expect(prepared.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('allows a send to the caller’s own wallet', async () => {
    const { service, wallet } = await registered();

    const prepared = await service.prepareSend(USER, sendCommand({ to: wallet.address }));

    expect(prepared.summary.recipient).toEqual({ kind: 'self' });
  });

  it('sends native MON as a value, with no calldata', async () => {
    const { service } = await registered();

    const prepared = await service.prepareSend(
      USER,
      sendCommand({ token: NATIVE_TOKEN, amount: '100000000000000000' }),
    );

    expect(
      (prepared.payload.body as { params: { transaction: unknown } }).params.transaction,
    ).toEqual({ to: MY_AGENT.address, value: '0x16345785d8a0000', chain_id: 10143 });
    expect(prepared.summary.amount).toBe('0.1');
  });

  it('refuses an address that is neither the caller’s wallet nor their agent', async () => {
    const { service, fake } = await registered();
    const before = fake.calls.length;

    const error = await refusal(
      service.prepareSend(USER, sendCommand({ to: getAddress(`0x${'c3'.repeat(20)}`) })),
    );

    expect(error.reason).toBe('send_recipient_not_allowed');
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it('refuses ANOTHER user’s agent, so a guessed address funds nobody', async () => {
    const { service } = await registered();

    const error = await refusal(
      service.prepareSend(USER, sendCommand({ to: THEIR_AGENT.address })),
    );

    expect(error.reason).toBe('send_recipient_not_allowed');
    // The refusal does not confirm that the address is an agent at all.
    expect(error.message).not.toContain(THEIR_AGENT.name);
  });

  it('refuses a token the wallet cannot send', async () => {
    const { service } = await registered();

    const error = await refusal(
      service.prepareSend(USER, sendCommand({ token: getAddress(`0x${'d4'.repeat(20)}`) })),
    );

    expect(error.reason).toBe('send_token_not_supported');
  });

  it.each([['0'], ['-1'], ['1.5'], ['1e6'], [''], ['abc']])(
    'refuses %s as an amount of atoms',
    async (amount) => {
      const { service } = await registered();

      const error = await refusal(service.prepareSend(USER, sendCommand({ amount })));

      expect(error.reason).toBe('send_amount_invalid');
    },
  );

  it('refuses before the wallet exists', async () => {
    const { service } = setup({ agents: [MY_AGENT] });

    const error = await refusal(service.prepareSend(USER, sendCommand()));

    expect(error.reason).toBe('account_not_registered');
  });
});

describe('UserWalletService.executeSend', () => {
  it('forwards the phone’s signature verbatim, and attaches no other approval', async () => {
    const { service, fake, wallet } = await registered();
    const prepared = await service.prepareSend(USER, sendCommand());
    const signature = signOnDevice(prepared.payload);

    await service.executeSend(USER, { prepareId: prepared.prepareId, signature });

    const sent = rpcCalls(fake.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://api.privy.io/v1/wallets/${wallet.walletId}/rpc`);
    // Exactly one signature, and it is the phone's — a server key on this
    // request would be a server that can spend the user's funds.
    expect(sent[0]?.headers['privy-authorization-signature']).toBe(signature);
    // And it verifies over what was ACTUALLY sent: the approved bytes and the
    // sent bytes are the same bytes, which is the whole property.
    expect(requestSignedByAny(sent[0]!, [deviceKey.publicKey])).toBe(true);
  });

  it('follows the USER OPERATION hash, not the empty transaction hash', async () => {
    const { service, tracked, wallet } = await registered();
    const prepared = await service.prepareSend(USER, sendCommand());

    const sent = await service.executeSend(USER, {
      prepareId: prepared.prepareId,
      signature: signOnDevice(prepared.payload),
    });

    expect(sent.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).not.toHaveProperty('summary');
    expect(sent.transactionHash).toBeUndefined();
    expect(sent.transactionId).toBeDefined();
    expect(sent.status).toBe('pending');
    expect(sent.sponsored).toBe(true);
    // Gotcha 8: the thing being tracked is the operation, and the tracker reads
    // its own success flag rather than the carrying transaction's status.
    expect(tracked).toEqual([
      { userOpHash: sent.userOpHash, sender: wallet.address, sponsored: true },
    ]);
  });

  it('is single-use: the same signature cannot be committed twice', async () => {
    const { service, fake } = await registered();
    const prepared = await service.prepareSend(USER, sendCommand());
    const signature = signOnDevice(prepared.payload);
    await service.executeSend(USER, { prepareId: prepared.prepareId, signature });

    const error = await refusal(
      service.executeSend(USER, { prepareId: prepared.prepareId, signature }),
    );

    expect(error.reason).toBe('send_prepare_not_found');
    expect(rpcCalls(fake.calls)).toHaveLength(1);
  });

  it('is not another user’s to spend', async () => {
    const { service } = await registered();
    await service.register(OTHER, { devicePublicKey: otherDeviceKey.publicKey });
    const prepared = await service.prepareSend(USER, sendCommand());

    const error = await refusal(
      service.executeSend(OTHER, {
        prepareId: prepared.prepareId,
        signature: signOnDevice(prepared.payload),
      }),
    );

    expect(error.reason).toBe('send_prepare_not_found');
    // And USER's prepare survives a stranger's guess.
    await expect(
      service.executeSend(USER, {
        prepareId: prepared.prepareId,
        signature: signOnDevice(prepared.payload),
      }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('expires: an approval given five minutes ago is not consent now', async () => {
    jest.useFakeTimers();
    try {
      const { service } = await registered();
      const prepared = await service.prepareSend(USER, sendCommand());
      const signature = signOnDevice(prepared.payload);
      jest.setSystemTime(prepared.expiresAt.getTime() + 1);

      const error = await refusal(
        service.executeSend(USER, { prepareId: prepared.prepareId, signature }),
      );

      expect(error.reason).toBe('send_prepare_not_found');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses an unknown prepare id without touching Privy', async () => {
    const { service, fake } = await registered();
    const before = fake.calls.length;

    const error = await refusal(
      service.executeSend(USER, { prepareId: 'made-up', signature: 'AAAA' }),
    );

    expect(error.reason).toBe('send_prepare_not_found');
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it('spaces a second send from the same wallet rather than letting it fail', async () => {
    const { service, slept } = await registered();
    const first = await service.prepareSend(USER, sendCommand());
    await service.executeSend(USER, {
      prepareId: first.prepareId,
      signature: signOnDevice(first.payload),
    });
    const second = await service.prepareSend(USER, sendCommand());

    await service.executeSend(USER, {
      prepareId: second.prepareId,
      signature: signOnDevice(second.payload),
    });

    // Measured live: back to back, the second send is refused by the chain.
    expect(slept).toEqual([4_000]);
  });

  it('reports a signature Privy rejects as an authorization problem', async () => {
    const { service } = await registered({
      handle: (request) =>
        request.url.endsWith('/rpc')
          ? {
              status: 401,
              body: {
                error: 'No valid authorization signatures were provided.',
                code: 'invalid_data',
              },
            }
          : undefined,
    });
    const prepared = await service.prepareSend(USER, sendCommand());

    const error = await refusal(
      service.executeSend(USER, {
        prepareId: prepared.prepareId,
        signature: signOnDevice(prepared.payload),
      }),
    );

    expect(error.reason).toBe('invalid_authorization');
  });

  it('reports a chain refusal as a broadcast failure, and moves nothing', async () => {
    const { service, tracked } = await registered({
      handle: (request) =>
        request.url.endsWith('/rpc')
          ? {
              status: 400,
              body: {
                error: 'Execution reverted for an unknown reason.',
                code: 'transaction_broadcast_failure',
              },
            }
          : undefined,
    });
    const prepared = await service.prepareSend(USER, sendCommand());

    const error = await refusal(
      service.executeSend(USER, {
        prepareId: prepared.prepareId,
        signature: signOnDevice(prepared.payload),
      }),
    );

    expect(error.reason).toBe('send_broadcast_failed');
    expect(tracked).toEqual([]);
  });

  it('says `unknown` rather than `pending` when nothing followable came back', async () => {
    const { service, tracked } = await registered({
      handle: (request) =>
        request.url.endsWith('/rpc')
          ? { status: 200, body: { method: 'eth_sendTransaction', data: { hash: '' } } }
          : undefined,
    });
    const prepared = await service.prepareSend(USER, sendCommand());

    const sent = await service.executeSend(USER, {
      prepareId: prepared.prepareId,
      signature: signOnDevice(prepared.payload),
    });

    expect(sent.status).toBe('unknown');
    expect(sent.sponsored).toBe(false);
    expect(tracked).toEqual([]);
  });

  it('refuses cleanly when Privy is not configured', async () => {
    const registry = new InMemoryUserWalletRegistry();
    const bound = await registry.bind({
      userId: USER.userId,
      walletId: 'w-unconfigured',
      address: WALLET_ADDRESS,
      ownerQuorumId: 'kq-1',
      devicePublicKey: deviceKey.publicKey,
    });
    expect(bound.ok).toBe(true);
    const { service } = setup({
      wallets: new UnconfiguredUserWalletProvider(),
      registry,
      agents: [MY_AGENT],
    });

    const error = await refusal(service.prepareSend(USER, sendCommand()));

    expect(error.reason).toBe('user_wallets_unconfigured');
  });
});
