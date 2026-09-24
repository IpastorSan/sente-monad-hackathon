// SEN-31 signer-model probe. Verifies the fix design LIVE before any code lands:
// a wallet OWNED by the mandate quorum, with the mandate policy attached, and
// the agent quorum as an `additional_signers` entry whose `override_policy_ids`
// is that same policy. The agent key is then a SIGNER, not the owner.
//
// Verifies:
//   (a) the agent signer signs an ALLOWED eth_signTransaction   -> SIGNED
//   (b) a NOT-allowed one                                        -> refused (policy_violation)
//   (c) the agent signer PATCH /v1/wallets/{id} (policy_ids / owner_id /
//       additional_signers)                                     -> 401 each
//   (d) the owner (mandate) key PATCH /v1/wallets/{id}          -> 200
//
// If (c) does NOT hold — the signer can still PATCH — the whole design is wrong.
// The probe prints `DESIGN OK` only when (a)-(d) all hold.
//
// Sign-only on Monad testnet 10143, nonce 1_000_000, never broadcast. Creates
// only `sente-sen31-probe-*` resources; it must not touch PRIVY_AGENT_VENUES_*,
// PRIVY_PROBE_* or turnstile resources (the Privy app is shared). Never prints
// secrets.
//
// Run from services/api:
//   mise exec -- node --conditions=source --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/sen31-signer-probe.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { getAddress, parseTransaction } from 'viem';

import { txChainIdEq, txToEq } from '@sente/mandate';
import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { generateAuthorizationKey } from '../src/agents/privy/authorization-key.ts';
import {
  getAgentWallet,
  privyTransaction,
  signTransaction,
} from '../src/agents/privy/agent-wallet.ts';
import { createKeyQuorum } from '../src/agents/privy/key-quorum.ts';
import { createPolicy } from '../src/agents/privy/policies.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';

// Paths resolve from this file, never from whoever's machine wrote it: the repo
// root is three levels up (services/api/scripts). Override either with an env
// var. `SEN31_OUT` defaults under the system temp dir and is created if absent.
const ENV_FILE =
  process.env['SEN31_ENV_FILE'] ?? new URL('../../../.env', import.meta.url).pathname;
const OUT = process.env['SEN31_OUT'] ?? join(tmpdir(), 'sente-sen31-probe');
mkdirSync(OUT, { recursive: true });

const CHAIN_ID = 10143;
const ALLOWED = getAddress('0x1111111111111111111111111111111111111111');
const NOT_ALLOWED = getAddress('0x2222222222222222222222222222222222222222');
const SETTLE_MS = 5_000;
const RUN = `sente-sen31-probe-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

process.loadEnvFile(ENV_FILE);
const cfg = loadAgentsConfig(process.env).privy;
if (!cfg || !cfg.agentQuorumId || !cfg.mandateQuorumId) {
  console.log('blocked: Privy config or PRIVY_AGENT_QUORUM_ID / PRIVY_MANDATE_QUORUM_ID missing');
  process.exit(1);
}
const client = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
const agentKey = cfg.agentAuthKey; // now the SIGNER
const mandateKey = cfg.mandateOwnerKey; // now the wallet + policy OWNER

const created: Record<string, string> = {};
const steps: Record<string, unknown>[] = [];
const verdict: Record<string, unknown> = {};
const save = () =>
  writeFileSync(
    `${OUT}/results.json`,
    `${JSON.stringify(
      {
        run: RUN,
        agentQuorumId: cfg.agentQuorumId,
        mandateQuorumId: cfg.mandateQuorumId,
        created,
        verdict,
        steps,
      },
      null,
      2,
    )}\n`,
  );
const remember = (name: string, id: string) => {
  created[name] = id;
  console.log(`created ${name}: ${id}`);
  save();
};

/** Belt and braces: Privy bodies hold no secrets, but strip any long base64 run. */
const redact = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v ?? null, (_k, x) =>
      typeof x === 'string' ? x.replace(/[A-Za-z0-9+/=]{80,}/g, '[redacted]') : x,
    ),
  );

async function call(fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return { ok: true as const, status: 200, value };
  } catch (e) {
    if (e instanceof PrivyError)
      return { ok: false as const, status: e.status, code: e.code, body: redact(e.body) };
    return { ok: false as const, status: 0, body: `${(e as Error).name}: ${(e as Error).message}` };
  }
}

async function readBack(walletId: string) {
  const w = (await getAgentWallet(client, walletId)) as Record<string, unknown>;
  return {
    policy_ids: w.policy_ids,
    owner_id: w.owner_id,
    additional_signers: w.additional_signers,
  };
}

const tx = (to: string) =>
  privyTransaction({
    to,
    data: '0x',
    chainId: CHAIN_ID,
    nonce: 1_000_000,
    gas: 21_000n,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

async function signProbe(walletId: string, to: string, approvals: unknown[]) {
  const r = await call(() => signTransaction(client, { walletId, transaction: tx(to), approvals }));
  if (r.ok) {
    const parsed = parseTransaction(r.value as string);
    return { outcome: 'SIGNED', to: parsed.to, chainId: parsed.chainId, nonce: parsed.nonce };
  }
  return {
    outcome: r.code === 'policy_violation' ? 'refused (policy_violation)' : `error ${r.status}`,
    status: r.status,
    body: r.body,
  };
}

const patchWallet = (walletId: string, body: unknown, approvals: unknown[]) => () =>
  client.patch(`/v1/wallets/${walletId}`, body, { approvals });

async function step(
  id: string,
  title: string,
  fn: () => Promise<unknown>,
  walletId: string,
  extra?: () => Promise<Record<string, unknown>>,
) {
  const r = await call(fn);
  const record: Record<string, unknown> = { id, title, status: r.status, ok: r.ok };
  if (!r.ok) record.error = { code: r.code, body: r.body };
  else {
    const v = r.value as Record<string, unknown> | null;
    record.response = redact(
      v && typeof v === 'object'
        ? {
            policy_ids: v['policy_ids'],
            owner_id: v['owner_id'],
            additional_signers: v['additional_signers'],
          }
        : r.value,
    );
  }
  if (r.ok) await sleep(SETTLE_MS);
  record.readBack = await readBack(walletId);
  if (extra) Object.assign(record, await extra());
  steps.push(record);
  save();
  console.log(`\n[${id}] ${title}\n  -> ${JSON.stringify(record)}`);
  return r;
}

// ---- setup ------------------------------------------------------------------
// Policy owned by the MANDATE quorum: only the mandate key can change it.
const mandatePolicy = await createPolicy(client, {
  name: `${RUN}-mandate`,
  rules: [
    {
      name: 'allow one to on 10143',
      method: 'eth_signTransaction',
      action: 'ALLOW',
      conditions: [txChainIdEq(CHAIN_ID), txToEq(ALLOWED)],
    },
  ],
  ownerQuorumId: cfg.mandateQuorumId,
});
remember('mandatePolicyId (owner: mandate quorum)', mandatePolicy.id);

// The wallet: OWNED by the mandate quorum, mandate policy attached, agent quorum
// an additional signer whose override is that same policy. This is the shape the
// fix ships. Creation needs no owner signature.
const wallet = await client.post<{ id: string; address: string }>('/v1/wallets', {
  chain_type: 'ethereum',
  owner_id: cfg.mandateQuorumId,
  policy_ids: [mandatePolicy.id],
  additional_signers: [{ signer_id: cfg.agentQuorumId, override_policy_ids: [mandatePolicy.id] }],
  display_name: `${RUN}-wallet`.slice(0, 50),
});
remember('walletId (owner: mandate quorum, signer: agent quorum)', wallet.id);
created.walletAddress = wallet.address;
save();
const W = wallet.id;
steps.push({ id: 'setup', readBack: await readBack(W) });
save();
await sleep(SETTLE_MS);

// A permissive policy owned by the agent quorum — the payload an attacker signer
// would try to point the wallet at. Only used inside the (c) attempts.
const permissive = await createPolicy(client, {
  name: `${RUN}-permissive`,
  rules: [
    {
      name: 'allow any to on 10143',
      method: 'eth_signTransaction',
      action: 'ALLOW',
      conditions: [txChainIdEq(CHAIN_ID)],
    },
  ],
  ownerQuorumId: cfg.agentQuorumId,
});
remember('permissivePolicyId (owner: agent quorum)', permissive.id);

// A fresh in-memory quorum the attacker would try to install as owner/signer.
const attackerKey = generateAuthorizationKey();
const attackerQuorum = await createKeyQuorum(client, {
  displayName: `${RUN}-attacker`,
  threshold: 1,
  publicKeys: [attackerKey.publicKey],
});
remember('attackerQuorumId (fresh in-memory key)', attackerQuorum.id);

// ---- (a)(b) the agent SIGNER trades within the mandate ----------------------
const aAllowed = await signProbe(W, ALLOWED, [agentKey]);
const bDenied = await signProbe(W, NOT_ALLOWED, [agentKey]);
steps.push({
  id: 'ab',
  title: 'agent signer sign-only',
  allowedTo: aAllowed,
  notAllowedTo: bDenied,
});
save();
console.log(`\n[a] allowed=${JSON.stringify(aAllowed)}\n[b] notAllowed=${JSON.stringify(bDenied)}`);
verdict.a = aAllowed.outcome === 'SIGNED';
verdict.b = bDenied.outcome === 'refused (policy_violation)';

// ---- (c) the agent SIGNER must NOT be able to PATCH the wallet --------------
// Each attempt signed by the AGENT key alone must be refused with 401.
const c1 = await step(
  'c1',
  'PATCH {policy_ids: []} signed by AGENT SIGNER key alone',
  patchWallet(W, { policy_ids: [] }, [agentKey]),
  W,
  async () => ({ notAllowedSignAfter: await signProbe(W, NOT_ALLOWED, [agentKey]) }),
);
const c2 = await step(
  'c2',
  'PATCH {owner_id: <attacker>} signed by AGENT SIGNER key alone',
  patchWallet(W, { owner_id: attackerQuorum.id }, [agentKey]),
  W,
  async () => ({ notAllowedSignAfter: await signProbe(W, NOT_ALLOWED, [agentKey]) }),
);
const c3 = await step(
  'c3',
  'PATCH {additional_signers: [{attacker, override: permissive}]} signed by AGENT SIGNER key alone',
  patchWallet(
    W,
    {
      additional_signers: [{ signer_id: attackerQuorum.id, override_policy_ids: [permissive.id] }],
    },
    [agentKey],
  ),
  W,
  async () => ({ notAllowedSignAfter: await signProbe(W, NOT_ALLOWED, [agentKey]) }),
);
// (c) holds only if EVERY signer PATCH was refused (not ok) AND the wallet still
// refuses the not-allowed tx afterwards.
const cRefused = (r: { ok: boolean; status: number }) =>
  !r.ok && (r.status === 401 || r.status === 403);
verdict.c = cRefused(c1) && cRefused(c2) && cRefused(c3);
verdict.c_detail = { c1: c1.status, c2: c2.status, c3: c3.status };

// ---- (d) the OWNER (mandate) key CAN PATCH the wallet -----------------------
const d = await step(
  'd',
  'PATCH {policy_ids: [permissive... no] } signed by OWNER (mandate) key alone',
  // Owner detaches the policy to prove owner control, then we restore it.
  patchWallet(W, { policy_ids: [] }, [mandateKey]),
  W,
);
verdict.d = d.ok;
if (d.ok) {
  await step(
    'd-restore',
    'restore wallet (owner re-attaches mandate policy)',
    patchWallet(W, { policy_ids: [mandatePolicy.id] }, [mandateKey]),
    W,
    async () => ({ notAllowedSignAfter: await signProbe(W, NOT_ALLOWED, [agentKey]) }),
  );
}

// ---- verdict ----------------------------------------------------------------
const designOk = verdict.a && verdict.b && verdict.c && verdict.d;
verdict.designOk = designOk;
const final = await readBack(W);
steps.push({ id: 'final', readBack: final });
save();
console.log(`\n[verdict] ${JSON.stringify(verdict, null, 2)}`);
console.log(`\ncreated: ${JSON.stringify(created, null, 2)}`);
console.log(`\n${designOk ? 'DESIGN OK — signer model verified' : 'DESIGN FAILED — see verdict'}`);
process.exit(designOk ? 0 : 2);
