import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, erc20Abi, type Address, type Hash, type Hex } from 'viem';

import { loadStarterKitConfig, type StarterKitConfig } from './starter-kit.config';
import {
  StarterKitService,
  type StarterKitChain,
  type StarterKitSender,
} from './starter-kit.service';
import { StarterKitStore } from './starter-kit.store';

const KEY = `0x${'33'.repeat(32)}`;
const SENDER = '0x00000000000000000000000000000000000057a7' as Address;
const ALICE = '0x000000000000000000000000000000000000a11c' as Address;
const BOB = '0x0000000000000000000000000000000000000b0b' as Address;

interface Sent {
  token: Address;
  to: Address;
  amount: bigint;
  gas: bigint;
}

/** A sender that records what it would broadcast and answers sequential hashes. */
function recordingSender(options: { throwOn?: number } = {}) {
  const sent: Sent[] = [];
  const sender: StarterKitSender = {
    address: SENDER,
    send: (token: Address, value: bigint, gas: bigint, data: Hex) => {
      expect(value).toBe(0n);
      if (options.throwOn === sent.length) return Promise.reject(new Error('rpc down'));
      const { args } = decodeFunctionData({ abi: erc20Abi, data });
      const [to, amount] = args as readonly [Address, bigint];
      sent.push({ token, to, amount, gas });
      return Promise.resolve({ hash: `0x${String(sent.length).padStart(64, '0')}` as Hash });
    },
  };
  return { sender, sent };
}

function chain(
  options: { balance?: bigint; receipt?: (hash: Hash) => Promise<'success' | 'reverted'> } = {},
): StarterKitChain {
  return {
    balanceOf: () => Promise.resolve(options.balance ?? 10_000_000_000n),
    waitForReceipt: (hash) =>
      options.receipt ? options.receipt(hash) : Promise.resolve('success'),
  };
}

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

function setup(
  options: {
    config?: StarterKitConfig;
    store?: StarterKitStore;
    sender?: ReturnType<typeof recordingSender>;
    chain?: StarterKitChain;
    now?: () => Date;
  } = {},
) {
  const config =
    options.config ??
    loadStarterKitConfig({ STARTER_DRIP_PRIVATE_KEY: KEY, STARTER_DRIP_DAILY_CAP_USERS: '2' });
  const store = options.store ?? new StarterKitStore();
  const recording = options.sender ?? recordingSender();
  const service = new StarterKitService({
    config,
    store,
    sender: recording.sender,
    chain: options.chain ?? chain(),
    log: silent,
    now: options.now,
  });
  return { service, store, sent: recording.sent };
}

describe('StarterKitService.grant', () => {
  it('sends 250 AUSD then 100 USDC, with their measured gas limits, and reports sent', async () => {
    const { service, sent } = setup();

    await service.grant('alice', ALICE);

    expect(sent).toEqual([
      expect.objectContaining({ to: ALICE, amount: 250_000_000n, gas: 82_000n }),
      expect.objectContaining({ to: ALICE, amount: 100_000_000n, gas: 72_000n }),
    ]);
    expect(service.status('alice')).toEqual({
      status: 'sent',
      ausdTx: `0x${'1'.padStart(64, '0')}`,
      usdcTx: `0x${'2'.padStart(64, '0')}`,
    });
  });

  it('is pending while the transfers are in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service } = setup({
      chain: chain({ receipt: async () => (await gate, 'success') }),
    });

    const running = service.grant('alice', ALICE);
    await Promise.resolve();
    expect(service.status('alice').status).toBe('pending');

    release();
    await running;
    expect(service.status('alice').status).toBe('sent');
  });

  it('sends once per user, however often they register', async () => {
    const { service, sent } = setup();

    await service.grant('alice', ALICE);
    await service.grant('alice', ALICE);

    expect(sent).toHaveLength(2);
  });

  it('sends once when two registers race', async () => {
    const { service, sent } = setup();

    await Promise.all([service.grant('alice', ALICE), service.grant('alice', ALICE)]);

    expect(sent).toHaveLength(2);
    expect(service.status('alice').status).toBe('sent');
  });

  it('stops at the daily cap of users, and resets at 00:00 UTC', async () => {
    let now = new Date('2026-10-09T10:00:00Z');
    const { service, sent } = setup({ now: () => now });

    await service.grant('alice', ALICE);
    await service.grant('bob', BOB);
    await service.grant('carol', ALICE);

    expect(sent).toHaveLength(4);
    expect(service.status('carol')).toEqual({ status: 'none' });

    now = new Date('2026-10-10T00:00:01Z');
    await service.grant('carol', ALICE);
    expect(service.status('carol').status).toBe('sent');
  });

  it('counts a failed kit against the cap', async () => {
    const { service } = setup({ sender: recordingSender({ throwOn: 0 }) });

    await service.grant('alice', ALICE);
    await service.grant('bob', BOB);
    await service.grant('carol', ALICE);

    expect(service.status('carol').status).toBe('none');
  });

  it('is disabled, and sends nothing, without a key', async () => {
    const { service, sent } = setup({ config: { enabled: false } });

    await service.grant('alice', ALICE);

    expect(sent).toEqual([]);
    expect(service.status('alice')).toEqual({ status: 'disabled' });
  });

  it('says none for a user it never saw', () => {
    expect(setup().service.status('nobody')).toEqual({ status: 'none' });
  });

  it('fails without sending anything when the starter wallet is short', async () => {
    const { service, sent, store } = setup({ chain: chain({ balance: 5n }) });

    await service.grant('alice', ALICE);

    expect(sent).toEqual([]);
    expect(service.status('alice')).toEqual({ status: 'failed' });
    expect(store.find('alice')?.reason).toMatch(/nothing was sent/);
  });

  it('fails, and does not send USDC, when the AUSD transfer reverts', async () => {
    const { service, sent } = setup({
      chain: chain({ receipt: () => Promise.resolve('reverted') }),
    });

    await service.grant('alice', ALICE);

    expect(sent).toHaveLength(1);
    expect(service.status('alice')).toEqual({
      status: 'failed',
      ausdTx: `0x${'1'.padStart(64, '0')}`,
    });
  });

  it('fails without retrying when a receipt never comes', async () => {
    const { service, sent, store } = setup({
      chain: chain({ receipt: () => Promise.reject(new Error('timed out')) }),
    });

    await service.grant('alice', ALICE);
    await service.grant('alice', ALICE);

    expect(sent).toHaveLength(1);
    expect(store.find('alice')?.reason).toMatch(/unconfirmed: timed out/);
  });

  it('records a broadcast failure as failed and never rejects', async () => {
    const { service } = setup({ sender: recordingSender({ throwOn: 1 }) });

    await expect(service.grant('alice', ALICE)).resolves.toBeUndefined();
    expect(service.status('alice').status).toBe('failed');
  });
});

describe('StarterKitStore on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starter-kit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('remembers a sent kit across a restart, so nobody is paid twice', async () => {
    const path = join(dir, 'starter-kits.json');
    await setup({ store: new StarterKitStore(path) }).service.grant('alice', ALICE);

    const { service, sent } = setup({ store: new StarterKitStore(path) });
    await service.grant('alice', ALICE);

    expect(sent).toEqual([]);
    expect(service.status('alice').status).toBe('sent');
  });

  it('loads a kit a restart interrupted as failed, and does not resend it', async () => {
    const path = join(dir, 'starter-kits.json');
    new StarterKitStore(path).claim('alice', ALICE, 50, new Date());

    const store = new StarterKitStore(path);
    const { service, sent } = setup({ store });
    await service.grant('alice', ALICE);

    expect(sent).toEqual([]);
    expect(store.find('alice')).toMatchObject({ status: 'failed', reason: /restart/ });
    expect(new StarterKitStore(path).find('alice')?.status).toBe('failed');
  });
});
