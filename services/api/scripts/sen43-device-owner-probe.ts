// SEN-43 device-owner probe. Proves LIVE the one claim Phase 3 exists to make:
// an agent hired under the USER's device-key quorum has a mandate THIS SERVER
// cannot change.
//
// Same shape as scripts/sen31-signer-probe.ts, one level up: SEN-31 showed the
// trading key cannot rewrite the policy, this shows the SERVER key cannot either
// once the owner is the phone's key.
//
// Verifies, against a policy + wallet provisioned through the real
// `PrivyAgentWalletProvider.provision({ ownerQuorumId })`:
//   (a) the owner of both objects IS the fresh device quorum   -> read back
//   (b) PRIVY_MANDATE_OWNER_KEY PATCHes that policy            -> 401
//   (c) PRIVY_MANDATE_OWNER_KEY PATCHes that wallet            -> 401
//   (d) the DEVICE key PATCHes that policy                     -> 200
//
// If (b) does not hold, the server can still widen any user's mandate and the
// whole Phase 3 claim is false. Prints `DEVICE OWNERSHIP OK` only when (a)-(d)
// all hold.
//
// The device key is generated in memory and thrown away: it stands in for the
// phone's `device` P-256 key (SEN-38), which this server never sees. Nothing is
// signed for a chain and nothing is broadcast. Creates only
// `sente-agent-device-probe` resources on the shared Privy app.
//
// Run from services/api:
//   mise exec -- node --conditions=source --no-warnings=MODULE_TYPELESS_PACKAGE_JSON \
//     scripts/sen43-device-owner-probe.ts

import { setTimeout as sleep } from 'node:timers/promises';

import { compileMandate, parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { generateAuthorizationKey } from '../src/agents/privy/authorization-key.ts';
import { getAgentWallet } from '../src/agents/privy/agent-wallet.ts';
import { createKeyQuorum } from '../src/agents/privy/key-quorum.ts';
import { getPolicy } from '../src/agents/privy/policies.ts';
import { PrivyAgentWalletProvider } from '../src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';

const ENV_FILE =
  process.env['SEN43_ENV_FILE'] ?? new URL('../../../.env', import.meta.url).pathname;
const NAME = 'sente-agent-device-probe';
const SETTLE_MS = 5_000;

process.loadEnvFile(ENV_FILE);
const cfg = loadAgentsConfig(process.env).privy;
if (!cfg?.agentQuorumId || !cfg.mandateQuorumId) {
  console.log('blocked: PRIVY_* config or PRIVY_AGENT_QUORUM_ID / PRIVY_MANDATE_QUORUM_ID missing');
  process.exit(1);
}

const client = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });

/** A real compiled mandate, so the policy under test is the one hire creates. */
const RULES = compileMandate(
  parseMandate({
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru'],
    kuru: {
      markets: [KURU_TESTNET_MARKETS[0]!.address],
      maxDepositAtoms: { [KURU_TESTNET_TOKENS.USDC.address]: '10000000' },
    },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '10',
  }),
);

interface Attempt {
  ok: boolean;
  status: number;
  code?: string;
  body?: unknown;
}

async function attempt(fn: () => Promise<unknown>): Promise<Attempt> {
  try {
    await fn();
    return { ok: true, status: 200 };
  } catch (error) {
    if (error instanceof PrivyError) {
      return { ok: false, status: error.status, code: error.code, body: error.body };
    }
    return { ok: false, status: 0, body: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

// ---- the device key: generated here, thrown away; the phone holds the real one
const deviceKey = generateAuthorizationKey();
const deviceQuorum = await createKeyQuorum(client, {
  displayName: NAME,
  threshold: 1,
  publicKeys: [deviceKey.publicKey],
});
console.log(`device quorum: ${deviceQuorum.id} (key generated in memory, not in .env)`);

// ---- hire, exactly as AgentsService does in `device` mode ---------------------
const provider = new PrivyAgentWalletProvider({
  client,
  agentKey: cfg.agentAuthKey,
  mandateOwnerKey: cfg.mandateOwnerKey,
  agentQuorumId: cfg.agentQuorumId,
  mandateQuorumId: cfg.mandateQuorumId,
});
const agent = await provider.provision({
  rules: RULES,
  displayName: NAME,
  ownerQuorumId: deviceQuorum.id,
});
console.log(`policy: ${agent.policyId}\nwallet: ${agent.walletId} (${agent.address})`);
await sleep(SETTLE_MS);

// ---- (a) both objects are owned by the device quorum -------------------------
const policy = (await getPolicy(client, agent.policyId)) as unknown as { owner_id?: string };
const wallet = await getAgentWallet(client, agent.walletId);
const a =
  policy.owner_id === deviceQuorum.id &&
  wallet.owner_id === deviceQuorum.id &&
  wallet.policy_ids.includes(agent.policyId) &&
  (wallet.additional_signers ?? []).some((s) => s.signer_id === cfg.agentQuorumId);
console.log(
  `\n[a] owners: policy=${policy.owner_id} wallet=${wallet.owner_id} ` +
    `signers=${JSON.stringify(wallet.additional_signers)} -> ${a ? 'OK' : 'FAILED'}`,
);

// ---- (b) the SERVER's mandate key cannot change that policy ------------------
const b = await attempt(() => provider.updatePolicy(agent.policyId, []));
console.log(`\n[b] PRIVY_MANDATE_OWNER_KEY PATCH policy -> ${JSON.stringify(b)}`);

// ---- (c) nor the wallet -----------------------------------------------------
const c = await attempt(() =>
  client.patch(
    `/v1/wallets/${agent.walletId}`,
    { policy_ids: [] },
    { approvals: [cfg.mandateOwnerKey] },
  ),
);
console.log(`\n[c] PRIVY_MANDATE_OWNER_KEY PATCH wallet -> ${JSON.stringify(c)}`);

// ---- (d) the DEVICE key can ------------------------------------------------
const d = await attempt(() =>
  client.patch(`/v1/policies/${agent.policyId}`, { rules: RULES }, { approvals: [deviceKey] }),
);
console.log(`\n[d] device key PATCH policy -> ${JSON.stringify(d)}`);

const refused = (r: Attempt) => !r.ok && (r.status === 401 || r.status === 403);
const verdict = { a, b: refused(b), c: refused(c), d: d.ok };
const ok = verdict.a && verdict.b && verdict.c && verdict.d;
console.log(`\n[verdict] ${JSON.stringify(verdict)}`);
console.log(
  `\nids: deviceQuorum=${deviceQuorum.id} policy=${agent.policyId} ` +
    `wallet=${agent.walletId} address=${agent.address}`,
);
console.log(
  `\n${ok ? 'DEVICE OWNERSHIP OK — this server cannot change this mandate' : 'FAILED — see verdict'}`,
);
process.exit(ok ? 0 : 2);
