/**
 * Moving funds out of the user's own wallet, with the device key (SEN-42) — and,
 * before that, reading what is being moved.
 *
 * The API cannot spend from this wallet: its owner is the key quorum holding
 * this phone's `device` key (SEN-40), so only a request this phone signed is
 * accepted. The flow is prepare → verify → sign → execute → confirm, and **the
 * verify step is the whole point**.
 *
 * `signPrivyAuthorization` is a blind signer: it signs the bytes it is handed.
 * Signing a payload the server composed would make this key a rubber stamp —
 * the server could hand over a transfer to an address the user never typed, or
 * for ten times the amount, and the enclave would accept it, because the enclave
 * checks the signature, not our intent. So the phone REBUILDS the request from
 * the intent it is approving, and refuses to sign anything else. This is
 * `agents/approval.ts#verifyPolicyPatch` for a send.
 *
 * ## What is checked, exactly
 *
 * Against `payload`, which is what the signature covers:
 *
 * 1. `version` is 1 and `method` is `POST` — nothing else is ever signed here.
 * 2. `url` is `https://api.privy.io/v1/wallets/<this wallet's id>/rpc`,
 *    character for character. Another wallet id would spend somebody else's
 *    funds; another host would be a different API.
 * 3. `headers` carries only `privy-app-id` (and, if present, an idempotency
 *    key), because the headers are signed too.
 * 4. `body` has exactly the four keys a sponsored send has, and no others.
 * 5. `method` is `eth_sendTransaction`, `caip2` is `eip155:10143` (Monad
 *    testnet, so a transfer cannot be replayed onto another chain by asking for
 *    it there), and `sponsor` is `true`.
 * 6. `params.transaction` is EXACTLY what this phone builds from the token, the
 *    recipient and the amount on screen: the same `to`, the same calldata, the
 *    same value, the same `chain_id`, and no extra keys. An ERC-20 transfer
 *    carries `data` and no `value`; native MON carries `value` and no `data`.
 *
 * The comparison is over the rebuilt object as a whole rather than field by
 * field, so a key nobody thought of cannot arrive unnoticed: `gas` or `nonce`
 * added to the transaction would fail this check, which is the right direction
 * to be wrong in.
 *
 * Plain TS, no React Native: `send.test.ts` runs under plain node.
 */
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
} from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import {
  ALLOWED_HEADERS,
  NoDeviceKeyError,
  PRIVY_API_BASE,
  refuse,
  type Approver,
  type VerifyResult,
} from '../auth/privyApproval.ts';
import { isNativeToken } from '../agents/fund.ts';
import { MANDATE_CHAIN_ID } from '../agents/api.ts';
import type { Token } from '../agents/mandate.ts';
import { asError, WalletApiError, type SendResponse, type WalletApi } from './api.ts';
import { readApiStatus, waitForUserOperation, type ConfirmationResult } from './confirmation.ts';

/**
 * Monad testnet, as Privy's RPC names a chain — the app's one chain id, so a
 * send and a mandate can never be for different chains.
 */
export const SEND_CHAIN_ID = MANDATE_CHAIN_ID;
export const SEND_CAIP2 = `eip155:${SEND_CHAIN_ID}` as const;

/** The keys a sponsored send body has. Exactly these, in any order. */
const BODY_KEYS = ['method', 'caip2', 'sponsor', 'params'];

/** What this phone believes it is sending. */
export type SendIntent = {
  /** Privy's id for the user's wallet — `GET /wallet` answers with it. */
  walletId: string;
  token: Token;
  to: Address;
  /** Atoms. What the amount field parsed to, never a decimal-shifted number. */
  atoms: bigint;
};

/** A hex quantity as Privy takes it: `0x`, lowercase, unpadded. */
function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * The `params.transaction` this intent means — the mirror of
 * `services/api/src/wallet/send/sponsored-send.ts#sponsoredTransferTransaction`.
 *
 * Mirrored rather than imported for the reason `agents/approval.ts` mirrors
 * `compileMandate`: the app does not import the API (and CLAUDE.md gotchas 2
 * and 10 keep it that way). `send.test.ts` pins the two shapes equal.
 */
export function sendTransaction(intent: SendIntent): Record<string, unknown> {
  const to = getAddress(intent.to);
  if (isNativeToken(intent.token)) {
    return { to, value: hexQuantity(intent.atoms), chain_id: SEND_CHAIN_ID };
  }
  return {
    // Checksummed: Privy compares `to` against a policy case-sensitively, so
    // one casing has to be the canonical one, and this is it.
    to: getAddress(intent.token.address),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, intent.atoms] }),
    chain_id: SEND_CHAIN_ID,
  };
}

/** The whole Privy RPC body this intent means. */
export function sendBody(intent: SendIntent): Record<string, unknown> {
  return {
    method: 'eth_sendTransaction',
    caip2: SEND_CAIP2,
    sponsor: true,
    params: { transaction: sendTransaction(intent) },
  };
}

/**
 * Does `payload` do exactly what `intent` says, and nothing else?
 *
 * The one question worth asking before signing. See the module header for the
 * list; every `false` here is a refusal to sign, not a warning.
 */
export function verifySendPayload(payload: AuthorizationPayload, intent: SendIntent): VerifyResult {
  if (payload.version !== 1) return refuse(`the payload is version ${String(payload.version)}`);
  if (payload.method !== 'POST') return refuse(`it is a ${payload.method}, not a send`);

  const expectedUrl = `${PRIVY_API_BASE}/v1/wallets/${intent.walletId}/rpc`;
  if (payload.url !== expectedUrl) {
    return refuse(`it spends from ${payload.url}, not from your wallet`);
  }

  const headers = Object.keys(payload.headers ?? {});
  const unexpected = headers.filter((name) => !ALLOWED_HEADERS.includes(name));
  if (unexpected.length > 0)
    return refuse(`it carries unexpected headers: ${unexpected.join(', ')}`);
  if (!payload.headers['privy-app-id']) return refuse('it names no Privy app');

  const body = payload.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse('its body is not a send');
  }
  const extra = Object.keys(body as Record<string, unknown>).filter(
    (key) => !BODY_KEYS.includes(key),
  );
  if (extra.length > 0) return refuse(`its body also carries ${extra.join(', ')}`);

  const { method, caip2, sponsor, params } = body as Record<string, unknown>;
  if (method !== 'eth_sendTransaction') return refuse(`it calls ${String(method)}`);
  if (caip2 !== SEND_CAIP2) return refuse(`it is for chain ${String(caip2)}, not Monad testnet`);
  // Not sponsored means the wallet pays its own gas, and it holds no MON: the
  // send would fail. It also means somebody changed the deal after the fact.
  if (sponsor !== true) return refuse('it does not ask for sponsored gas');

  if (typeof params !== 'object' || params === null) return refuse('it carries no transaction');
  const transaction = (params as { transaction?: unknown }).transaction;
  const mine = sendTransaction(intent);
  if (!sameTransaction(transaction, mine)) {
    return refuse(`it sends ${describeTransaction(transaction)}, not ${describeTransaction(mine)}`);
  }
  return { ok: true };
}

/**
 * Field-for-field equality over the transaction, with no key unexamined.
 *
 * Deliberately not a JSON comparison: key ORDER must not matter (the signature
 * is over RFC 8785 canonical bytes, which sort), while a key we do not build
 * must matter — so the two key sets are compared as sets and every value as a
 * string.
 */
function sameTransaction(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const theirs = actual as Record<string, unknown>;
  const keys = Object.keys(theirs);
  const mine = Object.keys(expected);
  if (keys.length !== mine.length || !mine.every((key) => keys.includes(key))) return false;
  return mine.every((key) => {
    const left = theirs[key];
    const right = expected[key];
    // Addresses come back checksummed either way, but comparing them as
    // addresses says what is meant and survives a casing change at either end.
    if (key === 'to' && typeof left === 'string' && typeof right === 'string') {
      return isAddress(left) && isAddress(right) && isAddressEqual(left, right);
    }
    return String(left) === String(right);
  });
}

function describeTransaction(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'nothing recognisable';
  const transaction = value as Record<string, unknown>;
  return `${String(transaction['value'] ?? transaction['data'] ?? '?')} to ${String(transaction['to'])}`;
}

/** A transfer the phone refused to sign, with the reason in the message. */
export class SendApprovalRefusedError extends Error {
  readonly problem: string;

  constructor(problem: string) {
    super(
      `This transfer doesn’t match what you asked for, so it wasn’t signed: ${problem}. ` +
        'Nothing was sent.',
    );
    this.name = 'SendApprovalRefusedError';
    this.problem = problem;
  }
}

// Shared with the mandate-approval flow (`agents/approval.ts`): the envelope
// rules, the refusal shape, and ONE "no device key" error, so `instanceof` means
// the same thing in both. Re-exported for this module's callers.
export { NoDeviceKeyError, type Approver, type VerifyResult };

export type SentTransfer = SendResponse & {
  /** How it settled, when there was a user operation to follow. */
  confirmation?: ConfirmationResult;
};

export type SendOptions = {
  /** Injectable for tests. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Prepare, verify, sign, execute, confirm — the whole send.
 *
 * Confirmation reads the USER OPERATION's own status (gotcha 8): a sponsored
 * send is bundled, so the carrying transaction succeeding says nothing about
 * whether the transfer executed. A timeout comes back as `pending`, never as a
 * failure — the money may well have moved.
 */
export async function sendSponsored(
  api: WalletApi,
  intent: SendIntent,
  sign: Approver | null,
  options: SendOptions = {},
): Promise<SentTransfer> {
  if (!sign) throw new NoDeviceKeyError('sending funds');
  const prepared = await api.prepareSend({
    to: intent.to,
    token: intent.token.address,
    amount: intent.atoms.toString(),
  });

  const verdict = verifySendPayload(prepared.payload, intent);
  if (!verdict.ok) throw new SendApprovalRefusedError(verdict.problem);

  const sent = await api.executeSend(prepared.prepareId, sign(prepared.payload));
  if (!sent.userOpHash) return sent;

  // The same API source the Kernel path races its bundler against: a 404 there
  // is a real answer ("no record of this hash"), and anything else is transient
  // and must not settle the race.
  const confirmation = await waitForUserOperation(
    sent.userOpHash,
    { api: (hash) => readApiStatus(api, hash) },
    {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  );
  return { ...sent, confirmation };
}

/**
 * Plain-language copy for anything that can stop a send — the two local
 * refusals first, then the API's own reasons.
 *
 * The refused-here case is deliberately not softened: the user asked to send
 * one thing and the server proposed another, and they should read that as what
 * it is rather than as a network hiccup.
 */
export function describeSendError(error: unknown): { title: string; detail: string } {
  if (error instanceof SendApprovalRefusedError) {
    return { title: 'This phone refused to sign it', detail: error.message };
  }
  if (error instanceof NoDeviceKeyError) {
    return { title: 'Sign in first', detail: error.message };
  }
  if (error instanceof WalletApiError) {
    switch (error.reason) {
      case 'send_recipient_not_allowed':
        return {
          title: 'That recipient isn’t allowed',
          detail: 'You can only send to your own wallet or to an agent you hired.',
        };
      case 'send_token_not_supported':
        return { title: 'That token can’t be sent', detail: 'Pick one of the listed tokens.' };
      case 'send_amount_invalid':
        return { title: 'Check the amount', detail: 'Enter an amount above zero.' };
      case 'send_prepare_not_found':
        return {
          title: 'This transfer expired',
          detail: 'Approvals are single-use and last five minutes. Enter the amount again.',
        };
      case 'invalid_authorization':
        return {
          title: 'Your passkey signature wasn’t accepted',
          detail: 'Sign in again on the device that owns this wallet, then retry.',
        };
      case 'account_not_registered':
        return {
          title: 'No wallet yet',
          detail: 'Sign in on the home screen and wait for your wallet to register.',
        };
      default:
        return { title: 'The transfer didn’t go through', detail: error.message };
    }
  }
  return { title: 'The transfer didn’t go through', detail: asError(error).message };
}
