import { keccak256, stringToHex, verifyTypedData, type Address, type Hash, type Hex } from 'viem';

/**
 * ---------------------------------------------------------------------------
 * THE AUTHORIZATION ENVELOPE
 *
 * The server orchestrates and the client is the only signer, and those two
 * sound contradictory until the signature is bound to exactly what gets
 * submitted. Two signatures come back from the client for one user action:
 *
 *   1. The UserOperation signature. Consumed on-chain by Kernel's ECDSA
 *      validator. It covers sender, nonce, callData, every gas field and the
 *      paymaster fields, so the server cannot alter the operation after the
 *      user approved it.
 *   2. This envelope. Consumed by us. It covers the ENDPOINT, the request body
 *      and the operation hash, and it is signed by the owner key — which is
 *      what lets the server tell that the caller really holds the key for the
 *      account it is about to spend from.
 *
 * WHY THE SECOND ONE EXISTS. The UserOperation signature says nothing about
 * which HTTP call carried it, and today's `x-sente-user-id` guard is a
 * placeholder header anyone can set. Binding `method`, `path` and `bodyHash`
 * means a signature harvested from one route cannot be replayed at another, and
 * binding `owner` and `sender` means a forged header cannot spend someone
 * else's account: the recovered address has to match the owner the server
 * itself resolved. Ported in shape from the Charms AA work, where the
 * equivalent payload was a fully-specified HTTP request to Privy's wallet RPC.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: fees and gas. Those are the server's to
 * inject and the paymaster's to pay, and they are already inside `userOpHash`.
 * ---------------------------------------------------------------------------
 */

export const AUTHORIZATION_DOMAIN_NAME = 'Sente Wallet';
export const AUTHORIZATION_DOMAIN_VERSION = '1';
export const AUTHORIZATION_PRIMARY_TYPE = 'WalletAuthorization';

export const AUTHORIZATION_TYPES = {
  WalletAuthorization: [
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'userOpHash', type: 'bytes32' },
    { name: 'bodyHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export type AuthorizationMessage = {
  method: string;
  path: string;
  /** The Mera EOA. The address the signature must recover to. */
  owner: Address;
  /** The Kernel smart account, resolved server-side from the authenticated user. */
  sender: Address;
  userOpHash: Hash;
  bodyHash: Hex;
  /** Server-issued, single-use. Kills signature replay. */
  nonce: Hex;
  /** Unix seconds. */
  expiresAt: bigint;
};

export type AuthorizationDomain = {
  name: typeof AUTHORIZATION_DOMAIN_NAME;
  version: typeof AUTHORIZATION_DOMAIN_VERSION;
  chainId: number;
};

/** The complete EIP-712 payload handed to the client. */
export type AuthorizationPayload = {
  domain: AuthorizationDomain;
  types: typeof AUTHORIZATION_TYPES;
  primaryType: typeof AUTHORIZATION_PRIMARY_TYPE;
  message: AuthorizationMessage;
};

export function authorizationDomain(chainId: number): AuthorizationDomain {
  return {
    name: AUTHORIZATION_DOMAIN_NAME,
    version: AUTHORIZATION_DOMAIN_VERSION,
    chainId,
  };
}

export function authorizationPayload(
  chainId: number,
  message: AuthorizationMessage,
): AuthorizationPayload {
  return {
    domain: authorizationDomain(chainId),
    types: AUTHORIZATION_TYPES,
    primaryType: AUTHORIZATION_PRIMARY_TYPE,
    message,
  };
}

/**
 * Hash of the semantic content of the execute request body.
 *
 * Only the fields that decide what happens are hashed — the two signatures are
 * excluded because a signature cannot cover itself. Key order is fixed by the
 * literal below rather than by `JSON.stringify` of an arbitrary object, so the
 * client and the server cannot disagree about serialization.
 */
export function executeBodyHash(prepareId: string): Hex {
  return keccak256(stringToHex(JSON.stringify({ prepareId })));
}

export type VerifyAuthorizationInput = {
  chainId: number;
  message: AuthorizationMessage;
  signature: Hex;
  /** The owner the SERVER resolved. Never one the client supplied. */
  expectedOwner: Address;
};

/**
 * True only when `signature` is a valid EIP-712 signature over `message` by
 * `expectedOwner`.
 *
 * `message.owner` is compared against `expectedOwner` as well as being the
 * recovery target, so a mismatch is a rejection rather than a silently
 * different-but-valid signature.
 */
export async function verifyAuthorization({
  chainId,
  message,
  signature,
  expectedOwner,
}: VerifyAuthorizationInput): Promise<boolean> {
  if (message.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    return false;
  }
  return verifyTypedData({
    address: expectedOwner,
    domain: authorizationDomain(chainId),
    types: AUTHORIZATION_TYPES,
    primaryType: AUTHORIZATION_PRIMARY_TYPE,
    message,
    signature,
  });
}
