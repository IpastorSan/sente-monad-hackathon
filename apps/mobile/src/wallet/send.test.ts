/**
 * What the phone will and will not sign when it sends funds (SEN-42), against a
 * recording `fetch`. Plain node, no API, no device.
 *
 * The refusals are the point. A blind signer plus a server-composed payload is a
 * server that can spend the user's money; every `refuses` test here is one way
 * that could have happened and does not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';

import { FUNDING_TOKENS } from '../agents/fund.ts';
import type { Token } from '../agents/mandate.ts';
import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { WalletApi, WalletApiError, type PrepareSendResponse, type SessionAuth } from './api.ts';
import {
  describeSendError,
  NoDeviceKeyError,
  SEND_CAIP2,
  SendApprovalRefusedError,
  sendBody,
  sendSponsored,
  sendTransaction,
  verifySendPayload,
  type SendIntent,
} from './send.ts';

const BASE = 'http://api.test';
const TOKEN = 'v1.session-token';
const auth: SessionAuth = { token: () => TOKEN, refresh: () => Promise.resolve(TOKEN) };

const WALLET_ID = 'wallet00000000000000test';
const AGENT = getAddress('0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
const WALLET = getAddress('0x95206ccbe0735bf436b39226dcaa5df536fa6d5e');
const USDC = KURU_TESTNET_TOKENS.USDC as Token;
const MON = KURU_TESTNET_TOKENS.MON as Token;
const USER_OP_HASH = `0x${'ab'.repeat(32)}` as const;

const intent = (over: Partial<SendIntent> = {}): SendIntent => ({
  walletId: WALLET_ID,
  token: USDC,
  to: AGENT,
  atoms: 2_500_000n,
  ...over,
});

/**
 * The payload the API returns for `intent`, which is what it must return.
 *
 * Typed loosely on purpose: the tampering table below puts things in it that an
 * `AuthorizationPayload` would not allow, which is the point — the app must
 * refuse them at runtime rather than trust the type.
 */
type LoosePayload = {
  version: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

function payloadFor(from: SendIntent = intent()): LoosePayload {
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${from.walletId}/rpc`,
    headers: { 'privy-app-id': 'app-123' },
    body: sendBody(from),
  };
}

/** `verifySendPayload` takes the real type; every test here feeds it a loose one. */
const verify = (payload: LoosePayload, from: SendIntent) =>
  verifySendPayload(payload as unknown as AuthorizationPayload, from);

function preparedFor(from: SendIntent = intent()): PrepareSendResponse {
  return {
    prepareId: 'prepare-1',
    payload: payloadFor(from) as unknown as AuthorizationPayload,
    expiresAt: '2026-09-24T23:00:00.000Z',
    summary: {
      from: WALLET,
      to: from.to,
      recipient: { kind: 'agent', agentId: 'agent-1', agentName: 'Momentum' },
      symbol: from.token.symbol,
      tokenAddress: from.token.address,
      decimals: from.token.decimals,
      atoms: from.atoms.toString(),
      amount: '2.5',
      chainId: 10143,
      sponsored: true,
    },
  };
}

/** A fake API: records every request and answers the two send routes. */
function fakeApi(
  options: {
    prepared?: PrepareSendResponse;
    status?: { status: string; transactionHash?: string };
    executeStatus?: number;
    executeBody?: unknown;
  } = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (url.pathname === '/wallet/send/prepare') {
      return Promise.resolve(Response.json(options.prepared ?? preparedFor()));
    }
    if (url.pathname === '/wallet/send/execute') {
      return Promise.resolve(
        Response.json(
          options.executeBody ?? {
            userOpHash: USER_OP_HASH,
            transactionId: 'txid-1',
            status: 'pending',
            sponsored: true,
          },
          { status: options.executeStatus ?? 200 },
        ),
      );
    }
    if (url.pathname.startsWith('/wallet/operations/')) {
      return Promise.resolve(
        Response.json({
          userOpHash: USER_OP_HASH,
          ...(options.status ?? { status: 'included', transactionHash: `0x${'cd'.repeat(32)}` }),
        }),
      );
    }
    return Promise.resolve(Response.json({ message: 'not found' }, { status: 404 }));
  };
  return { api: new WalletApi({ auth, baseUrl: BASE, fetchImpl }), calls };
}

const sign = () => 'ZGV2aWNlLXNpZ25hdHVyZQ==';
const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// What the phone builds
// ---------------------------------------------------------------------------

// The literals below are the contract with the API, which asserts the SAME ones
// in services/api/src/wallet/send/sponsored-send.spec.ts. Two sides, one set of
// bytes: if either changes, one of the two suites goes red.
test('an ERC-20 send is a transfer call with no value at all', () => {
  const transaction = sendTransaction(intent());

  assert.equal(transaction['to'], getAddress(USDC.address));
  assert.equal(transaction['chain_id'], 10143);
  // An absent `value` and a zero one are different bytes, and the signature is
  // over the bytes.
  assert.ok(!('value' in transaction));
  const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction['data'] as `0x${string}` });
  assert.equal(decoded.functionName, 'transfer');
  assert.deepEqual(decoded.args, [AGENT, 2_500_000n]);
});

test('a native MON send is a hex value with no calldata', () => {
  const transaction = sendTransaction(intent({ token: MON, atoms: 10n ** 17n }));

  assert.deepEqual(transaction, { to: AGENT, value: '0x16345785d8a0000', chain_id: 10143 });
});

test('the body asks for sponsorship on Monad testnet', () => {
  assert.deepEqual(sendBody(intent()), {
    method: 'eth_sendTransaction',
    caip2: 'eip155:10143',
    sponsor: true,
    params: { transaction: sendTransaction(intent()) },
  });
  assert.equal(SEND_CAIP2, 'eip155:10143');
});

test('every fundable token builds a transaction the verifier accepts', () => {
  for (const token of FUNDING_TOKENS) {
    const only = intent({ token, atoms: 1n });
    const verdict = verify(payloadFor(only), only);
    assert.deepEqual(verdict, { ok: true }, `${token.symbol} was refused`);
  }
});

// ---------------------------------------------------------------------------
// What the phone refuses to sign
// ---------------------------------------------------------------------------

test('accepts the payload it would have built itself', () => {
  assert.deepEqual(verify(payloadFor(), intent()), { ok: true });
});

/** Every mutation here is a way a server could try to spend somebody's funds. */
const tampered: [string, (payload: ReturnType<typeof payloadFor>) => void][] = [
  ['another wallet', (p) => void (p.url = 'https://api.privy.io/v1/wallets/someone-else/rpc')],
  ['another host', (p) => void (p.url = `https://api.privy.evil/v1/wallets/${WALLET_ID}/rpc`)],
  ['a trailing slash', (p) => void (p.url = `${p.url}/`)],
  ['a PATCH', (p) => void (p.method = 'PATCH')],
  ['version 2', (p) => void (p.version = 2)],
  ['an extra header', (p) => void (p.headers['x-sente'] = 'hello')],
  ['no app id', (p) => void delete p.headers['privy-app-id']],
  ['another rpc method', (p) => void ((p.body as Record<string, unknown>)['method'] = 'eth_sign')],
  ['another chain', (p) => void ((p.body as Record<string, unknown>)['caip2'] = 'eip155:1')],
  ['no sponsorship', (p) => void ((p.body as Record<string, unknown>)['sponsor'] = false)],
  ['an extra body key', (p) => void ((p.body as Record<string, unknown>)['idempotency'] = '1')],
  [
    'another recipient',
    (p) =>
      void (transactionOf(p)['data'] = sendTransaction(
        intent({ to: getAddress('0xbadbadbadbadbadbadbadbadbadbadbadbadbad0') }),
      )['data']),
  ],
  [
    'a bigger amount',
    (p) =>
      void (transactionOf(p)['data'] = sendTransaction(intent({ atoms: 25_000_000n }))['data']),
  ],
  ['another token', (p) => void (transactionOf(p)['to'] = getAddress(MON.address))],
  ['a value smuggled in beside the calldata', (p) => void (transactionOf(p)['value'] = '0x1')],
  ['a gas field nobody asked for', (p) => void (transactionOf(p)['gas_limit'] = '0x5208')],
  ['no transaction at all', (p) => void delete (p.body as Record<string, unknown>)['params']],
];

function transactionOf(payload: ReturnType<typeof payloadFor>): Record<string, unknown> {
  return (payload.body as { params: { transaction: Record<string, unknown> } }).params.transaction;
}

for (const [what, tamper] of tampered) {
  test(`refuses ${what}`, () => {
    const payload = payloadFor();
    tamper(payload);

    const verdict = verify(payload, intent());

    assert.equal(verdict.ok, false, `${what} was accepted`);
    assert.ok(!verdict.ok && verdict.problem.length > 0);
  });
}

test('accepts a lower-cased `to`, because an address is an address', () => {
  const payload = payloadFor(intent({ token: MON }));
  transactionOf(payload)['to'] = AGENT.toLowerCase();

  assert.deepEqual(verify(payload, intent({ token: MON })), { ok: true });
});

// ---------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------

test('prepares, verifies, signs, executes and confirms', async () => {
  const { api, calls } = fakeApi();

  const sent = await sendSponsored(api, intent(), sign, { sleep: noSleep });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /wallet/send/prepare',
      'POST /wallet/send/execute',
      `GET /wallet/operations/${USER_OP_HASH}`,
    ],
  );
  // Atoms on the wire, as a decimal string: the API must not have to guess.
  assert.deepEqual(calls[0]?.body, {
    to: AGENT,
    token: USDC.address,
    amount: '2500000',
  });
  assert.deepEqual(calls[1]?.body, { prepareId: 'prepare-1', signature: sign() });
  assert.equal(sent.userOpHash, USER_OP_HASH);
  // Gotcha 8: what was followed is the USER OPERATION, and what it reports is
  // the operation's own outcome.
  assert.equal(sent.confirmation?.status, 'included');
});

test('a reverted user operation comes back as reverted, not as sent', async () => {
  const { api } = fakeApi({ status: { status: 'reverted' } });

  const sent = await sendSponsored(api, intent(), sign, { sleep: noSleep });

  assert.equal(sent.confirmation?.status, 'reverted');
});

test('a timeout is pending, never a failure: the money may still have moved', async () => {
  const { api } = fakeApi({ status: { status: 'pending' } });

  const sent = await sendSponsored(api, intent(), sign, { sleep: noSleep, timeoutMs: 0 });

  assert.equal(sent.confirmation?.status, 'pending');
});

test('does not sign a payload for another wallet, and sends nothing', async () => {
  const { api, calls } = fakeApi({ prepared: preparedFor(intent({ walletId: 'not-mine' })) });
  let signed = 0;

  await assert.rejects(
    sendSponsored(api, intent(), () => {
      signed += 1;
      return sign();
    }),
    SendApprovalRefusedError,
  );

  assert.equal(signed, 0);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/wallet/send/prepare'],
  );
});

test('refuses to start without a device key', async () => {
  const { api, calls } = fakeApi();

  await assert.rejects(sendSponsored(api, intent(), null), NoDeviceKeyError);

  assert.deepEqual(calls, []);
});

test('says nothing moved when the server answers `unknown`', async () => {
  const { api } = fakeApi({
    executeBody: { status: 'unknown', sponsored: false },
  });

  const sent = await sendSponsored(api, intent(), sign, { sleep: noSleep });

  assert.equal(sent.status, 'unknown');
  assert.equal(sent.confirmation, undefined);
});

test('turns the API’s refusals into copy a person can act on', async () => {
  const { api } = fakeApi({
    executeStatus: 502,
    executeBody: {
      reason: 'send_broadcast_failed',
      message: 'Your previous transfer is still settling, so this one was refused.',
    },
  });

  const error = await sendSponsored(api, intent(), sign, { sleep: noSleep }).catch(
    (caught: unknown) => caught,
  );

  const described = describeSendError(error);
  assert.equal(described.title, 'The transfer didn’t go through');
  assert.match(described.detail, /still settling/);
});

test('names the recipient rule when a recipient is refused', () => {
  const described = describeSendError(
    new WalletApiError(403, 'send_recipient_not_allowed', '0x… is not one of your agents'),
  );

  assert.equal(described.title, 'That recipient isn’t allowed');
  assert.match(described.detail, /your own wallet or to an agent you hired/);
});

test('an expired approval says so, and says what to do', () => {
  const described = describeSendError(
    new WalletApiError(410, 'send_prepare_not_found', 'no pending transfer'),
  );

  assert.equal(described.title, 'This transfer expired');
  assert.match(described.detail, /single-use/);
});

test('the refusal copy for a rejected signature tells you which device to use', async () => {
  const { api } = fakeApi({
    executeStatus: 401,
    executeBody: { reason: 'invalid_authorization', message: 'nope' },
  });

  const error = await sendSponsored(api, intent(), sign, { sleep: noSleep }).catch(
    (caught: unknown) => caught,
  );

  assert.match(describeSendError(error).detail, /device that owns this wallet/);
});

test('a lower-cased recipient still encodes the same transfer', () => {
  const lower = intent({ to: AGENT.toLowerCase() as Address });

  const decoded = decodeFunctionData({
    abi: erc20Abi,
    data: sendTransaction(lower)['data'] as `0x${string}`,
  });

  // ABI encoding has no casing, so the calldata is identical — and the verifier
  // must accept the checksummed intent against it.
  assert.deepEqual(decoded.args, [AGENT, 2_500_000n]);
  assert.deepEqual(verify(payloadFor(lower), lower), { ok: true });
});
