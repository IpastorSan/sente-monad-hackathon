/**
 * HTTP client for `services/api`'s `/wallet` routes.
 *
 * Deliberately dumb: it moves JSON and converts the decimal-string numeric
 * fields back into bigints. Every trust decision — is this the callData I
 * asked for, is this my sender — lives in `useSmartAccount.ts`, next to the
 * signature it protects.
 *
 * AUTH is the placeholder `x-sente-user-id` header the API's `gas/auth` seam
 * defines. MOV-251's real Mera session replaces it; until then the header is
 * forgeable, which is exactly why `POST /wallet/execute` also demands an
 * EIP-712 signature by the owner key (see the API's
 * `authorization/authorization.ts`).
 */
import type { Address, Hash, Hex } from 'viem';

/** Set to the machine's LAN IP on a physical device — the phone's localhost is the phone. */
const DEFAULT_API_URL = 'http://localhost:3000';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL;

/** Placeholder auth header. Replaced wholesale by MOV-251. */
export const USER_ID_HEADER = 'x-sente-user-id';

export type Erc7579CallRequest = {
  to: Address;
  value?: bigint;
  data?: Hex;
};

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
  /** Placeholder identity. Defaults to the owner address — see MOV-251. */
  userId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class WalletApi {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ userId, baseUrl = API_URL, fetchImpl = fetch }: WalletApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.userId = userId;
    this.fetchImpl = fetchImpl;
  }

  account(): Promise<WalletAccount> {
    return this.request<WalletAccount>('GET', '/wallet');
  }

  register(owner: Address): Promise<WalletAccount> {
    return this.request<WalletAccount>('POST', '/wallet/register', { owner });
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [USER_ID_HEADER]: this.userId,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

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
