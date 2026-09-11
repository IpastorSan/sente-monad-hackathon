// Privy policies — the compiled mandate as Privy stores it. Ported from
// turnstile `buyer/mandate/policy.ts` (create / get / patch), minus the
// mandate itself, which `@sente/mandate` compiles.
//
// A policy is owned by the MANDATE-OWNER quorum, never the agent's: from
// creation on, only a request signed by that key can change it. `GET
// /v1/policies` (the list) answers 405, so a policy id not written down
// somewhere is a policy you can no longer find.

import type { Policy, PolicyRule } from '@sente/mandate';

import type { AuthorizationKey } from './authorization-key.ts';
import type { PrivyClient } from './privy.client.ts';

/** Privy caps policy names at 50 characters. */
const name50 = (name: string): string => name.slice(0, 50);

export async function createPolicy(
  privy: PrivyClient,
  options: { name: string; rules: readonly PolicyRule[]; ownerQuorumId: string },
): Promise<Policy> {
  return privy.post<Policy>('/v1/policies', {
    version: '1.0',
    name: name50(options.name),
    chain_type: 'ethereum',
    rules: options.rules,
    owner_id: options.ownerQuorumId,
  });
}

export async function getPolicy(privy: PrivyClient, policyId: string): Promise<Policy> {
  return privy.get<Policy>(`/v1/policies/${policyId}`);
}

/**
 * Replace a policy's rules. **The owner-gated operation**: Privy counts the
 * signatures against the owner quorum's threshold and answers 401 when one is
 * short, whatever our code thinks.
 */
export async function updatePolicyRules(
  privy: PrivyClient,
  options: {
    policyId: string;
    rules: readonly PolicyRule[];
    name?: string;
    approvals: readonly AuthorizationKey[];
  },
): Promise<Policy> {
  return privy.patch<Policy>(
    `/v1/policies/${options.policyId}`,
    {
      ...(options.name === undefined ? {} : { name: name50(options.name) }),
      rules: options.rules,
    },
    { approvals: options.approvals },
  );
}
