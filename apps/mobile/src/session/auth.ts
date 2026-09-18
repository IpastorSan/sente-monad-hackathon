/**
 * Turning a live passkey session into an API session (SEN-37).
 *
 * The phone holds a key it re-derives from the passkey on every launch, and the
 * API holds no password. Sign-in is therefore a signature: ask for a challenge,
 * sign the exact string it returns with the Mera viem account, and swap the
 * signature for a bearer token.
 *
 * THE TOKEN IS NEVER PERSISTED. Not in `expo-secure-store`, not in state that
 * outlives the process: a stored token is a credential someone can lift off the
 * device, and this one is worth nothing to keep — the passkey re-derives the
 * key on the next launch, so signing in again costs one HTTP round trip and no
 * user interaction (the session key signs without a biometric prompt, see
 * `auth/mera.ts`).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { LocalAccount } from 'viem';

import { API_URL, type SessionAuth } from '@/wallet/api';

export type ChallengeResponse = {
  address: string;
  nonce: string;
  /** The exact text to sign. Never reconstructed on this side. */
  message: string;
  expiresAt: string;
};

export type SessionResponse = {
  address: string;
  token: string;
  expiresAt: string;
};

export class AuthApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
    this.reason = reason;
  }
}

export type AuthApiOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** The two public routes: `POST /auth/challenge` and `POST /auth/session`. */
export class AuthApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl = API_URL, fetchImpl = fetch }: AuthApiOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  challenge(address: string): Promise<ChallengeResponse> {
    return this.post<ChallengeResponse>('/auth/challenge', { address });
  }

  session(address: string, signature: string): Promise<SessionResponse> {
    return this.post<SessionResponse>('/auth/session', { address, signature });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      throw new AuthApiError(response.status, detail?.reason, message);
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
 * One round of sign-in: challenge, sign, exchange.
 *
 * `account.signMessage` is EIP-191 `personal_sign`, which is what the API
 * verifies with viem's `verifyMessage`. The message signed is the server's
 * verbatim string — there is no client-side format to drift.
 */
export async function requestSessionToken(
  account: LocalAccount,
  api: AuthApi,
): Promise<SessionResponse> {
  const challenge = await api.challenge(account.address);
  const signature = await account.signMessage({ message: challenge.message });
  return api.session(account.address, signature);
}

export type UseSessionAuthOptions = {
  /** Injectable for specs and for pointing at another API instance. */
  api?: AuthApi;
};

/**
 * A `SessionAuth` bound to the live passkey account.
 *
 * Single-flight: a burst of requests that all 401 at once shares one sign-in
 * rather than starting one each, which would mean one challenge per request and
 * a race over which token wins.
 */
export function useSessionAuth(
  account: LocalAccount | null,
  { api: injectedApi }: UseSessionAuthOptions = {},
): SessionAuth {
  const api = useMemo(() => injectedApi ?? new AuthApi(), [injectedApi]);
  const tokenRef = useRef<string | null>(null);
  const accountRef = useRef<LocalAccount | null>(account);
  const inFlightRef = useRef<Promise<string | null> | null>(null);

  // Signing out, or signing in as someone else, invalidates the token: it names
  // the previous address and must never be sent for the new one. Done during
  // render rather than in an effect so no request can slip through the gap
  // between the account changing and the effect running.
  if (accountRef.current?.address !== account?.address) {
    tokenRef.current = null;
    accountRef.current = account;
  }

  const refresh = useCallback(async (): Promise<string | null> => {
    const signer = accountRef.current;
    if (signer === null) return null;
    if (inFlightRef.current !== null) return inFlightRef.current;

    const attempt = requestSessionToken(signer, api)
      .then((session) => {
        // Discard a token that arrived after the user signed out or switched.
        if (accountRef.current?.address !== signer.address) return null;
        tokenRef.current = session.token;
        return session.token;
      })
      .catch(() => null)
      .finally(() => {
        inFlightRef.current = null;
      });

    inFlightRef.current = attempt;
    return attempt;
  }, [api]);

  // Sign in as soon as there is a key to sign with, so the first screen does
  // not have to spend a 401 discovering there is no session yet.
  useEffect(() => {
    if (account !== null && tokenRef.current === null) void refresh();
  }, [account, refresh]);

  return useMemo(
    () => ({
      token: () => tokenRef.current,
      refresh,
    }),
    [refresh],
  );
}
