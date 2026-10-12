// Verify an agent's on-chain mandate anchor (SEN-194). READ-ONLY: no key, no
// transaction, no sign-in.
//
//   pnpm --filter @sente/api run mandate:verify -- --agent 1874
//   pnpm --filter @sente/api run mandate:verify -- --agent <agent uuid>
//   pnpm --filter @sente/api run mandate:verify -- --agent 1874 --mandate ./mandate.json
//
// What it does, so a third party can repeat it with any other tool:
//
//   1. Reads the agent's ERC-8004 identity on Monad testnet: `getMetadata(id,
//      "sente.mandate")` on the Identity Registry — 66 bytes, `version ‖ status
//      ‖ mandateHash ‖ policyHash` — and `tokenURI(id)`, whose registration
//      file links the agent's page (`…/agents/<uuid>`).
//   2. Fetches the mandate the agent publishes: the public agent JSON at
//      `--api` (default https://api.sente.lol) `/public/agents/<uuid>`, or
//      `--mandate <file|url>` — either a bare mandate or an object with a
//      `mandate` field, as `GET /agents/:id` returns it.
//   3. Recomputes `mandateHash` (`@sente/mandate`: keccak256 of the canonical
//      JSON) and, when the JSON carries the agent's `address`, `policyHash`
//      (keccak256 of the canonical compiled Privy rules), and compares both with
//      what the registry holds.
//
// With `--agent <uuid>` the token id comes from the published JSON
// (`mandateAnchor.agentTokenId` or `erc8004AgentId`); with a token id the uuid
// comes from the registration file. Exit 0 when the mandate hash matches, 1
// when it does not, 2 on bad input.
//
// The hash includes the Kuru deployment (`KURU_DEPLOYMENT`, set-c | set-d):
// run with the one the agent was hired on, or the mandate may not parse.

import { readFileSync } from 'node:fs';

import { canonicalMandateJson, mandateHash, parseMandate, type Mandate } from '@sente/mandate';
import { KURU_DEPLOYMENT } from '@sente/venues/kuru';
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';

import {
  ERC8004_IDENTITY_ABI,
  ERC8004_IDENTITY_REGISTRY,
} from '../src/agents/reputation/erc8004.ts';
import {
  decodeMandateAnchor,
  desiredAnchor,
  MANDATE_METADATA_KEY,
} from '../src/agents/reputation/mandate-anchor.ts';
import type { AgentRecord } from '../src/agents/store/agent-store.ts';

const DEFAULT_API = 'https://api.sente.lol';
/** The public agent JSON (SEN-193). Change here if that route moves. */
const PUBLIC_AGENT_PATH = (id: string) => `/public/agents/${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function show(label: string, value: unknown, note = ''): void {
  console.log(`${label.padEnd(24)} ${String(value)}${note ? `   ${note}` : ''}`);
}

function usage(message: string): never {
  console.error(
    `${message}\nusage: mandate:verify -- --agent <tokenId|uuid> [--mandate <file|url>] [--api <base>]`,
  );
  process.exit(2);
}

async function loadJson(source: string): Promise<Record<string, unknown>> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`GET ${source} answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  return JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
}

/** The agent uuid the registration file links to, if it is a Sente one. */
function uuidFromAgentUri(uri: string): string | undefined {
  const base64 = uri.startsWith('data:application/json;base64,')
    ? uri.slice('data:application/json;base64,'.length)
    : undefined;
  if (!base64) return undefined;
  const file = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as {
    services?: { name?: string; endpoint?: string }[];
  };
  const web = file.services?.find((s) => s.name === 'web')?.endpoint ?? '';
  return /\/agents\/([0-9a-f-]{36})$/i.exec(web)?.[1];
}

async function main(): Promise<void> {
  const agentArg = arg('agent') ?? usage('--agent is required');
  const api = (arg('api') ?? DEFAULT_API).replace(/\/+$/, '');
  const chain = createPublicClient({
    chain: monadTestnet,
    transport: http(process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined),
  });

  let tokenId: bigint | undefined = /^\d+$/.test(agentArg) ? BigInt(agentArg) : undefined;
  let uuid: string | undefined = UUID.test(agentArg) ? agentArg.toLowerCase() : undefined;
  if (tokenId === undefined && uuid === undefined)
    usage(`--agent ${agentArg} is neither a token id nor a uuid`);

  if (tokenId !== undefined && uuid === undefined && arg('mandate') === undefined) {
    const uri = (await chain.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: ERC8004_IDENTITY_ABI,
      functionName: 'tokenURI',
      args: [tokenId],
    })) as string;
    uuid = uuidFromAgentUri(uri);
    if (!uuid) usage(`token ${tokenId}'s registration file links no Sente agent; pass --mandate`);
  }

  const source = arg('mandate') ?? `${api}${PUBLIC_AGENT_PATH(uuid!)}`;
  const published = await loadJson(source);
  const rawMandate = 'mandate' in published ? published['mandate'] : published;
  const claimed = published['mandateAnchor'] as { agentTokenId?: string } | undefined;
  if (tokenId === undefined) {
    const fromJson = claimed?.agentTokenId ?? (published['erc8004AgentId'] as string | undefined);
    if (!fromJson || !/^\d+$/.test(fromJson))
      usage(`${source} names no ERC-8004 token id for the agent`);
    tokenId = BigInt(fromJson);
  }

  console.log(`Mandate anchor check — Monad testnet (${monadTestnet.id})\n`);
  show('identity registry', ERC8004_IDENTITY_REGISTRY);
  show('agent token', tokenId);
  if (uuid) show('agent', uuid);
  show('mandate from', source);
  show('kuru deployment', KURU_DEPLOYMENT.id, '(KURU_DEPLOYMENT)');

  const value = (await chain.readContract({
    address: ERC8004_IDENTITY_REGISTRY,
    abi: ERC8004_IDENTITY_ABI,
    functionName: 'getMetadata',
    args: [tokenId, MANDATE_METADATA_KEY],
  })) as Hex;
  const onChain = decodeMandateAnchor(value);
  if (!onChain) {
    show('on chain', value === '0x' ? 'nothing under sente.mandate' : `not an anchor: ${value}`);
    process.exitCode = 1;
    return;
  }
  show('on-chain status', onChain.status);
  show('on-chain mandateHash', onChain.mandateHash);
  show('on-chain policyHash', onChain.policyHash);

  let mandate: Mandate;
  try {
    mandate = parseMandate(rawMandate);
  } catch (error) {
    usage(
      `the published mandate does not parse on ${KURU_DEPLOYMENT.id} ` +
        `(${error instanceof Error ? error.message : String(error)}); try the other KURU_DEPLOYMENT`,
    );
  }
  const recomputed = mandateHash(mandate);
  const mandateOk = recomputed === onChain.mandateHash;
  show('recomputed mandateHash', recomputed, mandateOk ? 'MATCH' : 'MISMATCH');
  if (process.argv.includes('--show-canonical')) show('canonical', canonicalMandateJson(mandate));

  const address = published['address'];
  if (typeof address === 'string' && isAddress(address)) {
    const want = desiredAnchor({
      mandate,
      address: getAddress(address) as Address,
      status: onChain.status,
      kuruDepositPinned: published['kuruDepositPinned'] !== false,
      ...(published['kuruBuilder'] ? { kuruBuilder: published['kuruBuilder'] } : {}),
    } as unknown as AgentRecord);
    show(
      'recomputed policyHash',
      want.policyHash,
      want.policyHash === onChain.policyHash
        ? 'MATCH'
        : 'differs (needs the builder fee and deposit pin the agent was compiled with)',
    );
  } else {
    show('recomputed policyHash', 'skipped: the published JSON has no agent address');
  }

  console.log(
    mandateOk
      ? '\nOK: the mandate this agent publishes is the one anchored on chain.'
      : '\nMISMATCH: the published mandate is not the one anchored on chain ' +
          '(or an amend is still being anchored — check the Ledger).',
  );
  if (!mandateOk) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
