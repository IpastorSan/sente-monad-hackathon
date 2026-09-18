/**
 * HTTP client for `services/api`'s `/wallet` routes.
 *
 * Deliberately dumb: it moves JSON and converts the decimal-string numeric
 * fields back into bigints. Every trust decision — is this the callData I
 * asked for, is this my sender — lives in `useSmartAccount.ts`, next to the
 * signature it protects.
 *
 * AUTH is the session token from `session/auth.ts` (SEN-37), sent as
 * `authorization: Bearer <token>`. `POST /wallet/execute` still demands an
 * EIP-712 signature by the owner key on top of it (see the API's
 * `authorization/authorization.ts`): the token says who is calling, the
 * envelope says the owner approved this exact operation.
 *
 * TWO ACCOUNTS LIVE BEHIND `/wallet`, and they are not the same thing:
 *
 * - `GET /wallet` and `POST /wallet/register` are the USER'S WALLET — the Privy
 *   server wallet whose owner is this phone's device key (SEN-40). This is the
 *   account the home screen shows and the one that holds the user's funds.
 * - `/wallet/kernel*`, `prepare`, `execute` and `operations` are the older
 *   Kernel smart account, kept reachable until SEN-45 retires it. SEN-40 moved
 *   its two account routes under `/wallet/kernel` precisely so the plain ones
 *   could become the Privy wallet's; a client left on the old paths does not
 *   404, it posts an owner address to a route that wants a device key.
 */
import type { Address, Hash, Hex } from 'viem';

/** Set to the machine's LAN IP on a physical device — the phone's localhost is the phone. */
const DEFAULT_API_URL = 'http://localhost:3000';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL;

/**
 * The bearer token these clients send, and how to get a fresh one.
 *
 * An indirection rather than a string because a session expires: the client
 * reads the token per request and, on a 401, asks for a new one exactly once.
 * `session/auth.ts` implements it against `POST /auth/challenge` and
 * `POST /auth/session`; a spec can implement it in two lines.
 */
export type SessionAuth = {
  /** The current token, or `null` when the user is not signed in. */
  token(): string | null;
  /** Signs in again. Resolves to the new token, or `null` if it could not. */
  refresh(): Promise<string | null>;
};

/**
 * The session for a caller that has none: every request goes out without a
 * token and the API answers 401, which is the honest answer. Shared by the
 * hooks so there is one definition of "signed out" to keep in step with
 * {@link SessionAuth}.
 */
export const SIGNED_OUT: SessionAuth = { token: () => null, refresh: () => Promise.resolve(null) };

/** Whatever was thrown, as an `Error`. React state needs one shape, not two. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export type Erc7579CallRequest = {
  to: Address;
  value?: bigint;
  data?: Hex;
};

/** The Kernel smart account's server-side view. On its way out (SEN-45). */
export type WalletAccount = {
  userId: string;
  owner: Address;
  address: Address;
  deployed: boolean;
  chainId: number;
  entryPoint: Address;
  /** Whether the API has a paymaster configured AND willing. Never optimistic. */
  sponsorshipAvailable: boolean;
};

/** One token's balance as the API sends it: both numbers are decimal strings. */
export type WireTokenBalance = {
  symbol: string;
  /** The ERC-20, or the zero address for native MON. */
  address: Address;
  decimals: number;
  raw: string;
  amount: string;
};

export type TokenBalance = {
  symbol: string;
  address: Address;
  decimals: number;
  /** Atoms. The figure to format from — `amount` is for reading, not maths. */
  raw: bigint;
  /** The server's decimal-shifted form, e.g. `"1.5"`. Never lossy. */
  amount: string;
};

export type WireUserWallet = {
  userId: string;
  walletId: string;
  address: Address;
  ownerQuorumId: string;
  devicePublicKey: string;
  chainId: number;
  createdAt: string;
  balances: WireTokenBalance[];
};

/** The user's Privy wallet (SEN-40): what `GET /wallet` answers, in bigints. */
export type UserWallet = Omit<WireUserWallet, 'balances'> & {
  /** MON, USDC and AUSD, in the order the API sends them. */
  balances: TokenBalance[];
};

export type WireUserOperation = {
  sender: Address;
  nonce: string;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: Address;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: Hex;
  signature: Hex;
};

export type WireAuthorization = {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: {
    method: string;
    path: string;
    owner: Address;
    sender: Address;
    userOpHash: Hash;
    bodyHash: Hex;
    nonce: Hex;
    expiresAt: string;
  };
};

export type PrepareResponse = {
  prepareId: string;
  chainId: number;
  entryPoint: Address;
  sender: Address;
  owner: Address;
  userOperation: WireUserOperation;
  userOpHash: Hash;
  sponsored: boolean;
  expiresAt: string;
  authorization: WireAuthorization;
};

export type ExecuteResponse = {
  userOpHash: Hash;
  status: OperationStatusResponse['status'];
  sponsored: boolean;
};

export type OperationStatusResponse = {
  userOpHash: Hash;
  status: 'pending' | 'included' | 'reverted' | 'unknown';
  transactionHash?: Hash;
  blockNumber?: string;
  actualGasCost?: string;
  sender?: Address;
  sponsored?: boolean;
};

/** A non-2xx response, carrying the API's stable `reason` when it sent one. */
export class WalletApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'WalletApiError';
    this.status = status;
    this.reason = reason;
  }
}

export type WalletApiOptions = {
  /** The session token source. Every request carries its token. */
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class WalletApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  constructor({ auth, baseUrl = API_URL, fetchImpl = fetch }: WalletApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** The user's Privy wallet and its balances. 404 (`account_not_registered`) until registered. */
  async account(): Promise<UserWallet> {
    return toUserWallet(await this.request<WireUserWallet>('GET', '/wallet'));
  }

  /**
   * Creates the user's Privy wallet with this phone's device key as its owner,
   * and answers with the same object `account()` does.
   *
   * Idempotent for the same key, so it is safe to call on every sign-in — which
   * is what the app does, because the registry is the only thing that remembers
   * which Privy wallet is this user's. A DIFFERENT key for a known user is
   * refused with `device_key_mismatch` rather than minting a second wallet.
   */
  async register(devicePublicKey: string): Promise<UserWallet> {
    return toUserWallet(
      await this.request<WireUserWallet>('POST', '/wallet/register', { devicePublicKey }),
    );
  }

  /** The Kernel smart account. Kept reachable until SEN-45 retires it. */
  kernelAccount(): Promise<WalletAccount> {
    return this.request<WalletAccount>('GET', '/wallet/kernel');
  }

  /** Binds the caller to their Mera owner key. Kernel only; see `kernelAccount`. */
  registerKernel(owner: Address): Promise<WalletAccount> {
    return this.request<WalletAccount>('POST', '/wallet/kernel/register', { owner });
  }

  prepare(calls: readonly Erc7579CallRequest[], sender: Address): Promise<PrepareResponse> {
    return this.request<PrepareResponse>('POST', '/wallet/prepare', {
      // The server resolves the sender canonically from the authenticated user
      // and only COMPARES this one. Sending it is how the client finds out its
      // cached address has drifted, rather than silently signing for it.
      sender,
      calls: calls.map((call) => ({
        to: call.to,
        ...(call.value !== undefined ? { value: call.value.toString() } : {}),
        ...(call.data !== undefined ? { data: call.data } : {}),
      })),
    });
  }

  execute(
    prepareId: string,
    userOpSignature: Hex,
    authorizationSignature: Hex,
  ): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>('POST', '/wallet/execute', {
      prepareId,
      userOpSignature,
      authorizationSignature,
    });
  }

  status(userOpHash: Hash): Promise<OperationStatusResponse> {
    return this.request<OperationStatusResponse>('GET', `/wallet/operations/${userOpHash}`);
  }

  /**
   * One request, and at most one silent re-authentication.
   *
   * A session outlives most screens but not every app launch, and the 401 that
   * ends it arrives in the middle of whatever the user was doing. Retrying once
   * with a fresh token turns that into a pause; retrying more would turn a
   * genuinely unauthorised call into a loop of sign-in prompts.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.auth.token();
    // No token YET is not the same as an expired one, and it is the normal
    // state for the first request after sign-in: the passkey session opens and
    // every client starts before the challenge/response exchange has landed.
    // Sending anyway would spend a round trip on a guaranteed 401. `refresh()`
    // is single-flight, so the clients that start together share one sign-in.
    if (token === null) {
      return this.read<T>(await this.send(method, path, body, await this.auth.refresh()));
    }

    const first = await this.send(method, path, body, token);
    if (first.status !== 401) return this.read<T>(first);

    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read<T>(first);
    return this.read<T>(await this.send(method, path, body, refreshed));
  }

  private send(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? text ?? response.statusText);
      throw new WalletApiError(response.status, detail?.reason, message);
    }
    return parsed as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Wire -> the app's view: balances become bigints.
 *
 * `amount` is kept as the server sent it rather than re-derived here. The API
 * shifts it with viem's `formatUnits` from the same `raw`, so recomputing it
 * would buy nothing and could disagree; `raw` is what any arithmetic (a max
 * button, a "can I afford this") has to use.
 */
export function toUserWallet(wire: WireUserWallet): UserWallet {
  return {
    ...wire,
    balances: wire.balances.map((balance) => ({ ...balance, raw: BigInt(balance.raw) })),
  };
}

/**
 * One token's balance by symbol, or `null` when the API did not send it.
 *
 * Nullable rather than a zero: a token missing from the response means the
 * server's token list moved, and "0.00 AUSD" is exactly the confident lie
 * `token-balances.ts` warns about. The screen says so instead.
 */
export function balanceOf(wallet: UserWallet | null, symbol: string): TokenBalance | null {
  return wallet?.balances.find((balance) => balance.symbol === symbol) ?? null;
}

/** Wire (decimal strings) -> viem's UserOperation (bigints). */
export function toUserOperation(wire: WireUserOperation) {
  return {
    sender: wire.sender,
    nonce: BigInt(wire.nonce),
    callData: wire.callData,
    callGasLimit: BigInt(wire.callGasLimit),
    verificationGasLimit: BigInt(wire.verificationGasLimit),
    preVerificationGas: BigInt(wire.preVerificationGas),
    maxFeePerGas: BigInt(wire.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(wire.maxPriorityFeePerGas),
    signature: wire.signature,
    ...(wire.factory ? { factory: wire.factory, factoryData: wire.factoryData } : {}),
    ...(wire.paymaster
      ? {
          paymaster: wire.paymaster,
          paymasterData: wire.paymasterData,
          ...(wire.paymasterVerificationGasLimit !== undefined
            ? { paymasterVerificationGasLimit: BigInt(wire.paymasterVerificationGasLimit) }
            : {}),
          ...(wire.paymasterPostOpGasLimit !== undefined
            ? { paymasterPostOpGasLimit: BigInt(wire.paymasterPostOpGasLimit) }
            : {}),
        }
      : {}),
  };
}
