import { generateKeyPairSync } from 'node:crypto';

import { generateAuthorizationKey } from './authorization-key';
import { PrivyClient } from './privy.client';
import { FAKE_APP_ID, FAKE_APP_SECRET, fakePrivy } from './testing/fake-privy';
import { createUserWallet, getUserWallet, isDevicePublicKey } from './user-wallet';

const deviceKey = generateAuthorizationKey();

function setup() {
  const fake = fakePrivy();
  const client = new PrivyClient({
    appId: FAKE_APP_ID,
    appSecret: FAKE_APP_SECRET,
    fetch: fake.fetch,
  });
  return { fake, client };
}

describe('createUserWallet', () => {
  it('owns the wallet with a 1-key quorum holding the device key', async () => {
    const { fake, client } = setup();

    const created = await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: 'sente-user-abc',
    });

    const quorum = fake.calls.find((call) => call.url.endsWith('/v1/key_quorums'));
    expect(quorum?.body).toEqual({
      display_name: 'sente-user-abc device',
      public_keys: [deviceKey.publicKey],
      authorization_threshold: 1,
    });
    expect(created.wallet.owner_id).toBe(created.ownerQuorumId);
  });

  it('attaches no signer and no policy, so no server-held key can spend', async () => {
    const { fake, client } = setup();

    await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: 'sente-user-abc',
    });

    const create = fake.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/wallets'),
    );
    expect(create?.body).toEqual({
      chain_type: 'ethereum',
      owner_id: expect.any(String),
      display_name: 'sente-user-abc',
    });
    // The acceptance criterion, stated as the spec that would catch its
    // regression: no `additional_signers` (a server key that could sign), no
    // `policy_ids`, and not one request carrying an approval — because the
    // server has no key that would satisfy this wallet's owner quorum.
    const body = create?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('additional_signers');
    expect(body).not.toHaveProperty('policy_ids');
    for (const call of fake.calls) {
      expect(call.headers['privy-authorization-signature']).toBeUndefined();
    }
  });

  it('creates the quorum before the wallet, so the wallet is never unowned', async () => {
    const { fake, client } = setup();

    await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: 'sente-user-abc',
    });

    const paths = fake.calls.map((call) => new URL(call.url).pathname);
    expect(paths).toEqual(['/v1/key_quorums', '/v1/wallets']);
  });

  it('truncates a long display name to Privy’s 50 characters', async () => {
    const { fake, client } = setup();

    await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: 'x'.repeat(80),
    });

    const create = fake.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/v1/wallets'),
    );
    expect((create?.body as { display_name: string }).display_name).toHaveLength(50);
  });

  it('reads a wallet back without any approval', async () => {
    const { fake, client } = setup();
    const created = await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: 'sente-user-abc',
    });

    const read = await getUserWallet(client, created.wallet.id);

    expect(read.address).toBe(created.wallet.address);
    expect(fake.calls.at(-1)?.method).toBe('GET');
  });
});

describe('isDevicePublicKey', () => {
  it('accepts the base64 SPKI DER a P-256 key quorum wants', () => {
    expect(isDevicePublicKey(deviceKey.publicKey)).toBe(true);
  });

  it('rejects the PRIVATE half, which is the paste that would leak a key', () => {
    expect(isDevicePublicKey(deviceKey.privateKey)).toBe(false);
  });

  it('rejects a well-formed public key on the wrong curve', () => {
    const { publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    expect(isDevicePublicKey(publicKey.toString('base64'))).toBe(false);
  });

  it('rejects junk', () => {
    expect(isDevicePublicKey('')).toBe(false);
    expect(isDevicePublicKey('not base64 at all !!')).toBe(false);
    expect(isDevicePublicKey(Buffer.from('hello').toString('base64'))).toBe(false);
  });
});
