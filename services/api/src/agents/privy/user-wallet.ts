// The USER's wallet — a Privy server wallet whose owner key lives on the
// phone (SEN-38's `device` P-256 key), never here.
//
// ## Why this file has no signing helper, and never should
//
// `agent-wallet.ts` creates a wallet our server can drive: the agent quorum is
// an `additional_signers` entry, so `PRIVY_AGENT_AUTH_KEY` can sign trades
// within the mandate. A user wallet is the opposite arrangement and the
// difference is the whole point of Phase 3:
//
// | | agent wallet | user wallet |
// |---|---|---|
// | owner | our mandate quorum | the user's DEVICE key quorum |
// | signers | our agent quorum | **none** |
// | policies | the compiled mandate | **none** — nothing to bound, nobody to bound |
//
// With no signer and no server-held owner key, the API holds the app secret and
// still cannot move a single wei: Privy checks the owner's
// `privy-authorization-signature` on its side, and that signature can only come
// from the phone. So there is deliberately no `signUserTransaction()` here —
// adding one would need an approval the server does not have, and the day
// somebody "fixes" that by putting a user's key in `.env` is the day the
// self-custody claim stops being true. Sending is SEN-42, from the device.
//
// ## Owner form: the explicit 1-key quorum
//
// SEN-39 verified live (docs/privy-sponsorship.md) that Privy accepts both
// `owner: {public_key}` and `owner_id: <quorum>`, and that the first is sugar
// for the second — it auto-creates a 1-key quorum and answers with its
// `owner_id`. We create the quorum ourselves because we want its id in hand:
// a recovery key added later is a PATCH to THAT quorum, and knowing the id
// without a second round trip is the difference between a recovery path and an
// archaeology exercise.
//
// Relative imports carry `.ts` so `scripts/*.ts` can load this file under
// node's type stripping; tsc rewrites them for the CJS build.

import { createPublicKey } from 'node:crypto';

import { getAgentWallet, type AgentWallet } from './agent-wallet.ts';
import { createKeyQuorum } from './key-quorum.ts';
import type { PrivyClient } from './privy.client.ts';

/**
 * A user wallet is the same Privy object as an agent wallet, arranged
 * differently: `owner_id` is the device quorum, `policy_ids` and
 * `additional_signers` are empty.
 */
export type UserWallet = AgentWallet;

export interface CreatedUserWallet {
  wallet: UserWallet;
  /** The 1-key quorum holding the device key. PATCH target for recovery. */
  ownerQuorumId: string;
}

/**
 * Create the user's wallet, owned by a fresh 1-key quorum holding their device
 * public key.
 *
 * Two round trips, in this order, and the order matters: the quorum must exist
 * before the wallet names it, because a wallet created bare and patched
 * afterwards is briefly a wallet **nobody owns** — and an unowned Privy wallet
 * is one the app secret alone can mutate.
 */
export async function createUserWallet(
  privy: PrivyClient,
  options: { devicePublicKey: string; displayName: string },
): Promise<CreatedUserWallet> {
  const quorum = await createKeyQuorum(privy, {
    displayName: `${options.displayName} device`,
    threshold: 1,
    publicKeys: [options.devicePublicKey],
  });
  // No `policy_ids`, no `additional_signers`: see the table above. A signer
  // here would be a server-held key that can spend the user's funds.
  const wallet = await privy.post<UserWallet>('/v1/wallets', {
    chain_type: 'ethereum',
    owner_id: quorum.id,
    display_name: options.displayName.slice(0, 50),
  });
  return { wallet, ownerQuorumId: quorum.id };
}

/**
 * Read a user wallet back. Reads need no approval — Privy only checks
 * authorization signatures on mutations — so this is `getAgentWallet` verbatim,
 * under a name that says whose wallet it is.
 */
export const getUserWallet: (privy: PrivyClient, walletId: string) => Promise<UserWallet> =
  getAgentWallet;

/**
 * Is this the base64 SPKI DER of a P-256 public key — the one encoding
 * `key_quorums.public_keys[]` accepts (authorization-key.ts)?
 *
 * Checked here rather than left to Privy because the failure it prevents is
 * expensive and late: a quorum created around a key the phone cannot sign with
 * owns the wallet forever, and there is no recovery path. Privy would take the
 * PKCS#8 form or a raw base64 blob and only fail at the first signature.
 */
export function isDevicePublicKey(value: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}
