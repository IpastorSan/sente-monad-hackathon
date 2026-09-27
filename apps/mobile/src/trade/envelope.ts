/**
 * Phone envelope verifier (SEN-86, plan M-T4).
 *
 * Every trade step reaches the phone as a server-composed Privy
 * `AuthorizationPayload`, and the device key signs whatever bytes it is handed
 * (`auth/deviceKey.ts`). This module checks everything in that payload EXCEPT
 * what the transaction does: the request line, the headers, and the shape of
 * the body. What survives is `params`, handed on to the call decoder
 * (`calls.ts`) and the venue verifiers. See docs/design/trading/plan-trading.md,
 * Architecture §1 "Phone checks → Envelope".
 *
 * It is a stricter copy of `wallet/send.ts#verifySendPayload`:
 *
 * - The idempotency key is REQUIRED and must equal the one this phone chose
 *   (`sente-trade:<clientTradeId>:<stepIndex>`). It is signed into the headers,
 *   so Privy runs a given step at most once in 24h; a payload without it, or
 *   with another step's key, could be replayed or swapped.
 * - Every key at every level is accounted for: body, `params` and
 *   `params.transaction`. An unknown key is a refusal, never ignored — an
 *   `authorization_list` or a `gas` nobody asked for is exactly what a
 *   compromised server would add.
 * - The transaction is held to the exact bytes the server's
 *   `sponsoredCallTransaction` emits: checksummed `to`, hex `data`,
 *   `chain_id: 10143`, and `value` only when non-zero, as canonical hex. Any
 *   other spelling is not something our server produces, so it is refused.
 *
 * Plain TS, no React Native: `envelope.test.ts` runs under plain node.
 */
import { getAddress, isAddress, isHex } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { ALLOWED_HEADERS, PRIVY_API_BASE, refuse } from '../auth/privyApproval.ts';
import { SEND_CAIP2, SEND_CHAIN_ID } from '../wallet/send.ts';

export type TradeRpcMethod = 'eth_sendTransaction' | 'eth_signTypedData_v4';

export type TradeEnvelopeExpectation = {
  /** Privy's id for the user's wallet — the only wallet a trade may spend from. */
  walletId: string;
  /** The key this phone chose for this step; see {@link tradeIdempotencyKey}. */
  idempotencyKey: string;
  rpcMethod: TradeRpcMethod;
};

export type EnvelopeResult =
  { ok: true; params: Record<string, unknown> } | { ok: false; problem: string };

/** Keys of a sponsored send body. Exactly these, all present. */
const SEND_BODY_KEYS = ['method', 'caip2', 'sponsor', 'params'];
/** Keys of a typed-data signing body. Exactly these, all present. */
const TYPED_DATA_BODY_KEYS = ['method', 'params'];
/** Keys `sponsoredCallTransaction` always emits; `value` is the one optional extra. */
const TRANSACTION_KEYS = ['to', 'data', 'chain_id'];
/** Non-zero, unpadded, lowercase: the only way the server writes a value. */
const CANONICAL_NONZERO_HEX = /^0x[1-9a-f][0-9a-f]*$/;

/**
 * The idempotency key for one step of one trade.
 *
 * Built from phone-chosen parts only, so the server cannot steer two steps onto
 * one key (Privy would then drop the second) or reuse an old trade's key.
 */
export function tradeIdempotencyKey(clientTradeId: string, stepIndex: number): string {
  return `sente-trade:${clientTradeId}:${stepIndex}`;
}

/**
 * Is `p` a Privy request this phone may sign for the expected step, and if so,
 * what are its `params`?
 *
 * Only the envelope is judged here; `params` still has to pass the call
 * decoder and the venue checks before anything is signed.
 */
export function verifyTradeEnvelope(
  p: AuthorizationPayload,
  e: TradeEnvelopeExpectation,
): EnvelopeResult {
  if (!isRecord(p)) return refuse('it is not a Privy request');
  if (p.version !== 1) return refuse(`the payload is version ${String(p.version)}`);
  if (p.method !== 'POST') return refuse(`it is a ${String(p.method)}, not a trade`);

  // An empty wallet id would still yield a well-formed-looking URL; fail closed.
  if (!e.walletId) return refuse('no wallet to trade from');
  const expectedUrl = `${PRIVY_API_BASE}/v1/wallets/${e.walletId}/rpc`;
  if (p.url !== expectedUrl) return refuse(`it trades from ${String(p.url)}, not from your wallet`);

  const headersProblem = checkHeaders(p.headers, e.idempotencyKey);
  if (headersProblem) return refuse(headersProblem);

  const body = p.body;
  if (!isRecord(body)) return refuse('its body is not a Privy call');
  if (body['method'] !== e.rpcMethod) {
    return refuse(`it calls ${String(body['method'])}, not ${e.rpcMethod}`);
  }

  return e.rpcMethod === 'eth_sendTransaction' ? checkSendBody(body) : checkTypedDataBody(body);
}

function checkHeaders(headers: unknown, idempotencyKey: string): string | undefined {
  if (!isRecord(headers)) return 'it carries no headers';
  const extra = Object.keys(headers).filter((name) => !ALLOWED_HEADERS.includes(name));
  if (extra.length > 0) return `it carries unexpected headers: ${extra.join(', ')}`;
  const appId = headers['privy-app-id'];
  if (typeof appId !== 'string' || appId === '') return 'it names no Privy app';
  // Refuse an empty expectation too: `'' === ''` would otherwise accept a
  // payload that carries no replay protection at all.
  if (!idempotencyKey) return 'this step has no idempotency key to check against';
  const key = headers['privy-idempotency-key'];
  if (key === undefined) return 'it carries no idempotency key, so it could run twice';
  if (key !== idempotencyKey) return `its idempotency key ${String(key)} is not this step's`;
  return undefined;
}

function checkSendBody(body: Record<string, unknown>): EnvelopeResult {
  const keysProblem = exactKeys(body, SEND_BODY_KEYS, 'its body');
  if (keysProblem) return refuse(keysProblem);
  if (body['caip2'] !== SEND_CAIP2) {
    return refuse(`it is for chain ${String(body['caip2'])}, not Monad testnet`);
  }
  // Unsponsored gas would come from the wallet's MON, which the user never
  // agreed to spend on this — and it means the deal changed after the fact.
  if (body['sponsor'] !== true) return refuse('it does not ask for sponsored gas');

  const params = body['params'];
  if (!isRecord(params)) return refuse('it carries no transaction');
  const paramsProblem = exactKeys(params, ['transaction'], 'its params');
  if (paramsProblem) return refuse(paramsProblem);

  const transactionProblem = checkTransaction(params['transaction']);
  if (transactionProblem) return refuse(transactionProblem);
  return { ok: true, params };
}

/** The exact shape of `sponsoredCallTransaction(to, data, value?)`, and nothing else. */
function checkTransaction(transaction: unknown): string | undefined {
  if (!isRecord(transaction)) return 'it carries no transaction';
  const hasValue = Object.hasOwn(transaction, 'value');
  const keysProblem = exactKeys(
    transaction,
    hasValue ? [...TRANSACTION_KEYS, 'value'] : TRANSACTION_KEYS,
    'its transaction',
  );
  if (keysProblem) return keysProblem;

  const to = transaction['to'];
  // Checksummed exactly: Privy matches `to` case-sensitively against policies,
  // and the server always checksums, so another casing is not our server's.
  if (typeof to !== 'string' || !isAddress(to, { strict: false }) || getAddress(to) !== to) {
    return `its target ${String(to)} is not a checksummed address`;
  }
  const data = transaction['data'];
  if (typeof data !== 'string' || !isHex(data, { strict: true }) || data.length % 2 !== 0) {
    return 'its calldata is not hex bytes';
  }
  if (transaction['chain_id'] !== SEND_CHAIN_ID) {
    return `it is for chain id ${String(transaction['chain_id'])}, not Monad testnet`;
  }
  // `0x0` or a padded value is different signed bytes from what the server
  // emits (it omits a zero value), so either means someone else built this.
  if (hasValue) {
    const value = transaction['value'];
    if (typeof value !== 'string' || !CANONICAL_NONZERO_HEX.test(value)) {
      return `its value ${String(value)} is not a canonical non-zero amount`;
    }
  }
  return undefined;
}

function checkTypedDataBody(body: Record<string, unknown>): EnvelopeResult {
  const keysProblem = exactKeys(body, TYPED_DATA_BODY_KEYS, 'its body');
  if (keysProblem) return refuse(keysProblem);
  const params = body['params'];
  if (!isRecord(params)) return refuse('it carries no typed data');
  const paramsProblem = exactKeys(params, ['typed_data'], 'its params');
  if (paramsProblem) return refuse(paramsProblem);
  if (!isRecord(params['typed_data'])) return refuse('its typed data is not an object');
  return { ok: true, params };
}

/** Exactly `keys`, all present, nothing else — or a sentence saying what differs. */
function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): string | undefined {
  const actual = Object.keys(record);
  const extra = actual.filter((key) => !keys.includes(key));
  if (extra.length > 0) return `${what} also carries ${extra.join(', ')}`;
  const missing = keys.filter((key) => !actual.includes(key));
  if (missing.length > 0) return `${what} is missing ${missing.join(', ')}`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
