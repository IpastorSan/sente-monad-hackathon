/**
 * React binding for the gas-sponsored Kernel smart account.
 *
 * Takes the Mera-derived viem account from `src/auth` and gives back a smart
 * account that can send a batch of calls behind a single signature, with gas
 * paid by a paymaster rather than by the user.
 *
 * ---------------------------------------------------------------------------
 * WHAT SIGNS WHAT
 *
 * The server builds the UserOperation, injects fees and sponsors gas; the
 * client is the only signer. Two signatures come out of one `sendCalls`, and
 * neither costs a biometric prompt because the Mera session key signs locally:
 *
 *   1. `signUserOperation` — Kernel's ECDSA validator checks this on chain.
 *   2. `signTypedData` over the authorization envelope — our API checks this,
 *      and it is what binds the request to an endpoint, a body and an owner.
 *
 * Before either, `assertCallDataMatches` re-encodes the batch locally and
 * refuses to sign anything that is not the batch the caller asked for. The
 * server can pick the fees; it cannot pick the recipients.
 * ---------------------------------------------------------------------------
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
} from 'viem';
import { createBundlerClient, getUserOperationHash } from 'viem/account-abstraction';

import { monadChain } from '../chain';
import {
  WalletApi,
  WalletApiError,
  toUserOperation,
  type Erc7579CallRequest,
  type SessionAuth,
  type WalletAccount,
} from './api';
import { assertCallDataMatches } from './batch';
import { waitForUserOperation, type ConfirmationResult } from './confirmation';
import { ENTRY_POINT, toSenteKernelAccount, type SenteKernelAccount } from './kernel';

/**
 * Optional PUBLIC bundler endpoint, used read-only for the receipt half of the
 * confirmation race.
 *
 * Keyless on purpose: `EXPO_PUBLIC_*` is inlined into the app bundle and is
 * therefore not secret by construction. The KEYED Pimlico URL (which is what
 * buys sponsorship) stays server-side, and submission goes through our API.
 * Leave this unset and the race simply runs on one source.
 */
const BUNDLER_URL = process.env.EXPO_PUBLIC_BUNDLER_URL || undefined;

/**
 * The session for a caller that has none: every request goes out unauthenticated
 * and the API answers 401. Used only when the hook runs with no `auth` and no
 * injected client, which is the state before sign-in.
 */
const SIGNED_OUT: SessionAuth = { token: () => null, refresh: () => Promise.resolve(null) };

export type SmartAccountStatus =
  /** No owner yet — the passkey session is not open. */
  | 'idle'
  /** Deriving the address and registering it with the API. */
  | 'deriving'
  /** Derived, registered, and able to send. */
  | 'ready'
  /** Derivation or registration failed; `error` says why. */
  | 'error';

export type SendCallsResult = ConfirmationResult & {
  prepareId: string;
  /** True only when a paymaster actually quoted this operation. */
  sponsored: boolean;
};

export type UseSmartAccount = {
  readonly status: SmartAccountStatus;
  /** The Kernel smart account address. Deterministic from the owner. */
  readonly address: Address | null;
  readonly ownerAddress: Address | null;
  /** Server's view: registered, deployed, and whether sponsorship is live. */
  readonly account: WalletAccount | null;
  readonly error: Error | null;
  /** True while a `sendCalls` is in flight. */
  readonly sending: boolean;
  /**
   * Runs a batch atomically behind one signature: prepare -> verify -> sign ->
   * execute -> await confirmation.
   */
  sendCalls: (calls: readonly Erc7579CallRequest[]) => Promise<SendCallsResult>;
  /** Re-reads the server's view (deployment state, sponsorship availability). */
  refresh: () => Promise<void>;
};

export type UseSmartAccountOptions = {
  /**
   * The API session (SEN-37). Required unless `api` is injected: the routes
   * this hook calls are all behind `SessionAuthGuard`, and the principal the
   * server resolves from the token is the owner it expects the envelope to be
   * signed by.
   */
  auth?: SessionAuth;
  /** Injectable for tests. */
  api?: WalletApi;
};

export function useSmartAccount(
  owner: LocalAccount | null,
  { auth, api: injectedApi }: UseSmartAccountOptions = {},
): UseSmartAccount {
  const [status, setStatus] = useState<SmartAccountStatus>('idle');
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  const kernelRef = useRef<SenteKernelAccount | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Read-only clients. Cheap to build, and stable for the lifetime of the hook. */
  const clients = useMemo(() => {
    const publicClient = createPublicClient({
      chain: monadChain,
      transport: http(process.env.EXPO_PUBLIC_MONAD_RPC_URL || undefined, { retryCount: 2 }),
    });
    // The Pimlico client, used ONLY to read receipts. Submission is the
    // server's job — it holds the keyed endpoint and the sponsorship policy.
    const bundlerClient = BUNDLER_URL
      ? createBundlerClient({ chain: monadChain, transport: http(BUNDLER_URL, { retryCount: 1 }) })
      : null;
    return { publicClient, bundlerClient };
  }, []);

  const api = useMemo(
    () => injectedApi ?? new WalletApi({ auth: auth ?? SIGNED_OUT }),
    [injectedApi, auth],
  );

  // Derive the account and bind it server-side whenever the owner changes.
  useEffect(() => {
    if (!owner) {
      kernelRef.current = null;
      setAccount(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('deriving');
    setError(null);

    void (async () => {
      try {
        const kernel = await toSenteKernelAccount({ client: clients.publicClient, owner });
        if (cancelled) return;
        kernelRef.current = kernel;

        // Idempotent for the same owner; the server refuses a DIFFERENT owner
        // for the same user rather than rebinding.
        const registered = await api.register(owner.address);
        if (cancelled) return;

        if (registered.address.toLowerCase() !== kernel.address.toLowerCase()) {
          // Client and server derive from the same pinned constants, so this
          // means one of them moved. Signing anyway would spend from an address
          // the user has never seen.
          throw new Error(
            `Smart account mismatch: derived ${kernel.address}, server says ${registered.address}`,
          );
        }
        setAccount(registered);
        setStatus('ready');
      } catch (caught) {
        if (cancelled) return;
        kernelRef.current = null;
        setError(asError(caught));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [owner, api, clients.publicClient]);

  const refresh = useCallback(async () => {
    if (status === 'idle') return;
    try {
      const fresh = await api.account();
      if (mountedRef.current) setAccount(fresh);
    } catch (caught) {
      if (mountedRef.current) setError(asError(caught));
    }
  }, [api, status]);

  const sendCalls = useCallback(
    async (calls: readonly Erc7579CallRequest[]): Promise<SendCallsResult> => {
      const kernel = kernelRef.current;
      if (!kernel || !owner) {
        throw new Error('Smart account is not ready; open a passkey session first');
      }
      if (calls.length === 0) {
        throw new Error('sendCalls needs at least one call');
      }

      setSending(true);
      try {
        // --- PREPARE ---------------------------------------------------
        const prepared = await api.prepare(calls, kernel.address);

        // --- VERIFY, before anything is signed --------------------------
        if (prepared.sender.toLowerCase() !== kernel.address.toLowerCase()) {
          throw new Error(`Server prepared an operation for ${prepared.sender}, not this account`);
        }
        if (prepared.owner.toLowerCase() !== owner.address.toLowerCase()) {
          throw new Error(`Server bound this account to ${prepared.owner}, not this owner key`);
        }
        // The check that matters: re-encode the batch locally and refuse to
        // sign anything else. Fees and gas are the server's to choose; the
        // recipients and amounts are not.
        assertCallDataMatches(calls, prepared.userOperation.callData);

        const userOperation = toUserOperation(prepared.userOperation);
        const localHash = getUserOperationHash({
          chainId: prepared.chainId,
          entryPointAddress: ENTRY_POINT.address,
          entryPointVersion: ENTRY_POINT.version,
          userOperation,
        });
        if (localHash.toLowerCase() !== prepared.userOpHash.toLowerCase()) {
          throw new Error('Server UserOperation hash does not match the operation it sent');
        }

        const envelope = prepared.authorization;
        if (
          envelope.message.userOpHash.toLowerCase() !== localHash.toLowerCase() ||
          envelope.message.sender.toLowerCase() !== kernel.address.toLowerCase() ||
          envelope.domain.chainId !== prepared.chainId
        ) {
          throw new Error('Authorization envelope does not describe this operation');
        }

        // --- SIGN -------------------------------------------------------
        // Both local: the Mera session key signs without a biometric prompt.
        const [userOpSignature, authorizationSignature] = await Promise.all([
          kernel.signUserOperation({
            ...userOperation,
            chainId: prepared.chainId,
          } as Parameters<typeof kernel.signUserOperation>[0]),
          owner.signTypedData({
            domain: envelope.domain,
            types: envelope.types,
            primaryType: envelope.primaryType,
            message: { ...envelope.message, expiresAt: BigInt(envelope.message.expiresAt) },
          } as Parameters<typeof owner.signTypedData>[0]),
        ]);

        // --- EXECUTE ----------------------------------------------------
        const submitted = await api.execute(
          prepared.prepareId,
          userOpSignature as Hex,
          authorizationSignature,
        );

        const bundlerClient = clients.bundlerClient;
        const confirmation = await waitForUserOperation(submitted.userOpHash, {
          api: (hash) => readApiStatus(api, hash),
          ...(bundlerClient ? { bundler: (hash) => readBundlerReceipt(bundlerClient, hash) } : {}),
        });

        // Deployment state flips on the first successful operation.
        if (confirmation.status === 'included' && account && !account.deployed) {
          void refresh();
        }

        return { ...confirmation, prepareId: prepared.prepareId, sponsored: submitted.sponsored };
      } finally {
        if (mountedRef.current) setSending(false);
      }
    },
    [api, owner, clients.bundlerClient, account, refresh],
  );

  return {
    status,
    address: account?.address ?? kernelRef.current?.address ?? null,
    ownerAddress: owner?.address ?? null,
    account,
    error,
    sending,
    sendCalls,
    refresh,
  };
}

async function readApiStatus(api: WalletApi, userOpHash: Hash) {
  try {
    const status = await api.status(userOpHash);
    return {
      status: status.status,
      ...(status.transactionHash ? { transactionHash: status.transactionHash } : {}),
      ...(status.blockNumber !== undefined ? { blockNumber: BigInt(status.blockNumber) } : {}),
      ...(status.actualGasCost !== undefined
        ? { actualGasCost: BigInt(status.actualGasCost) }
        : {}),
    };
  } catch (error) {
    // A 404 is a real answer ("we have no record"), but everything else is
    // transient and must not settle the race.
    if (error instanceof WalletApiError && error.status === 404) {
      return { status: 'unknown' as const };
    }
    return null;
  }
}

async function readBundlerReceipt(
  bundler: ReturnType<typeof createBundlerClient>,
  userOpHash: Hash,
) {
  try {
    const receipt = await bundler.getUserOperationReceipt({ hash: userOpHash });
    if (!receipt) return null;
    return {
      // `receipt.success` is the UserOperation's OWN flag. A bundle transaction
      // can succeed while the operation inside it reverted.
      status: receipt.success ? ('included' as const) : ('reverted' as const),
      transactionHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber,
      actualGasCost: receipt.actualGasCost,
    };
  } catch {
    // viem throws while the operation is still in the mempool. Normal.
    return null;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
