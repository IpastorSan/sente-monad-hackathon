// The Privy client, offline. Ported from turnstile `buyer/org/org.test.ts`
// (client, keys and quorum sections).
//
// What these check is the part a live run cannot: that the request we sign is
// the request we send. A signature over a different URL, a body with a key we
// dropped, or a header we forgot is a 401 that looks like a credentials
// problem and is not. Every one is asserted here against a fake `fetch`.

import { createPublicKey, verify as ecdsaVerify } from 'node:crypto';

import { canonicalize } from '@sente/mandate';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { privyTransaction, signTransaction, toPrivyTypedData } from './agent-wallet';
import {
  generateAuthorizationKey,
  loadAuthorizationKey,
  signAuthorizationPayload,
} from './authorization-key';
import { createKeyQuorum } from './key-quorum';
import { PrivyClient, PrivyError } from './privy.client';
import { FAKE_APP_ID, FAKE_APP_SECRET, fakePrivy, signatureVerifies } from './testing/fake-privy';

function client(handle?: Parameters<typeof fakePrivy>[0]) {
  const fake = fakePrivy(handle);
  return {
    ...fake,
    client: new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: fake.fetch }),
  };
}

describe('authorization keys', () => {
  it('a generated key signs something its own public half verifies', () => {
    const key = generateAuthorizationKey();
    const payload = {
      version: 1,
      method: 'POST',
      url: 'https://api.privy.io/v1/policies',
      body: { a: 1 },
      headers: {},
    } as const;
    const signature = signAuthorizationPayload(key.privateKey, payload);
    expect(signatureVerifies(key.publicKey, payload, signature)).toBe(true);
  });

  it('a signature does not verify against a different body — this is what stops replay', () => {
    const key = generateAuthorizationKey();
    const url = 'https://api.privy.io/v1/policies/abc';
    const signature = signAuthorizationPayload(key.privateKey, {
      version: 1,
      method: 'PATCH',
      url,
      body: { cap: 250000 },
      headers: {},
    });
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const tampered = canonicalize({
      version: 1,
      method: 'PATCH',
      url,
      body: { cap: 25_000_000 },
      headers: {},
    });
    expect(
      ecdsaVerify(
        'sha256',
        Buffer.from(tampered, 'utf8'),
        publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
  });

  it("loadAuthorizationKey strips Privy's wallet-auth: prefix and re-derives the public half", () => {
    const generated = generateAuthorizationKey();
    const reloaded = loadAuthorizationKey(`wallet-auth:${generated.privateKey}`);
    expect(reloaded).toEqual(generated);
  });
});

describe('PrivyClient', () => {
  it('every request carries basic auth and the privy-app-id header', async () => {
    const { client: privy, calls } = client();
    await privy.get('/v1/wallets/w1');
    expect(calls[0]!.headers['privy-app-id']).toBe(FAKE_APP_ID);
    expect(calls[0]!.headers['authorization']).toBe(
      `Basic ${Buffer.from(`${FAKE_APP_ID}:${FAKE_APP_SECRET}`).toString('base64')}`,
    );
  });

  it('an unapproved mutation carries no signature header at all', async () => {
    const { client: privy, calls } = client();
    await privy.post('/v1/wallets', { chain_type: 'ethereum' });
    expect(calls[0]!.headers['privy-authorization-signature']).toBeUndefined();
  });

  it('two approvals become one comma-separated header, and both verify over the sent body', async () => {
    const alice = generateAuthorizationKey();
    const bob = generateAuthorizationKey();
    const { client: privy, calls } = client();

    const body = { name: 'raised', rules: [{ cap: 1 }] };
    await privy.patch('/v1/policies/pol-1', body, { approvals: [alice, bob] });

    const call = calls[0]!;
    const signatures = call.headers['privy-authorization-signature']!.split(',');
    expect(signatures).toHaveLength(2);

    // The payload Privy reconstructs on its side: the URL it was sent to, the
    // body verbatim, and only the privy- prefixed headers.
    const payload = {
      version: 1,
      method: 'PATCH',
      url: 'https://api.privy.io/v1/policies/pol-1',
      body,
      headers: { 'privy-app-id': FAKE_APP_ID },
    } as const;
    expect(signatureVerifies(alice.publicKey, payload, signatures[0]!)).toBe(true);
    expect(signatureVerifies(bob.publicKey, payload, signatures[1]!)).toBe(true);
    // The signed body and the sent body must be the same object.
    expect(call.rawBody).toBe(JSON.stringify(body));
  });

  it('the idempotency key is signed as well as sent — otherwise it could be swapped in flight', async () => {
    const alice = generateAuthorizationKey();
    const { client: privy, calls } = client();
    await privy.post(
      '/v1/policies',
      { name: 'p' },
      { approvals: [alice], idempotencyKey: 'idem-1' },
    );

    const call = calls[0]!;
    expect(call.headers['privy-idempotency-key']).toBe('idem-1');
    const payload = {
      version: 1,
      method: 'POST',
      url: 'https://api.privy.io/v1/policies',
      body: { name: 'p' },
      headers: { 'privy-app-id': FAKE_APP_ID, 'privy-idempotency-key': 'idem-1' },
    } as const;
    expect(
      signatureVerifies(alice.publicKey, payload, call.headers['privy-authorization-signature']!),
    ).toBe(true);
  });

  it('a precomputed signature is sent as it stands, over the payload the client publishes', async () => {
    // What the phone does in SEN-44, with node standing in for the device key:
    // ask for the payload, sign it elsewhere, hand back the signature.
    const phone = generateAuthorizationKey();
    const { client: privy, calls } = client();
    const body = { rules: [] };

    const payload = privy.authorizationPayload('PATCH', '/v1/policies/pol-1', body);
    expect(payload).toEqual({
      version: 1,
      method: 'PATCH',
      url: 'https://api.privy.io/v1/policies/pol-1',
      body,
      headers: { 'privy-app-id': FAKE_APP_ID },
    });

    const signature = signAuthorizationPayload(phone.privateKey, payload);
    await privy.patch('/v1/policies/pol-1', body, { signatures: [signature] });

    const call = calls[0]!;
    expect(call.headers['privy-authorization-signature']).toBe(signature);
    // The signature verifies against the request as SENT, which is the only
    // claim that matters: the payload was not a description of it, it was it.
    expect(signatureVerifies(phone.publicKey, payload, signature)).toBe(true);
    expect(call.rawBody).toBe(JSON.stringify(body));
  });

  it('a server key and a phone signature can approve the same request together', async () => {
    const server = generateAuthorizationKey();
    const phone = generateAuthorizationKey();
    const { client: privy, calls } = client();

    const payload = privy.authorizationPayload('POST', '/v1/wallets/w1/rpc', { m: 1 });
    await privy.post(
      '/v1/wallets/w1/rpc',
      { m: 1 },
      { approvals: [server], signatures: [signAuthorizationPayload(phone.privateKey, payload)] },
    );

    const signatures = calls[0]!.headers['privy-authorization-signature']!.split(',');
    expect(signatures).toHaveLength(2);
    expect(signatureVerifies(server.publicKey, payload, signatures[0]!)).toBe(true);
    expect(signatureVerifies(phone.publicKey, payload, signatures[1]!)).toBe(true);
  });

  it('signing a GET is refused rather than silently ignored', async () => {
    const { client: privy, calls } = client();
    await expect(
      privy.request('GET', '/v1/wallets', undefined, { approvals: [generateAuthorizationKey()] }),
    ).rejects.toThrow(/only checks authorization signatures on mutations/);
    expect(calls).toHaveLength(0);
  });

  it('a non-2xx answer becomes a PrivyError carrying the status and body, never the secret', async () => {
    const { client: privy } = client(() => ({
      status: 400,
      body: { code: 'policy_violation', error: 'Policy violation' },
    }));
    const error = await privy.post('/v1/wallets/w1/rpc', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyError);
    expect((error as PrivyError).status).toBe(400);
    expect((error as PrivyError).code).toBe('policy_violation');
    expect((error as PrivyError).message).not.toContain(FAKE_APP_SECRET);
  });

  it('PrivyError separates "one approval short" from a policy refusal', () => {
    const short = new PrivyError('PATCH', '/v1/policies/p', 401, { code: 'invalid_data' });
    const refused = new PrivyError('POST', '/v1/wallets/w/rpc', 400, { code: 'policy_violation' });
    expect(short.isMissingApproval).toBe(true);
    expect(short.isPolicyViolation).toBe(false);
    expect(refused.isMissingApproval).toBe(false);
    expect(refused.isPolicyViolation).toBe(true);
  });
});

describe('createKeyQuorum', () => {
  it('refuses a threshold above its membership instead of creating it', async () => {
    const { client: privy, calls } = client();
    await expect(
      createKeyQuorum(privy, {
        displayName: 'impossible',
        publicKeys: [generateAuthorizationKey().publicKey],
        threshold: 2,
      }),
    ).rejects.toThrow(/would lock the owner out/);
    expect(calls).toHaveLength(0);
  });

  it("sends every member's public key and the threshold", async () => {
    const { client: privy, calls } = client();
    const publicKeys = [generateAuthorizationKey().publicKey, generateAuthorizationKey().publicKey];
    await createKeyQuorum(privy, { displayName: 'board', publicKeys, threshold: 2 });
    expect(calls[0]!.body).toEqual({
      display_name: 'board',
      public_keys: publicKeys,
      authorization_threshold: 2,
    });
  });
});

describe('agent wallet RPC', () => {
  it('eth_signTransaction goes to the wallet /rpc, signed by the approving key', async () => {
    const agent = generateAuthorizationKey();
    const { client: privy, calls } = client();
    const transaction = privyTransaction({
      to: '0x6384e9b2bf3b65e1535403a0a543b5fda905ee22',
      data: '0x47e7ef24',
      chainId: 10143,
      nonce: 0,
      gas: 252_059n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    const signed = await signTransaction(privy, {
      walletId: 'w1',
      transaction,
      approvals: [agent],
    });

    expect(signed).toBe('0x02f8signed');
    const call = calls[0]!;
    expect(call.url).toBe('https://api.privy.io/v1/wallets/w1/rpc');
    expect(call.body).toEqual({ method: 'eth_signTransaction', params: { transaction } });
    expect(
      signatureVerifies(
        agent.publicKey,
        {
          version: 1,
          method: 'POST',
          url: call.url,
          body: call.body,
          headers: { 'privy-app-id': FAKE_APP_ID },
        },
        call.headers['privy-authorization-signature']!,
      ),
    ).toBe(true);
  });

  it('privyTransaction hex-encodes every integer and checksums `to`', () => {
    // A decimal string is rejected by Privy's RPC; bigint.toString() makes one.
    expect(
      privyTransaction({
        to: '0x6384e9b2bf3b65e1535403a0a543b5fda905ee22',
        value: 10n ** 18n,
        chainId: 10143,
        nonce: 3,
        gas: 21_000n,
        maxFeePerGas: 102_000_000_000n,
        maxPriorityFeePerGas: 0n,
      }),
    ).toEqual({
      to: '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22',
      value: '0xde0b6b3a7640000',
      chain_id: 10143,
      nonce: 3,
      gas_limit: '0x5208',
      max_fee_per_gas: '0x17bfac7c00',
      max_priority_fee_per_gas: '0x0',
      type: 2,
    });
  });

  it('toPrivyTypedData spells out EIP712Domain and hashes the same as viem signs', async () => {
    const account = privateKeyToAccount(
      // Anvil #0 — a published key (CLAUDE.md gotcha 11); signs nothing of value.
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const typed = {
      domain: {
        name: 'perpl.xyz',
        version: '1',
        chainId: 10143,
        verifyingContract: '0x0000000000000000000000000000000000000000',
        salt: '0x00000000000000000000000000000000000000006aa2f731368ca5c38d4d3fb0',
      },
      types: { Ping: [{ name: 'time', type: 'uint64' }] },
      primaryType: 'Ping',
      message: { time: 1_789_000_000n },
    } as const;

    const privy = toPrivyTypedData(typed);
    expect(privy.types['EIP712Domain']!.map((f) => f.name)).toEqual([
      'name',
      'version',
      'chainId',
      'verifyingContract',
      'salt',
    ]);
    expect(privy.message).toEqual({ time: 1_789_000_000 });
    // JSON-safe: survives the round trip the request body takes.
    expect(() => canonicalize(privy)).not.toThrow();

    // Signing Privy's shape back through viem must recover the same signer as
    // signing the original: the conversion did not change the digest.
    const signature = await account.signTypedData({
      domain: privy.domain,
      types: privy.types,
      primaryType: privy.primary_type,
      message: privy.message,
    } as Parameters<typeof account.signTypedData>[0]);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
  });
});
