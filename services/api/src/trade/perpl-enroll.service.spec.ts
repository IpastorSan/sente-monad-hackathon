import { createPublicKey, verify } from 'node:crypto';
import { inspect } from 'node:util';

import { HttpException, Logger } from '@nestjs/common';
import {
  PERPL_API_KEY_TYPED_DATA,
  PERPL_NETWORKS,
  newSecretKey,
  publicKeyOf,
  SCOPE,
  toViemTypedData,
  type PerplTypedData,
} from '@sente/venues/perpl';
import {
  bytesToHex,
  getAddress,
  hashTypedData,
  hexToBytes,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { PrivyClient } from '../agents/privy/privy.client';
import type { UserWalletBinding } from '../wallet/store/user-wallet-registry';
import { TRADE_CHAIN_ID, type TradeConfig } from './trade.config';
import { perplPublicKeyField } from './perpl-enroll-format';
import {
  ed25519Sign,
  enrollRefusalToHttpException,
  PerplEnrollService,
  READ_KEY_LABEL,
  type EnrollPrivy,
} from './perpl-enroll.service';
import { InMemoryUserVenueSecretStore } from './user-venue-secrets';

beforeAll(() => Logger.overrideLogger(false));

// Anvil #0 — a published key (gotcha 11). It stands in for the Privy wallet's
// enclave key so the fake Perpl can ecrecover exactly as the real one does.
const WALLET = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = { userId: '0xa11ce' };
const BOB = { userId: '0xb0b' };
const WALLET_ID = 'wallet-alice';
const PHONE_SIG = 'MEUCIQDphone==';
const BINDING: UserWalletBinding = {
  userId: ALICE.userId,
  walletId: WALLET_ID,
  address: getAddress(WALLET.address),
  ownerQuorumId: 'quorum',
  devicePublicKey: 'key',
  createdAt: T0,
};

const PHONE_SECRET = newSecretKey();
const PHONE_PUBLIC: Hex = bytesToHex(publicKeyOf(PHONE_SECRET));

/** An 11-field payload shaped like the live one (constants.ts, 2026-09-11). */
/** What Perpl writes back for a requested mask: the effective scope, trade implying read (P5). */
function servedScope(mask: unknown): string {
  const requested = Number(mask);
  return String(requested & SCOPE.trade ? requested | SCOPE.read : requested);
}

/** A payload in the exact live format probe P5 recorded (docs/user-trading.md §P5). */
function servedPayload(body: Record<string, unknown>, servedAt = T0.getTime()): PerplTypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: PERPL_API_KEY_TYPED_DATA.types.PerplRegisterApiKey.map((f) => ({
        ...f,
      })),
    },
    primaryType: 'PerplRegisterApiKey',
    domain: {
      name: 'perpl.xyz',
      version: '1',
      chainId: '0x279f',
      verifyingContract: '0x0000000000000000000000000000000000000000',
      salt: '0x00000000000000000000000000000000000000006aa3eb20368ca5c38d4d3fb0',
    },
    message: {
      signer: String(body['address']),
      statement: PERPL_API_KEY_TYPED_DATA.statement,
      publicKey: perplPublicKeyField(body['public_key'] as Hex),
      scope: servedScope(body['scope_mask']),
      label: String(body['label']),
      expiresAt: '0',
      ipCidrs: '',
      origin: '',
      builderId: '0',
      maxBuilderFeePer100K: '0',
      time: `0x${servedAt.toString(16)}`,
    },
  };
}

function ed25519Verify(publicKey: Hex, digest: Hex, signature: Hex): boolean {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(hexToBytes(publicKey)),
  ]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return verify(null, hexToBytes(digest), key, hexToBytes(signature));
}

type Call = { to: 'privy' | 'perpl'; what: string; body: Record<string, unknown> };

/**
 * A fake Perpl that checks both signatures the way the real one must, and a
 * fake Privy (behind the REAL `PrivyClient`, so the wire is the real one) that
 * signs with the wallet key only when the phone's signature is attached.
 */
function harness(
  o: {
    enabled?: boolean;
    accountId?: bigint | null;
    binding?: UserWalletBinding | null;
    tamper?: (typed: PerplTypedData) => void;
    enrollStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  const privyHeaders: Record<string, string>[] = [];
  const served = new Map<string, PerplTypedData>(); // public key -> typed data
  const enrolled: { publicKey: string; scope: string }[] = [];
  let lastEnrolledTime = 0n;

  const perplFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/payload')) {
      calls.push({ to: 'perpl', what: `payload:${String(body['scope_mask'])}`, body });
      // Each payload a millisecond after the last, as the live clock moves.
      const typed = servedPayload(body, T0.getTime() + served.size);
      o.tamper?.(typed);
      served.set(typed.message['publicKey']!, typed);
      return new Response(JSON.stringify({ typed_data: typed, mac: `mac-${body['scope_mask']}` }));
    }
    const typed = body['typed_data'] as PerplTypedData;
    calls.push({ to: 'perpl', what: `enroll:${typed.message['scope']}`, body });
    if (o.enrollStatus) return new Response('nope', { status: o.enrollStatus });
    // Live rule (P5): a payload older than the last enrolled one is a bare 400.
    const time = BigInt(typed.message['time']!);
    if (time < lastEnrolledTime) return new Response('Bad Request', { status: 400 });
    lastEnrolledTime = time;
    const viemTyped = toViemTypedData(typed) as Parameters<typeof hashTypedData>[0];
    const signer = await recoverTypedDataAddress({
      ...viemTyped,
      signature: body['signature'] as Hex,
    });
    if (signer !== WALLET.address) return new Response('bad signature', { status: 400 });
    const publicKey = bytesToHex(Buffer.from(typed.message['publicKey']!, 'base64url'));
    if (!ed25519Verify(publicKey, hashTypedData(viemTyped), body['pop_signature'] as Hex)) {
      return new Response('bad pop', { status: 400 });
    }
    enrolled.push({ publicKey, scope: typed.message['scope']! });
    return new Response(
      JSON.stringify({ api_key: { api_key: `token-${typed.message['scope']}` } }),
    );
  }) as typeof fetch;

  const privyFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    privyHeaders.push(headers);
    const body = JSON.parse(String(init?.body)) as {
      params: { typed_data: { message: Record<string, string> } };
    };
    const message = body.params.typed_data.message;
    calls.push({ to: 'privy', what: `sign:${message['scope']}`, body });
    if (headers['privy-authorization-signature'] !== PHONE_SIG) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    // Sign what Perpl served for this key: the Privy body is its faithful copy.
    const typed = served.get(message['publicKey']!)!;
    const signature = await WALLET.signTypedData(
      toViemTypedData(typed) as Parameters<typeof hashTypedData>[0],
    );
    return new Response(JSON.stringify({ method: 'eth_signTypedData_v4', data: { signature } }));
  }) as typeof fetch;

  const privy = new PrivyClient({ appId: 'app', appSecret: 'secret', fetch: privyFetch });
  const secrets = new InMemoryUserVenueSecretStore();
  const config: TradeConfig = {
    enabled: o.enabled ?? true,
    atomicBatch: false,
    chainId: TRADE_CHAIN_ID,
  };
  const binding = o.binding === undefined ? BINDING : o.binding;
  const service = new FixedClock(
    config,
    {
      find: (userId) => Promise.resolve(binding && userId === binding.userId ? binding : undefined),
    },
    privy as EnrollPrivy,
    {
      network: PERPL_NETWORKS.testnet,
      accountOf: () => Promise.resolve(o.accountId === undefined ? 505n : o.accountId),
      fetchImpl: perplFetch,
    },
    secrets,
  );
  return { service, calls, privyHeaders, secrets, enrolled, served };
}

class FixedClock extends PerplEnrollService {
  at = T0;
  protected override now(): Date {
    return this.at;
  }
}

const PREPARE = { publicKeyHex: PHONE_PUBLIC, label: 'sente-phone' };

async function refusal(promise: Promise<unknown>): Promise<{ status: number; reason: string }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  const mapped = enrollRefusalToHttpException(error);
  if (!(mapped instanceof HttpException)) throw error;
  const body = mapped.getResponse() as { reason: string };
  return { status: mapped.getStatus(), reason: body.reason };
}

/** The phone's side of commit: its PoP over the trade item's digest, hashed from `typedData`. */
function phonePop(typed: PerplTypedData): Hex {
  return ed25519Sign(
    PHONE_SECRET,
    hashTypedData(toViemTypedData(typed) as Parameters<typeof hashTypedData>[0]),
  );
}

describe('PerplEnrollService.prepare', () => {
  it('fetches a trade and a read payload and composes what the device key signs', async () => {
    const { service, calls } = harness();
    const prepared = await service.prepare(ALICE, PREPARE);

    expect(prepared.expiresAt).toBe(new Date(T0.getTime() + 5 * 60 * 1000).toISOString());
    expect(prepared.items.map((i) => i.role)).toEqual(['trade', 'read']);
    // Trade key: the phone's, trade scope. Read key: the server's, read scope.
    // Fetched read first: Perpl refuses a payload older than the last one enrolled,
    // and commit submits read first.
    expect(calls.map((c) => c.what)).toEqual(['payload:1', 'payload:2']);
    expect(calls[1]!.body).toMatchObject({ public_key: PHONE_PUBLIC, label: 'sente-phone' });
    expect(calls[0]!.body['public_key']).not.toBe(PHONE_PUBLIC);
    expect(calls[0]!.body['label']).toBe(READ_KEY_LABEL);

    for (const item of prepared.items) {
      expect(item.payload).toMatchObject({
        version: 1,
        method: 'POST',
        url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
        headers: {
          'privy-app-id': 'app',
          'privy-idempotency-key': `sente-enroll:${prepared.prepareId}:${item.role}`,
        },
        body: { method: 'eth_signTypedData_v4' },
      });
      const body = item.payload.body as { params: { typed_data: { primary_type: string } } };
      expect(body.params.typed_data.primary_type).toBe('PerplRegisterApiKey');
    }
    expect(prepared.items[0]!.typedData.message['publicKey']).toBe(
      perplPublicKeyField(PHONE_PUBLIC),
    );
    expect(prepared.items.map((i) => i.typedData.message['scope'])).toEqual(['3', '1']);
    // Nothing reached Privy: prepare signs nothing.
    expect(calls.some((c) => c.to === 'privy')).toBe(false);
  });

  it('refuses with the flag off, without a wallet, and without a Perpl account', async () => {
    expect(await refusal(harness({ enabled: false }).service.prepare(ALICE, PREPARE))).toEqual({
      status: 404,
      reason: 'trading_disabled',
    });
    expect(await refusal(harness({ binding: null }).service.prepare(ALICE, PREPARE))).toEqual({
      status: 404,
      reason: 'account_not_registered',
    });
    expect(await refusal(harness({ accountId: null }).service.prepare(ALICE, PREPARE))).toEqual({
      status: 422,
      reason: 'perpl_not_onboarded',
    });
  });

  it.each<[string, (typed: PerplTypedData) => void]>([
    [
      'a new struct field',
      (t) => t.types['PerplRegisterApiKey']!.push({ name: 'x', type: 'string' }),
    ],
    ['a retyped field', (t) => (t.types['PerplRegisterApiKey']![10]!.type = 'uint256')],
    ['a builder id', (t) => (t.message['builderId'] = 'skimmer')],
    ['a builder fee', (t) => (t.message['maxBuilderFeePer100K'] = '50')],
    ['another signer', (t) => (t.message['signer'] = `0x${'be'.repeat(20)}`)],
    [
      'another public key',
      (t) => (t.message['publicKey'] = perplPublicKeyField(`0x${'11'.repeat(32)}`)),
    ],
    [
      'our key in another encoding (hex)',
      (t) => {
        if (t.message['publicKey'] === perplPublicKeyField(PHONE_PUBLIC)) {
          t.message['publicKey'] = PHONE_PUBLIC;
        }
      },
    ],
    [
      'a read key widened to trade',
      (t) => {
        if (t.message['scope'] === '1') t.message['scope'] = '3';
      },
    ],
    ['a trade key narrowed to the requested mask', (t) => (t.message['scope'] = '2')],
    ['an expiry', (t) => (t.message['expiresAt'] = '1791560221000')],
    ['an empty builder id spelled differently', (t) => (t.message['builderId'] = '')],
    ['an IP allowlist', (t) => (t.message['ipCidrs'] = '10.0.0.0/8')],
    ['an origin', (t) => (t.message['origin'] = 'https://evil.example')],
    ['a stale time', (t) => (t.message['time'] = `0x${(T0.getTime() - 6 * 60_000).toString(16)}`)],
    ['another chain', (t) => (t.domain.chainId = '0x8f')],
    ['another statement', (t) => (t.message['statement'] = 'I authorize everything')],
  ])('fails closed on %s (D4)', async (_name, tamper) => {
    const { service } = harness({ tamper });
    expect(await refusal(service.prepare(ALICE, PREPARE))).toEqual({
      status: 502,
      reason: 'perpl_format_changed',
    });
  });

  it('does not pin the domain salt, which drifts day to day', async () => {
    const { service } = harness({ tamper: (t) => (t.domain.salt = `0x${'ab'.repeat(32)}`) });
    await expect(service.prepare(ALICE, PREPARE)).resolves.toBeDefined();
  });

  it('maps a Perpl refusal of the payload to perpl_enroll_refused', async () => {
    const failing = new FixedClock(
      { enabled: true, atomicBatch: false, chainId: TRADE_CHAIN_ID },
      { find: () => Promise.resolve(BINDING) },
      {} as EnrollPrivy,
      {
        network: PERPL_NETWORKS.testnet,
        accountOf: () => Promise.resolve(505n),
        fetchImpl: (() => Promise.resolve(new Response('no', { status: 404 }))) as typeof fetch,
      },
      new InMemoryUserVenueSecretStore(),
    );
    expect(await refusal(failing.prepare(ALICE, PREPARE))).toEqual({
      status: 422,
      reason: 'perpl_enroll_refused',
    });
  });
});

describe('PerplEnrollService.commit', () => {
  it('signs both through Privy with the phone signature alone, then enrolls read and trade', async () => {
    const h = harness();
    const prepared = await h.service.prepare(ALICE, PREPARE);
    h.calls.length = 0;

    const result = await h.service.commit(ALICE, {
      prepareId: prepared.prepareId,
      signatures: [PHONE_SIG, PHONE_SIG],
      popSignature: phonePop(prepared.items[0]!.typedData),
    });

    expect(result).toEqual({ apiKey: 'token-3', accountId: '505', readKey: 'linked' });
    expect(h.calls.map((c) => `${c.to}:${c.what}`)).toEqual([
      'privy:sign:3',
      'privy:sign:1',
      'perpl:enroll:1',
      'perpl:enroll:3',
    ]);
    // Forwarded verbatim and alone, under the signed idempotency key.
    expect(h.privyHeaders.map((hdr) => hdr['privy-authorization-signature'])).toEqual([
      PHONE_SIG,
      PHONE_SIG,
    ]);
    expect(h.privyHeaders.map((hdr) => hdr['privy-idempotency-key'])).toEqual([
      `sente-enroll:${prepared.prepareId}:trade`,
      `sente-enroll:${prepared.prepareId}:read`,
    ]);
    // The fake Perpl verified the wallet signature and both proofs of possession.
    expect(h.enrolled.map((e) => e.scope)).toEqual(['1', '3']);

    expect(await h.secrets.getPerplTradeToken(ALICE.userId)).toBe('token-3');
    const read = await h.secrets.getPerplRead(ALICE.userId);
    expect(read?.apiKey).toBe('token-1');
    // The stored key is the one Perpl enrolled at read scope.
    expect(bytesToHex(publicKeyOf(read!.secretKey))).toBe(h.enrolled[0]!.publicKey);
  });

  it('holds the read secret sealed: it prints redacted', async () => {
    const h = harness();
    const prepared = await h.service.prepare(ALICE, PREPARE);
    await h.service.commit(ALICE, {
      prepareId: prepared.prepareId,
      signatures: [PHONE_SIG, PHONE_SIG],
      popSignature: phonePop(prepared.items[0]!.typedData),
    });
    const read = (await h.secrets.getPerplRead(ALICE.userId))!;
    const secretHex = Buffer.from(read.secretKey).toString('hex');

    for (const printed of [inspect(read), JSON.stringify(read), String(inspect(h.service))]) {
      expect(printed).not.toContain(secretHex);
      expect(printed).not.toContain('token-1');
    }
    expect(inspect(read)).toBe('[PerplCredentials redacted]');
  });

  it('answers a replayed commit, an expired prepare and another user with 404', async () => {
    const h = harness();
    const prepared = await h.service.prepare(ALICE, PREPARE);
    const commit = {
      prepareId: prepared.prepareId,
      signatures: [PHONE_SIG, PHONE_SIG],
      popSignature: phonePop(prepared.items[0]!.typedData),
    };

    // Bob's guess neither works nor consumes Alice's prepare.
    expect(await refusal(h.service.commit(BOB, commit))).toEqual({
      status: 404,
      reason: 'enroll_prepare_not_found',
    });
    await h.service.commit(ALICE, commit);
    expect(await refusal(h.service.commit(ALICE, commit))).toEqual({
      status: 404,
      reason: 'enroll_prepare_not_found',
    });

    const again = await h.service.prepare(ALICE, PREPARE);
    h.service.at = new Date(T0.getTime() + 5 * 60 * 1000);
    expect(
      await refusal(h.service.commit(ALICE, { ...commit, prepareId: again.prepareId })),
    ).toEqual({ status: 404, reason: 'enroll_prepare_not_found' });
  });

  it('lets only the newest prepare per user be committed', async () => {
    const h = harness();
    const first = await h.service.prepare(ALICE, PREPARE);
    await h.service.prepare(ALICE, PREPARE);
    expect(
      await refusal(
        h.service.commit(ALICE, {
          prepareId: first.prepareId,
          signatures: [PHONE_SIG, PHONE_SIG],
          popSignature: phonePop(first.items[0]!.typedData),
        }),
      ),
    ).toMatchObject({ reason: 'enroll_prepare_not_found' });
  });

  it('maps a Perpl enrollment refusal to perpl_enroll_refused and links nothing', async () => {
    const h = harness({ enrollStatus: 423 });
    const prepared = await h.service.prepare(ALICE, PREPARE);
    expect(
      await refusal(
        h.service.commit(ALICE, {
          prepareId: prepared.prepareId,
          signatures: [PHONE_SIG, PHONE_SIG],
          popSignature: phonePop(prepared.items[0]!.typedData),
        }),
      ),
    ).toEqual({ status: 422, reason: 'perpl_enroll_refused' });
    expect(await h.secrets.getPerplRead(ALICE.userId)).toBeUndefined();
    expect(await h.secrets.getPerplTradeToken(ALICE.userId)).toBeUndefined();
  });

  it('maps a device signature Privy refuses to invalid_authorization', async () => {
    const h = harness();
    const prepared = await h.service.prepare(ALICE, PREPARE);
    const refused = await refusal(
      h.service.commit(ALICE, {
        prepareId: prepared.prepareId,
        signatures: ['MEUCIQDwrong==', 'MEUCIQDwrong=='],
        popSignature: phonePop(prepared.items[0]!.typedData),
      }),
    );
    expect(refused.reason).toBe('invalid_authorization');
    expect(h.calls.some((c) => c.what.startsWith('enroll'))).toBe(false);
  });
});
