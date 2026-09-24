import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAddress } from 'viem';

import { FileUserWalletRegistry } from './file-user-wallet-registry';
import {
  InMemoryUserWalletRegistry,
  type UserWalletBinding,
  type UserWalletRegistry,
} from './user-wallet-registry';

const DEVICE_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(52) + '==';
const OTHER_DEVICE_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'B'.repeat(52) + '==';

function binding(patch: Partial<Omit<UserWalletBinding, 'createdAt'>> = {}) {
  return {
    userId: 'alice',
    walletId: 'wallet00000000000000test',
    address: getAddress(`0x${'9'.repeat(40)}`),
    ownerQuorumId: 'quorum00000000000000test',
    devicePublicKey: DEVICE_KEY,
    ...patch,
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-registry-'));
  path = join(dir, 'user-wallets.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The two implementations must answer identically — the file-backed one is only
 * ever chosen by `STATE_DIR`, and a difference in what it refuses would show up
 * as a second Privy wallet in production and never in a spec.
 */
describe.each([
  ['InMemoryUserWalletRegistry', (): UserWalletRegistry => new InMemoryUserWalletRegistry()],
  ['FileUserWalletRegistry', (): UserWalletRegistry => new FileUserWalletRegistry(path)],
])('%s', (_name, create) => {
  it('has nothing for an unknown user', async () => {
    await expect(create().find('nobody')).resolves.toBeUndefined();
  });

  it('binds once and answers the same binding afterwards', async () => {
    const registry = create();
    const first = await registry.bind(binding());
    expect(first.ok && first.created).toBe(true);

    const again = await registry.bind(binding());
    expect(again.ok && again.created).toBe(false);
    expect(await registry.find('alice')).toEqual(first.ok ? first.binding : undefined);
  });

  it('refuses a different device key rather than minting a second wallet', async () => {
    const registry = create();
    await registry.bind(binding());

    const result = await registry.bind(
      binding({ walletId: 'other-wallet', devicePublicKey: OTHER_DEVICE_KEY }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.existing.walletId).toBe('wallet00000000000000test');
  });

  it('keeps one binding per user', async () => {
    const registry = create();
    await registry.bind(binding());
    await registry.bind(binding({ userId: 'bob', walletId: 'w2' }));

    expect((await registry.find('bob'))?.walletId).toBe('w2');
    expect((await registry.find('alice'))?.walletId).toBe('wallet00000000000000test');
  });
});

describe('FileUserWalletRegistry persistence', () => {
  it('serves the same wallet after a restart — the SEN-48 acceptance criterion', async () => {
    const before = new FileUserWalletRegistry(path);
    const bound = await before.bind(binding());

    const after = new FileUserWalletRegistry(path);
    expect(after.size).toBe(1);
    expect(await after.find('alice')).toEqual(bound.ok ? bound.binding : undefined);
    expect((await after.find('alice'))?.createdAt).toBeInstanceOf(Date);
  });

  it('still refuses a different device key after a restart', async () => {
    await new FileUserWalletRegistry(path).bind(binding());

    const after = new FileUserWalletRegistry(path);
    const result = await after.bind(binding({ devicePublicKey: OTHER_DEVICE_KEY }));
    expect(result.ok).toBe(false);
  });

  it('writes through on the bind itself, not at shutdown', async () => {
    const registry = new FileUserWalletRegistry(path);
    await registry.bind(binding());
    // Nothing has closed, flushed or exited: a `kill -9` right here must not
    // lose the wallet that has just been created at Privy.
    expect(new FileUserWalletRegistry(path).size).toBe(1);
  });

  it('does not keep a binding it could not persist', async () => {
    // A regular file where the state directory should be: the save cannot even
    // create the directory.
    writeFileSync(join(dir, 'blocked'), '');
    const registry = new FileUserWalletRegistry(join(dir, 'blocked', 'user-wallets.json'));

    await expect(registry.bind(binding())).rejects.toThrow();
    // In memory and absent from disk is the one state that must not exist: it
    // would serve one wallet until the restart and a different one after.
    expect(await registry.find('alice')).toBeUndefined();
  });
});
