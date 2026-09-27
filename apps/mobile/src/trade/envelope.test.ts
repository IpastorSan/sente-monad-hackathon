/**
 * The phone envelope verifier (SEN-86, plan M-T4): one accepted shape per RPC
 * method, then one tampered payload per rule. Every refusal here is a way a
 * compromised server could have got a blind signature and does not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAddress } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import {
  tradeIdempotencyKey,
  verifyTradeEnvelope,
  type TradeEnvelopeExpectation,
} from './envelope.ts';

const WALLET_ID = 'wallet00000000000000test';
const APP_ID = 'app-id-test';
const KEY = tradeIdempotencyKey('4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f', 0);
const MARKET = getAddress('0x065c9d28e428a0db40191a54d33d5b7c71a9c394');
const CALLDATA = '0xa9059cbb00000000000000000000000000000000000000000000000000000000000000ff';

const SEND: TradeEnvelopeExpectation = {
  walletId: WALLET_ID,
  idempotencyKey: KEY,
  rpcMethod: 'eth_sendTransaction',
};
const TYPED: TradeEnvelopeExpectation = { ...SEND, rpcMethod: 'eth_signTypedData_v4' };

/**
 * What the server signs for a trade step: `sponsoredSendBody(sponsoredCallTransaction(...))`
 * with the idempotency key in the headers (SEN-87). Mirrored, not imported —
 * the app does not import the API (CLAUDE.md gotchas 2 and 10).
 */
function sendPayload(value?: bigint): AuthorizationPayload {
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: { 'privy-app-id': APP_ID, 'privy-idempotency-key': KEY },
    body: {
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      params: {
        transaction: {
          to: MARKET,
          data: CALLDATA,
          ...(value ? { value: `0x${value.toString(16)}` } : {}),
          chain_id: 10143,
        },
      },
    },
  };
}

function typedPayload(): AuthorizationPayload {
  return {
    ...sendPayload(),
    body: {
      method: 'eth_signTypedData_v4',
      params: { typed_data: { domain: {}, types: {}, primary_type: 'X', message: {} } },
    },
  };
}

type Json = Record<string, unknown>;
const bodyOf = (p: AuthorizationPayload) => p.body as Json;
const txOf = (p: AuthorizationPayload) => (bodyOf(p)['params'] as Json)['transaction'] as Json;

/** A fresh send payload with one thing changed. */
function tamper(
  edit: (p: AuthorizationPayload) => void,
  base = sendPayload(),
): AuthorizationPayload {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

function refused(p: AuthorizationPayload, e: TradeEnvelopeExpectation, pattern: RegExp): void {
  const result = verifyTradeEnvelope(p, e);
  assert.equal(result.ok, false, 'expected a refusal');
  if (!result.ok) assert.match(result.problem, pattern);
}

test('tradeIdempotencyKey is sente-trade:<clientTradeId>:<stepIndex>', () => {
  assert.equal(tradeIdempotencyKey('abc', 2), 'sente-trade:abc:2');
});

test("accepts the server's sponsored call without a value and returns its params", () => {
  const payload = sendPayload();
  const result = verifyTradeEnvelope(payload, SEND);
  assert.deepEqual(result, { ok: true, params: bodyOf(payload)['params'] });
});

test('accepts a non-zero value in canonical hex (native deposit)', () => {
  const result = verifyTradeEnvelope(sendPayload(10n ** 18n), SEND);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.params['transaction'] as Json)['value'], '0xde0b6b3a7640000');
  }
});

test('accepts typed data and returns its params', () => {
  const payload = typedPayload();
  assert.deepEqual(verifyTradeEnvelope(payload, TYPED), {
    ok: true,
    params: bodyOf(payload)['params'],
  });
});

test('refuses a payload that is not an object', () => {
  refused(null as unknown as AuthorizationPayload, SEND, /not a Privy request/);
});

test('refuses another version', () => {
  refused(
    tamper((p) => ((p as unknown as Json)['version'] = 2)),
    SEND,
    /version 2/,
  );
});

test('refuses another HTTP method', () => {
  refused(
    tamper((p) => (p.method = 'PATCH')),
    SEND,
    /PATCH/,
  );
});

test('refuses another wallet, another host, a trailing slash, another path', () => {
  for (const url of [
    'https://api.privy.io/v1/wallets/someoneelse/rpc',
    `https://api.privy.io.evil/v1/wallets/${WALLET_ID}/rpc`,
    `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc/`,
    `https://api.privy.io/v1/wallets/${WALLET_ID}`,
    `http://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
  ]) {
    refused(
      tamper((p) => (p.url = url)),
      SEND,
      /not from your wallet/,
    );
  }
});

test('refuses when the expected wallet id is empty', () => {
  refused(
    tamper((p) => (p.url = 'https://api.privy.io/v1/wallets//rpc')),
    { ...SEND, walletId: '' },
    /no wallet/,
  );
});

test('refuses missing headers and an unexpected header', () => {
  refused(
    tamper((p) => ((p as unknown as Json)['headers'] = null)),
    SEND,
    /no headers/,
  );
  refused(
    tamper((p) => (p.headers['privy-authorization-signature'] = 'x')),
    SEND,
    /unexpected headers: privy-authorization-signature/,
  );
});

test('refuses a missing or empty privy-app-id', () => {
  refused(
    tamper((p) => delete p.headers['privy-app-id']),
    SEND,
    /no Privy app/,
  );
  refused(
    tamper((p) => (p.headers['privy-app-id'] = '')),
    SEND,
    /no Privy app/,
  );
});

test('refuses a missing idempotency key', () => {
  refused(
    tamper((p) => delete p.headers['privy-idempotency-key']),
    SEND,
    /no idempotency key/,
  );
});

test("refuses another step's or another trade's idempotency key", () => {
  for (const other of [
    tradeIdempotencyKey('4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f', 1),
    tradeIdempotencyKey('00000000-0000-4000-8000-000000000000', 0),
    '',
  ]) {
    refused(
      tamper((p) => (p.headers['privy-idempotency-key'] = other)),
      SEND,
      /not this step's/,
    );
  }
});

test('refuses when the expected idempotency key is empty, even if the payload matches', () => {
  const payload = tamper((p) => (p.headers['privy-idempotency-key'] = ''));
  refused(payload, { ...SEND, idempotencyKey: '' }, /no idempotency key to check/);
});

test('refuses a body that is not an object', () => {
  refused(
    tamper((p) => (p.body = [])),
    SEND,
    /body is not/,
  );
});

test('refuses an RPC method other than the expected one', () => {
  refused(
    tamper((p) => (bodyOf(p)['method'] = 'eth_signTransaction')),
    SEND,
    /eth_signTransaction/,
  );
  refused(sendPayload(), TYPED, /eth_sendTransaction, not eth_signTypedData_v4/);
  refused(typedPayload(), SEND, /eth_signTypedData_v4, not eth_sendTransaction/);
});

test('send: refuses an extra or a missing body key', () => {
  refused(
    tamper((p) => (bodyOf(p)['address'] = MARKET)),
    SEND,
    /also carries address/,
  );
  refused(
    tamper((p) => delete bodyOf(p)['sponsor']),
    SEND,
    /missing sponsor/,
  );
});

test('send: refuses another chain', () => {
  refused(
    tamper((p) => (bodyOf(p)['caip2'] = 'eip155:143')),
    SEND,
    /eip155:143/,
  );
});

test('send: refuses unsponsored gas, including a truthy non-boolean', () => {
  refused(
    tamper((p) => (bodyOf(p)['sponsor'] = false)),
    SEND,
    /sponsored gas/,
  );
  refused(
    tamper((p) => (bodyOf(p)['sponsor'] = 'true')),
    SEND,
    /sponsored gas/,
  );
});

test('send: refuses params that are not exactly {transaction}', () => {
  refused(
    tamper((p) => (bodyOf(p)['params'] = null)),
    SEND,
    /no transaction/,
  );
  refused(
    tamper((p) => ((bodyOf(p)['params'] as Json)['authorization_list'] = [])),
    SEND,
    /params also carries authorization_list/,
  );
  refused(
    tamper((p) => (bodyOf(p)['params'] = {})),
    SEND,
    /params is missing transaction/,
  );
});

test('send: refuses a transaction with an extra or a missing key', () => {
  for (const extra of ['gas', 'nonce', 'from', 'type']) {
    refused(
      tamper((p) => (txOf(p)[extra] = '0x1')),
      SEND,
      new RegExp(`transaction also carries ${extra}`),
    );
  }
  refused(
    tamper((p) => delete txOf(p)['data']),
    SEND,
    /transaction is missing data/,
  );
  refused(
    tamper((p) => delete txOf(p)['chain_id']),
    SEND,
    /transaction is missing chain_id/,
  );
  refused(
    tamper((p) => ((bodyOf(p)['params'] as Json)['transaction'] = 'x')),
    SEND,
    /no transaction/,
  );
});

test('send: refuses a target that is not a checksummed address', () => {
  for (const to of [MARKET.toLowerCase(), MARKET.toUpperCase().replace('0X', '0x'), '0x1234', 7]) {
    refused(
      tamper((p) => (txOf(p)['to'] = to)),
      SEND,
      /not a checksummed address/,
    );
  }
});

test('send: refuses calldata that is not hex bytes', () => {
  for (const data of ['0xabc', 'a9059cbb', '0xzz', 42]) {
    refused(
      tamper((p) => (txOf(p)['data'] = data)),
      SEND,
      /calldata is not hex bytes/,
    );
  }
});

test('send: refuses another chain id, including 10143 as a string', () => {
  for (const chainId of [143, '10143', '0x279f']) {
    refused(
      tamper((p) => (txOf(p)['chain_id'] = chainId)),
      SEND,
      /not Monad testnet/,
    );
  }
});

test('send: refuses a zero or non-canonical value', () => {
  for (const value of ['0x0', '0x', '0x01', '0xDE0B6B3A7640000', '1000', 1, null]) {
    refused(
      tamper((p) => (txOf(p)['value'] = value)),
      SEND,
      /not a canonical non-zero amount/,
    );
  }
});

test('typed data: refuses anything but exactly {method, params: {typed_data}}', () => {
  const typed = typedPayload();
  refused(
    tamper((p) => (bodyOf(p)['caip2'] = 'eip155:10143'), typed),
    TYPED,
    /body also carries caip2/,
  );
  refused(
    tamper((p) => (bodyOf(p)['sponsor'] = true), typed),
    TYPED,
    /body also carries sponsor/,
  );
  refused(
    tamper((p) => delete bodyOf(p)['params'], typed),
    TYPED,
    /missing params/,
  );
  refused(
    tamper((p) => ((bodyOf(p)['params'] as Json)['address'] = MARKET), typed),
    TYPED,
    /params also carries address/,
  );
  refused(
    tamper((p) => (bodyOf(p)['params'] = {}), typed),
    TYPED,
    /missing typed_data/,
  );
  refused(
    tamper((p) => ((bodyOf(p)['params'] as Json)['typed_data'] = '{}'), typed),
    TYPED,
    /typed data is not an object/,
  );
});

test('typed data: the header and URL rules apply too', () => {
  refused(
    tamper((p) => delete p.headers['privy-idempotency-key'], typedPayload()),
    TYPED,
    /no idempotency key/,
  );
  refused(
    tamper((p) => (p.url = 'https://api.privy.io/v1/wallets/other/rpc'), typedPayload()),
    TYPED,
    /not from your wallet/,
  );
});
