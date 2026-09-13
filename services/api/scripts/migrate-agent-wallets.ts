// SEN-31 migration. Moves each already-provisioned agent wallet from the old
// (buggy) shape — OWNED by the agent quorum, which could PATCH its own policy —
// into the owner=mandate / signer=agent shape the fix ships.
//
// For each wallet named in `.env` (PRIVY_AGENT_VENUES_WALLET_ID and
// PRIVY_PROBE_WALLET_ID), while the agent key is still the owner and so can
// PATCH, it sets:
//   - owner_id           -> the mandate quorum (PRIVY_MANDATE_QUORUM_ID)
//   - additional_signers -> [{ signer_id: agent quorum, override_policy_ids: [<the wallet's policy>] }]
// in a single PATCH signed by the agent key. After it lands, the agent key can
// no longer PATCH the wallet.
//
// Idempotent: a wallet whose owner is ALREADY the mandate quorum is skipped.
// Prints ids only, never secrets, and mutates only the two named wallets.
//
// Run from services/api:
//   mise exec -- node --conditions=source --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/migrate-agent-wallets.ts
//   (add --dry-run to report what it would do without PATCHing)

import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { getAgentWallet } from '../src/agents/privy/agent-wallet.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const ENV_FILE = process.env['MIGRATE_ENV_FILE'];
if (ENV_FILE) process.loadEnvFile(ENV_FILE);
else process.loadEnvFile();

const cfg = loadAgentsConfig(process.env).privy;
if (!cfg || !cfg.agentQuorumId || !cfg.mandateQuorumId) {
  console.log('blocked: Privy config or PRIVY_AGENT_QUORUM_ID / PRIVY_MANDATE_QUORUM_ID missing');
  process.exit(1);
}
const client = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
const agentKey = cfg.agentAuthKey; // still the owner, pre-migration
const mandateQuorumId = cfg.mandateQuorumId;
const agentQuorumId = cfg.agentQuorumId;

const WALLET_ENV_VARS = ['PRIVY_AGENT_VENUES_WALLET_ID', 'PRIVY_PROBE_WALLET_ID'] as const;

interface DetachCheck {
  /** True when the agent key was refused (401/403) trying to detach the policy. */
  detachRefused: boolean;
  status: number;
  /** True when, after the refused attempt, the mandate policy is still attached. */
  policyStillAttached: boolean;
}

interface Result {
  envVar: string;
  walletId?: string;
  action: 'skipped-already-migrated' | 'migrated' | 'would-migrate' | 'not-set' | 'error';
  ownerBefore?: string | null;
  ownerAfter?: string | null;
  policyId?: string;
  signers?: unknown;
  /** Sign-only proof (no broadcast) that the migrated wallet closes the SEN-31 hole. */
  detachCheck?: DetachCheck;
  error?: string;
}

const results: Result[] = [];

/**
 * Prove on the live, migrated wallet that the agent key — now only a SIGNER —
 * can no longer detach the policy. Attempts a `PATCH {policy_ids: []}` signed by
 * the agent key; a refused PATCH mutates nothing, so this is sign-only and safe.
 */
async function verifyDetachRefused(walletId: string): Promise<DetachCheck> {
  const status = await client
    .patch(`/v1/wallets/${walletId}`, { policy_ids: [] }, { approvals: [agentKey] })
    .then(() => 200) // it went through — the hole is NOT closed
    .catch((e: unknown) => (e instanceof PrivyError ? e.status : -1));
  const after = await getAgentWallet(client, walletId);
  return {
    detachRefused: status === 401 || status === 403,
    status,
    policyStillAttached: (after.policy_ids?.length ?? 0) > 0,
  };
}

for (const envVar of WALLET_ENV_VARS) {
  const walletId = process.env[envVar]?.trim();
  if (!walletId) {
    results.push({ envVar, action: 'not-set' });
    continue;
  }
  try {
    const wallet = await getAgentWallet(client, walletId);
    const ownerBefore = wallet.owner_id ?? null;
    const policyId = wallet.policy_ids?.[0];

    if (ownerBefore === mandateQuorumId) {
      results.push({
        envVar,
        walletId,
        action: 'skipped-already-migrated',
        ownerBefore,
        signers: wallet.additional_signers,
        detachCheck: DRY_RUN ? undefined : await verifyDetachRefused(walletId),
      });
      continue;
    }
    if (!policyId) {
      results.push({ envVar, walletId, action: 'error', error: 'wallet has no attached policy' });
      continue;
    }

    if (DRY_RUN) {
      results.push({ envVar, walletId, action: 'would-migrate', ownerBefore, policyId });
      continue;
    }

    // One PATCH, signed by the agent key (the current owner): hand the wallet
    // to the mandate quorum and register the agent quorum as a signer bound to
    // the same policy.
    await client.patch(
      `/v1/wallets/${walletId}`,
      {
        owner_id: mandateQuorumId,
        additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [policyId] }],
      },
      { approvals: [agentKey] },
    );

    const after = await getAgentWallet(client, walletId);
    results.push({
      envVar,
      walletId,
      action: 'migrated',
      ownerBefore,
      ownerAfter: after.owner_id ?? null,
      policyId,
      signers: after.additional_signers,
      detachCheck: await verifyDetachRefused(walletId),
    });
  } catch (e) {
    const message =
      e instanceof PrivyError ? `Privy ${e.status} ${e.code ?? ''}`.trim() : (e as Error).message;
    results.push({ envVar, walletId, action: 'error', error: message });
  }
}

console.log(JSON.stringify({ mandateQuorumId, agentQuorumId, results }, null, 2));
const failed = results.some(
  (r) =>
    r.action === 'error' ||
    (r.detachCheck && !(r.detachCheck.detachRefused && r.detachCheck.policyStillAttached)),
);
process.exit(failed ? 1 : 0);
