import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { isAddress, verifyMessage, type Address, type Hex } from 'viem';

import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { CHALLENGE_STORE, newChallenge, type ChallengeStore } from './challenge';
import { mintSessionToken } from './session-token';

/**
 * ---------------------------------------------------------------------------
 * SIGN-IN
 *
 * Two calls, and the second one is the whole security argument:
 *
 *   POST /auth/challenge {address}            -> {address, nonce, message, expiresAt}
 *   POST /auth/session   {address, signature} -> {address, token, expiresAt}
 *
 * The address alone proves nothing — it is public, and the placeholder header
 * this replaces was exactly "trust whoever names an address". A signature over
 * a server-chosen nonce proves the caller holds the passkey-derived key for it,
 * because only that key can produce one and the nonce was never seen before.
 *
 * The signature is verified with viem's `verifyMessage`, which recovers the
 * signer and compares. It also accepts an ERC-1271 contract signature when a
 * public client is supplied, which is deliberately not supplied here: the
 * principal is the user's Mera EOA (see CLAUDE.md), the same address agent
 * ownership records, and a contract that answers `isValidSignature` for itself
 * is not that.
 *
 * WHAT THIS IS NOT: Privy. Users sign in with their passkey; Privy holds agent
 * wallets, which are a different set of keys owned by the server.
 * ---------------------------------------------------------------------------
 */
export interface ChallengeView {
  address: Address;
  nonce: Hex;
  /** The exact string to sign. */
  message: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface SessionView {
  address: Address;
  /** Bearer credential for `authorization: Bearer <token>`. */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface AuthDescription {
  module: 'auth';
  mode: AuthConfig['mode'];
  sessionTtlS: number;
  challengeTtlS: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CHALLENGE_STORE) private readonly challenges: ChallengeStore,
  ) {}

  /** How this API authenticates, for a client that wants to know. No secrets. */
  describe(): AuthDescription {
    return {
      module: 'auth',
      mode: this.config.mode,
      sessionTtlS: this.config.sessionTtlS,
      challengeTtlS: this.config.challengeTtlS,
    };
  }

  async challenge(addressInput: string, now: Date = new Date()): Promise<ChallengeView> {
    const address = parseAddress(addressInput);
    const challenge = newChallenge(address, this.config.challengeTtlS, now);
    await this.challenges.put(challenge);

    return {
      address,
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  /**
   * Verifies a signed challenge and mints a session token.
   *
   * Refusals say as little as possible. An unknown nonce, an expired one and a
   * second use of the same one all answer `challenge_not_found`, because
   * telling a caller which of those it hit is telling them what to try next.
   */
  async session(
    addressInput: string,
    signature: Hex,
    now: Date = new Date(),
  ): Promise<SessionView> {
    const address = parseAddress(addressInput);
    const challenge = await this.challenges.take(address, now);
    if (!challenge) {
      throw refusal('challenge_not_found', 'No outstanding challenge for this address');
    }

    const valid = await verifyMessage({ address, message: challenge.message, signature });
    if (!valid) {
      // The challenge is spent either way — see `InMemoryChallengeStore.take`.
      this.logger.warn(`Rejected a signature that did not recover to ${address}`);
      throw refusal('bad_signature', 'Signature does not recover to this address');
    }

    const expiresAtS = Math.floor(now.getTime() / 1000) + this.config.sessionTtlS;
    return {
      address,
      // `sub` is the lowercase address: the same userId every record is keyed
      // by, so a checksum difference can never split one user into two.
      token: mintSessionToken(this.config.sessionSecret, {
        sub: address.toLowerCase(),
        exp: expiresAtS,
      }),
      expiresAt: new Date(expiresAtS * 1000).toISOString(),
    };
  }
}

function parseAddress(input: string): Address {
  if (!isAddress(input, { strict: false })) {
    throw refusal('bad_address', 'address must be a 20-byte hex EVM address');
  }
  return input as Address;
}

function refusal(reason: string, message: string): UnauthorizedException {
  return new UnauthorizedException({ statusCode: 401, reason, message });
}
