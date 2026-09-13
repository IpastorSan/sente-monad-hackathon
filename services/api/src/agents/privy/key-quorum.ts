// Key quorums: these public keys, this many signatures. Ported from turnstile
// `buyer/org/operators.ts`, public-keys branch only — Sente never onboards a
// human operator here, it registers keys.
//
// Sente creates two single-key quorums, and they are deliberately different
// objects:
//
// | Quorum        | Key                       | Role (SEN-31)                    |
// |---------------|---------------------------|----------------------------------|
// | agent         | `PRIVY_AGENT_AUTH_KEY`    | SIGNER on every wallet (trades)  |
// | mandate owner | `PRIVY_MANDATE_OWNER_KEY` | OWNER of every wallet AND policy |
//
// The agent quorum only ever signs; it never OWNS a wallet, because a Privy
// wallet owner can PATCH the wallet to detach its own policy (verified live,
// SEN-31). The mandate-owner quorum owns both the wallet and the policy, so
// only it can change either, and the key that signs trades can never rewrite
// the policy that bounds them. Phase 3 moves the mandate-owner key onto the
// user's device; the shape of this call does not change, because a quorum has
// only ever needed the public half.

import type { PrivyClient } from './privy.client.ts';

export interface KeyQuorum {
  id: string;
  display_name: string | null;
  authorization_threshold: number;
  authorization_keys: { public_key: string; display_name: string | null }[];
}

/**
 * Register a key quorum.
 *
 * `threshold` is checked here rather than only by Privy because the failure it
 * prevents is silent — a threshold above the member count creates a quorum that
 * can never approve anything, and you find out at the moment you need it.
 */
export async function createKeyQuorum(
  privy: PrivyClient,
  options: { displayName: string; threshold: number; publicKeys: readonly string[] },
): Promise<KeyQuorum> {
  const { displayName, threshold, publicKeys } = options;
  if (publicKeys.length === 0) throw new Error('a key quorum needs at least one member');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > publicKeys.length) {
    throw new Error(
      `threshold ${threshold} is unsatisfiable with ${publicKeys.length} member(s) — it would lock the owner out`,
    );
  }
  return privy.post<KeyQuorum>('/v1/key_quorums', {
    display_name: displayName.slice(0, 50),
    public_keys: [...publicKeys],
    authorization_threshold: threshold,
  });
}
