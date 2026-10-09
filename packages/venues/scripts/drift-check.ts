// Drift check (SEN-186): every pinned fact about an external service, compared
// with what that service serves today. Read-only — no transaction, no wallet,
// no key enrolled — so it is safe to run anywhere, including after a deploy.
//
//   mise exec -- pnpm run drift:check [-- options]
//
//   --envio=<url>          the leaderboard indexer's GraphQL URL (else ENVIO_GRAPHQL_URL;
//                          the package script loads the repo's .env if there is one)
//   --rpc=<url>            Monad testnet RPC (default https://testnet-rpc.monad.xyz)
//   --perpl-address=<0x…>  an address that already HAS a Perpl account, for /payload
//   --skip-perpl-payload   do not call Perpl's /api-key/payload at all
//
// Why each check exists (docs/testing/test-audit-2026-10-09.md): Kuru moved its
// testnet to a new market set and the adapter silently dropped every pin that
// no longer matched; Perpl's enrollment struct grew from 6 to 11 fields and
// every Privy policy refused enrollment (CLAUDE.md gotcha 13). Nothing compared
// the pins with the live services, so both surfaced in production.
//
// `/api-key/payload` is safe to call: it only returns typed data and a MAC for
// the client to sign. A key slot is used by a successful `/enroll`, never by a
// payload (docs/user-trading.md, P5 and "Perpl voids a payload older than its
// last enrollment"), and the public key sent here is thrown away unsigned.
//
// Output: one `PASS|WARN|FAIL name — detail` line per check, a summary, and
// exit 1 on any FAIL.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';

import { createKuruApi, type ApiMarket } from '../src/kuru/api.ts';
import {
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  NATIVE_TOKEN,
  type KuruMarketConfig,
} from '../src/kuru/constants.ts';
import {
  PERPL_API_KEY_TYPED_DATA,
  PERPL_COLLATERAL_DECIMALS,
  PERPL_TESTNET_CHAIN_ID,
  PERPL_TESTNET_CONTRACTS,
} from '../src/perpl/constants.ts';
import { PerplEnrollmentError, requestEnrollPayload } from '../src/perpl/enroll.ts';
import { PERPL_NETWORKS } from '../src/perpl/public.ts';
import { newSecretKey, publicKeyOf } from '../src/perpl/signing.ts';
import type { PerplContext, PerplTypedData } from '../src/perpl/wire.ts';
// The copies the audit found, outside this package. Both modules are plain TS
// with type-only imports, so node's type stripping loads them as they are.
import {
  KURU_ACCOUNT_CORE,
  KURU_MARKETS as INDEXER_MARKETS,
  KURU_TOKEN_DECIMALS as INDEXER_TOKEN_DECIMALS,
} from '../../../services/indexer/src/lib/seeds.ts';
import { KURU_SPOT_MARKETS } from '../../presets/src/params.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const RPC_URL = flag('rpc') ?? 'https://testnet-rpc.monad.xyz';
const ENVIO_URL = flag('envio') ?? process.env.ENVIO_GRAPHQL_URL?.trim() ?? '';
/** The SEN-81 user wallet, Perpl account 1028 (docs/user-trading.md, P5). */
const PERPL_PAYLOAD_ADDRESS = flag('perpl-address') ?? '0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF';
const SKIP_PERPL_PAYLOAD = process.argv.includes('--skip-perpl-payload');
/**
 * Perps the product names by symbol: the presets' defaults and the app's
 * fallback list (`apps/mobile/src/presets/params.ts`) are BTC-PERP and ETH-PERP.
 */
const REQUIRED_PERPS = ['BTC', 'ETH'];
/** The leaderboard is wrong-but-plausible past this many blocks behind (~15 min). */
const MAX_ENVIO_LAG_BLOCKS = 2000;

// ---------------------------------------------------------------------------
// Reporting

type Status = 'PASS' | 'WARN' | 'FAIL';
const counts: Record<Status, number> = { PASS: 0, WARN: 0, FAIL: 0 };
function report(status: Status, name: string, detail: string): void {
  counts[status] += 1;
  console.log(`${status} ${name} — ${detail}`);
}

/** Runs one group; an exception inside it is that group's FAIL, not the run's crash. */
async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    report('FAIL', name, error instanceof Error ? error.message : String(error));
  }
}

const lower = (address: string) => address.toLowerCase();
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status} ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Monad RPC, serialised and spaced: the public endpoint allows ~15 req/s.

const RPC_SPACING_MS = 80;
let rpcQueue: Promise<unknown> = Promise.resolve();
let rpcLastStart = 0;
function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const call = rpcQueue.then(async () => {
    const wait = rpcLastStart + RPC_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    rpcLastStart = Date.now();
    const body = await getJson<{ result?: T; error?: { message: string } }>(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  });
  rpcQueue = call.catch(() => undefined);
  return call;
}

/** ERC-20 `decimals()`, for a catalog that leaves it out. */
async function chainDecimals(token: string): Promise<number> {
  if (lower(token) === lower(NATIVE_TOKEN)) return 18;
  const hex = await rpc<string>('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  return Number(BigInt(hex));
}

// ---------------------------------------------------------------------------
// Kuru

async function kuru(): Promise<void> {
  // The adapter's own call, so a change to how it reads the catalog is checked too.
  const catalog = await createKuruApi().markets();
  report('PASS', 'kuru catalog', `${catalog.length} active markets served`);

  for (const pin of KURU_TESTNET_MARKETS) {
    const live = catalog.find((m) => lower(m.marketAddress) === lower(pin.address));
    if (!live) {
      const namesake = catalog.find((m) => m.symbol === pin.venueSymbol);
      report(
        'FAIL',
        `kuru market ${pin.symbol}`,
        `${pin.address} is not in the active catalog` +
          (namesake ? ` (it lists ${namesake.symbol} at ${namesake.marketAddress})` : ''),
      );
      continue;
    }
    const diffs = await marketDiffs(pin, live);
    if (diffs.length === 0) {
      report('PASS', `kuru market ${pin.symbol}`, `${short(pin.address)} matches the catalog`);
    } else {
      report('FAIL', `kuru market ${pin.symbol}`, diffs.join('; '));
    }
  }

  const pinned = new Set(KURU_TESTNET_MARKETS.map((m) => lower(m.address)));
  const unpinned = catalog.filter((m) => !pinned.has(lower(m.marketAddress)));
  if (unpinned.length > 0) {
    report(
      'WARN',
      'kuru unpinned markets',
      `${unpinned.length} catalog market(s) not pinned: ` +
        unpinned.map((m) => `${m.symbol}@${short(m.marketAddress)}`).join(', '),
    );
  } else {
    report('PASS', 'kuru unpinned markets', 'every catalog market is pinned');
  }
}

async function marketDiffs(pin: KuruMarketConfig, live: ApiMarket): Promise<string[]> {
  const diffs: string[] = [];
  const same = (what: string, pinned: string, served: string) => {
    if (pinned !== served) diffs.push(`${what} pinned ${pinned}, served ${served}`);
  };
  same('venueSymbol', pin.venueSymbol, live.symbol);
  same('pricePrecision', String(pin.pricePrecision), String(live.pricePrecision));
  same('sizePrecision', String(pin.sizePrecision), String(live.sizePrecision));
  same('tickSize', String(pin.tickSize), String(live.tickSize));
  for (const [side, token, served] of [
    ['base', pin.base, live.baseToken],
    ['quote', pin.quote, live.quoteToken],
  ] as const) {
    same(`${side} token`, lower(token.address), lower(served.tokenAddress));
    // Typed as always present; read from chain if the catalog ever drops it.
    const decimals =
      typeof served.decimals === 'number' ? served.decimals : await chainDecimals(token.address);
    same(`${side} decimals`, String(token.decimals), String(decimals));
  }
  return diffs;
}

async function kuruCode(): Promise<void> {
  const targets = new Map<string, string>();
  for (const [name, address] of Object.entries(KURU_TESTNET_CONTRACTS)) targets.set(address, name);
  for (const token of Object.values(KURU_TESTNET_TOKENS)) {
    if (lower(token.address) !== lower(NATIVE_TOKEN)) targets.set(token.address, token.symbol);
  }
  for (const market of KURU_TESTNET_MARKETS) targets.set(market.address, market.symbol);

  const empty: string[] = [];
  for (const [address, name] of targets) {
    const code = await rpc<string>('eth_getCode', [address, 'latest']);
    if (!code || code === '0x') empty.push(`${name} ${address}`);
  }
  if (empty.length > 0) {
    report('FAIL', 'kuru eth_getCode', `no code at ${empty.join(', ')}`);
  } else {
    report('PASS', 'kuru eth_getCode', `all ${targets.size} pinned addresses have code`);
  }
}

// ---------------------------------------------------------------------------
// Perpl

async function perplContext(): Promise<void> {
  const context = await getJson<PerplContext>(`${PERPL_NETWORKS.testnet.restUrl}/v1/pub/context`);
  const problems: string[] = [];
  if (context.chain.chain_id !== PERPL_TESTNET_CHAIN_ID) {
    problems.push(`chain_id ${context.chain.chain_id}, pinned ${PERPL_TESTNET_CHAIN_ID}`);
  }
  const exchange = context.instances.find(
    (i) => lower(i.address) === lower(PERPL_TESTNET_CONTRACTS.exchange),
  );
  if (!exchange) {
    problems.push(
      `exchange ${PERPL_TESTNET_CONTRACTS.exchange} not served (instances: ` +
        `${context.instances.map((i) => i.address).join(', ')})`,
    );
  } else {
    const collateral = context.tokens.find((t) => t.id === exchange.collateral_token_id);
    if (!collateral || lower(collateral.address) !== lower(PERPL_TESTNET_CONTRACTS.collateral)) {
      problems.push(
        `collateral is ${collateral?.address ?? 'missing'}, pinned ${PERPL_TESTNET_CONTRACTS.collateral}`,
      );
    } else if (collateral.decimals !== PERPL_COLLATERAL_DECIMALS) {
      problems.push(
        `collateral decimals ${collateral.decimals}, pinned ${PERPL_COLLATERAL_DECIMALS}`,
      );
    }
  }
  if (problems.length > 0) report('FAIL', 'perpl contracts', problems.join('; '));
  else report('PASS', 'perpl contracts', 'exchange and AUSD collateral match the context');

  const missing = REQUIRED_PERPS.filter(
    (symbol) => !context.markets.some((m) => m.symbol === symbol && m.config.is_open),
  );
  if (missing.length > 0) {
    report('FAIL', 'perpl markets', `not served or not open: ${missing.join(', ')}`);
  } else {
    report(
      'PASS',
      'perpl markets',
      `${REQUIRED_PERPS.map((s) => `${s}-PERP`).join(', ')} open (${context.markets.length} served)`,
    );
  }
}

type Field = { name: string; type: string };

async function perplPayload(): Promise<void> {
  if (SKIP_PERPL_PAYLOAD) {
    report('WARN', 'perpl payload', 'skipped (--skip-perpl-payload)');
    return;
  }
  // The client's own request, with a throwaway key: never signed with, never enrolled.
  let live: PerplTypedData;
  try {
    ({ typed_data: live } = await requestEnrollPayload({
      restUrl: PERPL_NETWORKS.testnet.restUrl,
      chainId: PERPL_TESTNET_CHAIN_ID,
      address: PERPL_PAYLOAD_ADDRESS as `0x${string}`,
      publicKeyHex: `0x${bytesToHex(publicKeyOf(newSecretKey()))}`,
      scope: 1,
      label: 'sente-drift-check',
    }));
  } catch (error) {
    if (!(error instanceof PerplEnrollmentError)) throw error;
    const detail =
      error.status === 404
        ? `${PERPL_PAYLOAD_ADDRESS} has no Perpl account (404)`
        : `HTTP ${error.status} ${error.body.slice(0, 160)}`;
    report('FAIL', 'perpl payload', detail);
    return;
  }
  const pinned = PERPL_API_KEY_TYPED_DATA;
  const problems: string[] = [];
  const fields = (list: readonly Field[] | undefined) =>
    (list ?? []).map((f) => `${f.name}:${f.type}`).join(',');

  if (live.primaryType !== pinned.primaryType) {
    problems.push(`primaryType ${live.primaryType}, pinned ${pinned.primaryType}`);
  }
  const struct = pinned.types.PerplRegisterApiKey;
  if (fields(live.types[pinned.primaryType]) !== fields(struct)) {
    problems.push(
      `${pinned.primaryType} is [${fields(live.types[pinned.primaryType])}], pinned [${fields(struct)}]`,
    );
  }
  const extraTypes = Object.keys(live.types).filter(
    (t) => t !== 'EIP712Domain' && t !== pinned.primaryType,
  );
  if (extraTypes.length > 0) problems.push(`extra types ${extraTypes.join(', ')}`);
  // The domain type viem derives from the pinned domain: every key, salt included.
  const domainFields =
    'name:string,version:string,chainId:uint256,verifyingContract:address,salt:bytes32';
  if (fields(live.types.EIP712Domain) !== domainFields) {
    problems.push(`EIP712Domain is [${fields(live.types.EIP712Domain)}], pinned [${domainFields}]`);
  }
  const d = live.domain;
  if (d.name !== pinned.domain.name) problems.push(`domain.name ${d.name}`);
  if (d.version !== pinned.domain.version) problems.push(`domain.version ${d.version}`);
  if (d.chainId === undefined || Number(BigInt(d.chainId)) !== pinned.domain.chainId) {
    problems.push(`domain.chainId ${d.chainId}`);
  }
  if (lower(d.verifyingContract ?? '') !== lower(pinned.domain.verifyingContract)) {
    problems.push(`domain.verifyingContract ${d.verifyingContract}`);
  }
  // The salt's VALUE changes per read (constants.ts); only its presence is pinned.
  if (!/^0x[0-9a-fA-F]{64}$/.test(d.salt ?? '')) problems.push(`domain.salt ${d.salt}`);
  if (live.message.statement !== pinned.statement) {
    problems.push(`statement "${live.message.statement}"`);
  }

  if (problems.length > 0) {
    report(
      'FAIL',
      'perpl payload',
      `drifted from PERPL_API_KEY_TYPED_DATA: ${problems.join('; ')}`,
    );
  } else {
    report(
      'PASS',
      'perpl payload',
      `types, domain (minus salt) and statement equal PERPL_API_KEY_TYPED_DATA (${struct.length} fields)`,
    );
  }
}

// ---------------------------------------------------------------------------
// OpenRouter

async function agentModels(): Promise<string[]> {
  // Read as text: agents.config.ts imports the Privy key loader, which this
  // package has no business loading.
  const source = await readFile(join(REPO, 'services/api/src/agents/agents.config.ts'), 'utf8');
  const list = /export const AGENT_MODELS = \[([^\]]*)\]/.exec(source)?.[1];
  const ids = [...(list ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (ids.length === 0) throw new Error('could not read AGENT_MODELS from agents.config.ts');
  return ids;
}

async function openRouter(): Promise<void> {
  const ids = await agentModels();
  const { data } = await getJson<{ data: { id: string }[] }>('https://openrouter.ai/api/v1/models');
  const served = new Set(data.map((m) => m.id));
  const missing = ids.filter((id) => !served.has(id));
  if (missing.length > 0) {
    report('FAIL', 'openrouter models', `not listed: ${missing.join(', ')}`);
  } else {
    report('PASS', 'openrouter models', `${ids.join(', ')} listed`);
  }
}

// ---------------------------------------------------------------------------
// Envio

async function envio(): Promise<void> {
  if (!ENVIO_URL) {
    report('WARN', 'envio', 'no ENVIO_GRAPHQL_URL or --envio; skipped');
    return;
  }
  const body = await getJson<{
    data?: {
      chain_metadata: { latest_processed_block: number | null }[];
      Account: { id: string }[];
    };
    errors?: { message: string }[];
  }>(ENVIO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: '{ chain_metadata { latest_processed_block } Account(limit: 1) { id } }',
    }),
  });
  if (!body.data) throw new Error(`envio: ${body.errors?.map((e) => e.message).join('; ')}`);
  const processed = body.data.chain_metadata[0]?.latest_processed_block;
  const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
  if (typeof processed !== 'number') {
    report('FAIL', 'envio lag', 'chain_metadata has no latest_processed_block');
  } else {
    const lag = head - processed;
    report(
      lag < MAX_ENVIO_LAG_BLOCKS ? 'PASS' : 'FAIL',
      'envio lag',
      `${lag} blocks behind head ${head} (limit ${MAX_ENVIO_LAG_BLOCKS})`,
    );
  }
  if (body.data.Account.length === 0) {
    report('WARN', 'envio accounts', 'Account is empty; the leaderboard has nothing to rank');
  } else {
    report('PASS', 'envio accounts', 'Account has rows');
  }
}

// ---------------------------------------------------------------------------
// Copies of the pins outside this package

async function copies(): Promise<void> {
  // services/indexer/src/lib/seeds.ts
  const problems: string[] = [];
  const pins = new Map(KURU_TESTNET_MARKETS.map((m) => [lower(m.address), m]));
  const seeds = new Map(INDEXER_MARKETS.map((m) => [lower(m.address), m]));
  for (const [address, pin] of pins) {
    const seed = seeds.get(address);
    if (!seed) {
      problems.push(`${pin.symbol} ${short(address)} missing`);
      continue;
    }
    if (
      seed.symbol !== pin.symbol ||
      seed.pricePrecision !== pin.pricePrecision ||
      seed.sizePrecision !== pin.sizePrecision ||
      seed.baseDecimals !== pin.base.decimals ||
      seed.quoteDecimals !== pin.quote.decimals
    ) {
      problems.push(`${pin.symbol} differs`);
    }
  }
  for (const [address, seed] of seeds) {
    if (!pins.has(address)) problems.push(`${seed.symbol} ${short(address)} not pinned`);
  }
  if (lower(KURU_ACCOUNT_CORE) !== lower(KURU_TESTNET_CONTRACTS.accountCore)) {
    problems.push(`KURU_ACCOUNT_CORE ${KURU_ACCOUNT_CORE}`);
  }
  for (const token of Object.values(KURU_TESTNET_TOKENS)) {
    if (INDEXER_TOKEN_DECIMALS[lower(token.address)] !== token.decimals) {
      problems.push(`${token.symbol} decimals`);
    }
  }
  if (problems.length > 0) report('FAIL', 'indexer seeds.ts', problems.join('; '));
  else report('PASS', 'indexer seeds.ts', 'markets, AccountCore and token decimals match');

  // services/indexer/config.yaml — the `chains:` block, read as text.
  const yaml = await readFile(join(REPO, 'services/indexer/config.yaml'), 'utf8');
  const chains = yaml.slice(yaml.indexOf('\nchains:'), yaml.indexOf('\ncontracts:'));
  const orderBooks = chains.slice(
    chains.indexOf('name: KuruOrderBook'),
    chains.indexOf('name: KuruAccountCore'),
  );
  const accountCore = chains.slice(chains.indexOf('name: KuruAccountCore'));
  const addresses = (text: string) =>
    new Set([...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => lower(m[0])));
  const configured = addresses(orderBooks);
  const yamlProblems: string[] = [];
  for (const [address, pin] of pins) {
    if (!configured.has(address)) yamlProblems.push(`${pin.symbol} ${short(address)} missing`);
  }
  for (const address of configured) {
    if (!pins.has(address)) yamlProblems.push(`${short(address)} not pinned`);
  }
  if (!addresses(accountCore).has(lower(KURU_TESTNET_CONTRACTS.accountCore))) {
    yamlProblems.push('KuruAccountCore address differs');
  }
  if (yamlProblems.length > 0) report('FAIL', 'indexer config.yaml', yamlProblems.join('; '));
  else report('PASS', 'indexer config.yaml', 'OrderBook and AccountCore addresses match');

  // packages/presets/src/params.ts mirrors the symbols.
  const symbols = KURU_TESTNET_MARKETS.map((m) => m.symbol).sort();
  const mirrored = [...KURU_SPOT_MARKETS].sort();
  if (symbols.join(',') !== mirrored.join(',')) {
    report('FAIL', 'presets KURU_SPOT_MARKETS', `[${mirrored}] vs pinned [${symbols}]`);
  } else {
    report('PASS', 'presets KURU_SPOT_MARKETS', 'symbols match the pins');
  }
}

// ---------------------------------------------------------------------------

// One group after another, so the report reads in a stable order.
await group('kuru catalog', kuru);
await group('kuru eth_getCode', kuruCode);
await group('perpl context', perplContext);
await group('perpl payload', perplPayload);
await group('openrouter models', openRouter);
await group('envio', envio);
await group('copies', copies);

console.log(
  `\n${counts.FAIL > 0 ? 'DRIFT' : 'OK'}: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail`,
);
process.exit(counts.FAIL > 0 ? 1 : 0);
