// Live check for SEN-27, against the ERC-8004 registries on Monad testnet
// (10143). Three modes, and the first needs no key at all:
//
//   pnpm --filter @sente/api run erc8004:live                       # read-only
//   pnpm --filter @sente/api run erc8004:live -- --register          # writes
//   pnpm --filter @sente/api run erc8004:live -- --feedback 1874 --bps 250
//
// WHAT EACH MODE DOES
//
//   (default) READ-ONLY PROBE. No key, no gas, no transaction. Prints what the
//     deployment answers: code at both registries, `getIdentityRegistry()`
//     echoed back, the agents already minted, the registration file this API
//     would build for a probe agent, `eth_estimateGas` for the exact calldata
//     against the configured gas limits, a SIMULATED `register` (an `eth_call`,
//     so no state changes — it returns the agentId the next real registration
//     would mint), and the self-feedback rule the registry enforces, by
//     simulating a `giveFeedback` from the agent's own owner, which must revert.
//     `from` is the registrar address when a key is configured, otherwise any
//     funded address (TREASURY_PRIVATE_KEY's — the address only): an `eth_call`
//     needs a sender that could pay, never a signature.
//
//   --register  real write. Signs with ERC8004_REGISTRAR_KEY at the fixed gas
//     limit, waits for the receipt, prints the agentId and the tx hash, and
//     prints the command that writes feedback for it. Refuses to send when the
//     registrar's balance cannot cover `gas * maxFeePerGas`, so the failure is a
//     message rather than a revert charged at the limit.
//
//   --feedback <agentId>  real write. Signs with ERC8004_REVIEWER_KEY and writes
//     one PnL feedback (basis points, `--bps`, default 250 = +2.50%), then reads
//     it back with `getLastIndex`/`readFeedback`: the output proves the entry
//     landed, not merely that a transaction was sent. Refuses when the reviewer
//     key owns the agent, since the registry rejects self-feedback.
//
// SECRETS: no private key is ever printed, not even part of one. What is printed
// is addresses, gas, hashes and contract state.

import { existsSync } from 'node:fs';

import { createPublicClient, http, isAddressEqual, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';

import {
  addressOf,
  agentLedgerUrl,
  agentUriFor,
  createErc8004Client,
  ERC8004_IDENTITY_ABI,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_MAX_AGENT_URI_CHARS,
  ERC8004_PNL_TAG,
  ERC8004_REPUTATION_ABI,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_VALUE_DECIMALS,
  encodeFeedback,
  encodeRegister,
  loadErc8004Config,
  ZERO_FEEDBACK_HASH,
  type Erc8004Client,
} from '../src/agents/reputation/erc8004.ts';
import { envFileFromArgs } from './env-file.ts';

/** A registration file an operator can recognise on a block explorer. */
const PROBE_AGENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Momentum (SEN-27 live probe)',
  model: 'anthropic/claude-sonnet-5',
  strategy: 'Buy strength.',
  address: '0x4444444444444444444444444444444444444444' as Address,
  mandate: {
    venues: ['kuru', 'perpl'],
    kuru: { markets: ['MON-USDC'] },
    perpl: { markets: ['BTC-PERP'], maxLeverage: 5 },
    maxOrderNotional: '250',
    expiresAt: 2_000_000_000,
  },
};

const failures: string[] = [];

/**
 * The public testnet RPC answers 15 requests a second, and this probe makes a
 * dozen in a row: space the reads, or half of them come back as rate-limit
 * errors that look like a broken deployment.
 */
const READ_SPACING_MS = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The node's own one-line complaint: viem's raw message dumps the whole request body. */
function complain(error: unknown): string {
  const short = (error as { shortMessage?: string } | undefined)?.shortMessage;
  if (short) return short;
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!;
}

function show(label: string, value: unknown, note = ''): void {
  const text =
    typeof value === 'string' || typeof value === 'bigint'
      ? value.toString()
      : JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  console.log(`${label.padEnd(30)} ${text}${note ? `   ${note}` : ''}`);
}

/** Runs one step, recording a failure instead of aborting: the probe reports everything it can. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await run();
    await sleep(READ_SPACING_MS);
    return result;
  } catch (error) {
    const message = complain(error);
    failures.push(`${name}: ${message}`);
    show(`FAILED ${name}`, message);
    return undefined;
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function keyFrom(raw: string | undefined): Hex | undefined {
  const value = raw?.trim();
  return value ? ((value.startsWith('0x') ? value : `0x${value}`) as Hex) : undefined;
}

const envFile = envFileFromArgs();
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadErc8004Config();
const chain = createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl) });
const registrar = addressOf(config.registrarKey);
const reviewer = addressOf(config.reviewerKey);
/** Any funded address will do as a `from` for a simulation; the registrar is the honest one. */
const funded = registrar ?? addressOf(keyFrom(process.env['TREASURY_PRIVATE_KEY']));

async function main(): Promise<void> {
  console.log(`ERC-8004 on Monad testnet (${monadTestnet.id})\n`);
  show('identity registry', ERC8004_IDENTITY_REGISTRY);
  show('reputation registry', ERC8004_REPUTATION_REGISTRY);
  show('registrar', registrar ?? 'unset (ERC8004_REGISTRAR_KEY)');
  show('reviewer', reviewer ?? 'unset (ERC8004_REVIEWER_KEY)');
  show('gas limits', `register=${config.registerGas} feedback=${config.feedbackGas}`);
  show('simulation sender', funded ?? 'none (set ERC8004_REGISTRAR_KEY or TREASURY_PRIVATE_KEY)');

  const agents = await step('minted agents', () => mintedAgents());

  if (flag('register')) {
    await register();
  } else if (arg('feedback') !== undefined) {
    await feedback();
  } else {
    await probe(agents);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} step(s) failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nOK');
  }
}

/** The agent ids already minted, with their owners. Stops at the first gap. */
async function mintedAgents(): Promise<{ agentId: bigint; owner: Address }[]> {
  const found: { agentId: bigint; owner: Address }[] = [];
  for (let agentId = 0n; agentId < 32n; agentId += 1n) {
    const owner = await ownerOf(agentId);
    if (owner === undefined) break;
    found.push({ agentId, owner });
    await sleep(READ_SPACING_MS);
  }
  show('minted agents', found.length);
  for (const agent of found.slice(-5)) show(`  #${agent.agentId}`, agent.owner);
  return found;
}

async function probe(agents: { agentId: bigint; owner: Address }[] | undefined): Promise<void> {
  await step('deployment', async () => {
    const [identityCode, reputationCode] = await Promise.all([
      chain.getCode({ address: ERC8004_IDENTITY_REGISTRY }),
      chain.getCode({ address: ERC8004_REPUTATION_REGISTRY }),
    ]);
    show('identity code bytes', (identityCode?.length ?? 2) / 2 - 1);
    show('reputation code bytes', (reputationCode?.length ?? 2) / 2 - 1);
    if (identityCode === undefined || identityCode === '0x') {
      throw new Error('the Identity Registry has no code: wrong chain, or the wrong address');
    }
    const wired = (await chain.readContract({
      address: ERC8004_REPUTATION_REGISTRY,
      abi: ERC8004_REPUTATION_ABI,
      functionName: 'getIdentityRegistry',
    })) as Address;
    show(
      'identity registry wired in',
      wired,
      isAddressEqual(wired, ERC8004_IDENTITY_REGISTRY) ? '(matches)' : '(MISMATCH)',
    );
  });

  const agentUri = probeAgentUri();
  const registerData = encodeRegister(agentUri);
  show('probe agentURI chars', agentUri.length, `bound ${ERC8004_MAX_AGENT_URI_CHARS}`);
  show('register calldata bytes', (registerData.length - 2) / 2);

  if (funded) {
    await step('register gas', async () => {
      const gas = await chain.estimateGas({
        account: funded,
        to: ERC8004_IDENTITY_REGISTRY,
        data: registerData,
      });
      show(
        'measured register gas',
        gas,
        gas <= config.registerGas
          ? `within limit ${config.registerGas}`
          : `EXCEEDS ${config.registerGas}`,
      );
    });
    await step('simulated register', async () => {
      // An eth_call: the mint runs against the current state and is rolled back,
      // so the returned agentId is what a real registration would be minted.
      const result = await chain.call({
        account: funded,
        to: ERC8004_IDENTITY_REGISTRY,
        data: registerData,
      });
      show('would mint agentId', result.data ? BigInt(result.data) : 'no return value');
    });
  }

  const last = agents?.at(-1);
  const feedbackData = encodeFeedback({
    agentId: last?.agentId ?? 0n,
    value: bpsToValue(250n),
    valueDecimals: ERC8004_VALUE_DECIMALS,
    tag1: ERC8004_PNL_TAG,
    tag2: 'kuru',
    endpoint: '',
    feedbackURI: '',
    feedbackHash: ZERO_FEEDBACK_HASH,
  });
  if (funded) {
    await step('feedback gas', async () => {
      const gas = await chain.estimateGas({
        account: funded,
        to: ERC8004_REPUTATION_REGISTRY,
        data: feedbackData,
      });
      show(
        'measured feedback gas',
        gas,
        gas <= config.feedbackGas
          ? `within limit ${config.feedbackGas}`
          : `EXCEEDS ${config.feedbackGas}`,
      );
    });
  }
  if (last) {
    await step('self-feedback rule', async () => {
      try {
        await chain.call({
          account: last.owner,
          to: ERC8004_REPUTATION_REGISTRY,
          data: feedbackData,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/self-feedback/i.test(message)) throw error;
        show(`#${last.agentId} owner refused`, message.split('\n')[0]!);
        return;
      }
      throw new Error(`giveFeedback from the OWNER of #${last.agentId} was ACCEPTED`);
    });
  }
  console.log(
    '\nRead-only: nothing was written, no key was used.\n' +
      '`--register` mints a probe agent, `--feedback <agentId>` rates one.',
  );
}

async function register(): Promise<void> {
  const client = createErc8004Client(config);
  if (!client) {
    show('register', 'skipped: ERC8004_REGISTRAR_KEY is unset');
    return;
  }
  const owner = addressOf(config.registrarKey)!;
  const balance = await chain.getBalance({ address: owner });
  const fees = await chain.estimateFeesPerGas();
  const needed = config.registerGas * (fees.maxFeePerGas ?? 0n);
  show('registrar balance', balance);
  show('worst-case cost', needed, `at maxFeePerGas ${fees.maxFeePerGas ?? 0n}`);
  if (balance < needed) {
    show('register', 'REFUSED: fund the registrar, then run again');
    return;
  }
  const agentUri = probeAgentUri();
  show('agentURI chars', agentUri.length);
  const registered = await step('register (live write)', () => client.register(agentUri));
  if (!registered) {
    console.log(
      '\nNo agentId. A transaction that was broadcast but never confirmed may still mint:\n' +
        'check the registrar on the explorer before registering again.',
    );
    return;
  }
  show('agentId', registered.agentId);
  show('tx', registered.txHash);
  show('ledger', agentLedgerUrl(config.agentBaseUrl, PROBE_AGENT.id));
  console.log(
    `\nFeedback: pnpm --filter @sente/api run erc8004:live -- --feedback ${registered.agentId}`,
  );
}

async function feedback(): Promise<void> {
  const client = createErc8004Client(config);
  const raw = arg('feedback');
  if (!/^\d+$/.test(raw ?? '')) throw new Error(`--feedback needs an agentId, got ${raw}`);
  const agentId = BigInt(raw!);
  if (!client || !reviewer) {
    show('feedback', 'skipped: ERC8004_REVIEWER_KEY is unset');
    return;
  }
  if (registrar && isAddressEqual(registrar, reviewer)) {
    show('feedback', 'REFUSED: the reviewer key is the registrar, and self-feedback reverts');
    return;
  }
  const owner = await ownerOf(agentId);
  show('agentId', agentId, owner ? `owned by ${owner}` : '(unregistered)');
  if (owner === undefined) return;
  if (isAddressEqual(owner, reviewer)) {
    show('feedback', 'REFUSED: the reviewer owns this agent (self-feedback)');
    return;
  }

  const before = await lastIndex(agentId, reviewer);
  show('reviewer entries before', before);
  const receipt = await step('feedback (live write)', () =>
    client.giveFeedback({
      agentId,
      value: bpsToValue(BigInt(arg('bps') ?? '250')),
      valueDecimals: ERC8004_VALUE_DECIMALS,
      tag1: ERC8004_PNL_TAG,
      tag2: arg('venue') ?? 'kuru',
      endpoint: '',
      feedbackURI: '',
      feedbackHash: ZERO_FEEDBACK_HASH,
    }),
  );
  if (!receipt) return;
  show('tx', receipt.txHash, `block ${receipt.blockNumber}`);
  const after = await lastIndex(agentId, reviewer);
  show('reviewer entries after', after);
  if (after <= before) {
    raise('the registry has no new entry for the reviewer: ' + `index is still ${after}`);
    return;
  }
  const entry = (await chain.readContract({
    address: ERC8004_REPUTATION_REGISTRY,
    abi: ERC8004_REPUTATION_ABI,
    functionName: 'readFeedback',
    args: [agentId, reviewer, after],
  })) as readonly [bigint, number, string, string, boolean];
  show(
    `entry ${after}`,
    `value=${entry[0]} valueDecimals=${entry[1]} tag1=${entry[2]} tag2=${entry[3]} revoked=${entry[4]}`,
    'read back from the registry',
  );
}

/** Fails the run without throwing out of a step. */
function raise(message: string): void {
  failures.push(`feedback: ${message}`);
  show('FAILED feedback', message);
}

async function ownerOf(agentId: bigint): Promise<Address | undefined> {
  try {
    return (await chain.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: ERC8004_IDENTITY_ABI,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address;
  } catch {
    return undefined;
  }
}

async function lastIndex(agentId: bigint, client: Address): Promise<bigint> {
  return (await chain.readContract({
    address: ERC8004_REPUTATION_REGISTRY,
    abi: ERC8004_REPUTATION_ABI,
    functionName: 'getLastIndex',
    args: [agentId, client],
  })) as bigint;
}

/** What the API would register a probe agent as, on this deployment's config. */
function probeAgentUri(): string {
  return agentUriFor({
    ...PROBE_AGENT,
    agentBaseUrl: config.agentBaseUrl,
    ...(config.mcpEndpoint ? { mcpEndpoint: config.mcpEndpoint } : {}),
    ...(config.imageUrl ? { imageUrl: config.imageUrl } : {}),
  });
}

/** `250n` basis points -> the registry's `value` at `valueDecimals` 2. */
function bpsToValue(bps: bigint): bigint {
  return bps * 10n ** BigInt(ERC8004_VALUE_DECIMALS - 2);
}

/** Unused at runtime; keeps the client type honest for the write paths above. */
export type LiveClient = Erc8004Client;

await main();
