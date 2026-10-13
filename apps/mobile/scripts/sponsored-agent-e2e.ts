// SEN-212: an end-to-end test of `AGENT_SPONSORED_SENDS=1` against a LOCAL API,
// driven the way a phone and an MCP client drive it. It moves real testnet
// funds, so it runs only when asked, one phase at a time — some phases need the
// API restarted with different flags in between (docs/privy-sponsorship.md,
// "Run 5").
//
//   pnpm --filter @sente/mobile run sponsored:e2e -- --api http://localhost:3712 \
//     --api-log <the API's stdout> --state-dir <the API's STATE_DIR> --phase <phase>
//
// The API runs with AGENT_SPONSORED_SENDS=1 unless a phase says otherwise, and
// with every shared sender key blank (GAS_DRIP_PRIVATE_KEYS, STARTER_DRIP_*,
// ERC8004_*). Phases, in order: setup, hire, fund, kuru, perpl, forbidden (API
// with AGENT_PRECHECK=off), amend, mon, signpath (API with
// AGENT_SPONSORED_SENDS=0), fallback (back on), monrefusal, return, revoke,
// sweep. Legs are read from the API's `[AgentTransactions]` log lines, so
// --api-log must be the log of the API running now. State (two throwaway
// private keys, the agent's MCP token) is kept in `<repo>/.secrets/` (0600,
// gitignored) and never printed.
//
// Production is refused (CLAUDE.md, "Tests never touch production"): any API
// under sente.lol exits 2. The treasury (TREASURY_PRIVATE_KEY) sends USDC and a
// little MON; the AUSD comes from Agora's faucet straight to the throwaway user.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { hexToBytes } from '@noble/hashes/utils.js';
import {
  KURU_DEPLOYMENT,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { loadAgentsConfig } from '../../../services/api/src/agents/agents.config.ts';
import { EnclaveRefusedError } from '../../../services/api/src/agents/agents.errors.ts';
import { PrivyAgentWalletProvider } from '../../../services/api/src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient } from '../../../services/api/src/agents/privy/privy.client.ts';
import { sponsoredAgentSendBody } from '../../../services/api/src/agents/privy/agent-wallet.ts';
import { AgentsApi, type Agent } from '../src/agents/api.ts';
import { amendMandateWithApproval, revokeWithApproval } from '../src/agents/approval.ts';
import { secureDeposits, needsDepositPin } from '../src/agents/depositPin.ts';
import { FUNDING_TOKENS } from '../src/agents/fund.ts';
import { fundAgent } from '../src/agents/initialFunding.ts';
import { buildMandate, type MandateForm, type Token } from '../src/agents/mandate.ts';
import { devicePublicKeySpki, signPrivyAuthorization } from '../src/auth/deviceKey.ts';
import { sendSponsored } from '../src/wallet/send.ts';
import { WalletApi } from '../src/wallet/api.ts';
import { newPhoneKeys, sessionAuth, USER_OPERATION_EVENT } from './phone.ts';
import { isProductionHost } from './productionGuard.ts';

// ---------------------------------------------------------------------------
// Arguments, guard, state

const argv = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

const API = (option('api') ?? 'http://localhost:3712').replace(/\/+$/, '');
const API_LOG = option('api-log');
const PHASE = option('phase');
if (isProductionHost(API)) {
  console.error(`refusing ${API}: production. This test runs against a local API only.`);
  process.exit(2);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRETS_DIR = join(REPO_ROOT, '.secrets');
const STATE_PATH = join(SECRETS_DIR, 'sen212-sponsored-e2e.json');

type State = {
  api: string;
  createdAt: string;
  authKey: Hex;
  deviceKey: string;
  stateDir?: string;
  user?: { walletId: string; walletAddress: Address };
  agent?: { id: string; walletId: string; address: Address; policyId: string };
  mcpToken?: string;
  notes: Record<string, unknown>;
};

function readState(): State | null {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State) : null;
}

function writeState(state: State): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const ignored = spawnSync('git', ['check-ignore', '-q', STATE_PATH], { cwd: REPO_ROOT });
  if (ignored.status !== 0) throw new Error(`${STATE_PATH} is not gitignored; refusing`);
  writeFileSync(`${STATE_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
}

// ---------------------------------------------------------------------------
// Chain, treasury, the phone

const rpc = process.env['MONAD_TESTNET_RPC_URL'];
const chain = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const USDC = KURU_TESTNET_TOKENS.USDC!;
const AUSD = FUNDING_TOKENS.find((t) => t.symbol === 'AUSD')!;
const AUSD_FAUCET = getAddress('0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C');
const SPOT = KURU_TESTNET_MARKETS.find((m) => m.symbol === KURU_DEPLOYMENT.liquidMarket)!;
const MON_MARKET = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
const ENTRY_POINT = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');

function treasuryKey(): Hex {
  const raw = process.env['TREASURY_PRIVATE_KEY']?.trim();
  if (!raw) throw new Error('TREASURY_PRIVATE_KEY is unset');
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

const tokenOf = (symbol: string): Token => FUNDING_TOKENS.find((t) => t.symbol === symbol)!;

async function erc20(token: Address, owner: Address): Promise<bigint> {
  return chain.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

async function mon(address: Address): Promise<string> {
  return formatEther(await chain.getBalance({ address, blockTag: 'latest' }));
}

function phone(state: State) {
  const account = privateKeyToAccount(state.authKey);
  const deviceKey = hexToBytes(state.deviceKey);
  const auth = sessionAuth(API, account);
  const options = { auth, baseUrl: API };
  return {
    address: account.address,
    deviceKey,
    wallet: new WalletApi(options),
    agents: new AgentsApi(options),
    sign: (payload: Parameters<typeof signPrivyAuthorization>[1]) =>
      signPrivyAuthorization(deviceKey, payload),
    async get<T>(path: string): Promise<T> {
      const token = auth.token() ?? (await auth.refresh());
      const response = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`GET ${path} → ${response.status}: ${text}`);
      return JSON.parse(text) as T;
    },
    async post<T>(path: string, body: unknown = {}): Promise<{ status: number; body: T }> {
      const token = auth.token() ?? (await auth.refresh());
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
    },
  };
}

function privy() {
  const config = loadAgentsConfig(process.env);
  if (!config.privy) throw new Error('PRIVY_* are unset');
  const client = new PrivyClient({ appId: config.privy.appId, appSecret: config.privy.appSecret });
  const provider = new PrivyAgentWalletProvider({
    client,
    agentKey: config.privy.agentAuthKey,
    mandateOwnerKey: config.privy.mandateOwnerKey,
  });
  return { client, provider, agentKey: config.privy.agentAuthKey };
}

// ---------------------------------------------------------------------------
// What the API did: its sender's per-transaction log lines (SEN-212), read
// back and checked against the chain.

type Leg = {
  via: string;
  ok: boolean;
  to: string;
  tx: Hash;
  userOp?: Hash;
  submitMs: number;
  confirmMs: number;
};

function apiLogLines(): string[] {
  if (!API_LOG) return [];
  // Nest colours its log lines: strip the ANSI escapes before matching.
  const escape = String.fromCharCode(27);
  return readFileSync(API_LOG, 'utf8')
    .replace(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '')
    .split('\n');
}

const LEG =
  /AgentTransactions\] (\S+) (ok|FAILED) wallet (\S+) to (0x[0-9a-fA-F]{40}): tx (0x[0-9a-f]{64})(?: userOp (0x[0-9a-f]{64}))?, submit (\d+) ms, confirm (\d+) ms/;

function legsSince(mark: number, walletId: string): Leg[] {
  return apiLogLines()
    .slice(mark)
    .flatMap((line) => {
      const m = LEG.exec(line);
      if (!m || m[3] !== walletId) return [];
      return [
        {
          via: m[1]!,
          ok: m[2] === 'ok',
          to: m[4]!,
          tx: m[5] as Hash,
          ...(m[6] ? { userOp: m[6] as Hash } : {}),
          submitMs: Number(m[7]),
          confirmMs: Number(m[8]),
        },
      ];
    });
}

/** The user operation's own outcome off the chain, plus what the gas would have cost. */
async function onChain(leg: Leg, agent: Address) {
  const receipt = await chain.getTransactionReceipt({ hash: leg.tx });
  if (!leg.userOp) {
    return {
      txStatus: receipt.status,
      from: receipt.from,
      gasPaidMon: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
    };
  }
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== ENTRY_POINT) continue;
    try {
      const event = decodeEventLog({
        abi: USER_OPERATION_EVENT,
        data: log.data,
        topics: log.topics,
      });
      if (event.args.userOpHash !== leg.userOp) continue;
      return {
        userOpSuccess: event.args.success,
        sender: event.args.sender,
        senderIsAgent: getAddress(event.args.sender) === getAddress(agent),
        paymaster: event.args.paymaster,
        actualGasCost: event.args.actualGasCost.toString(),
        actualGasUsed: event.args.actualGasUsed.toString(),
        // What Privy's credits covered, priced at the bundle's own gas price.
        creditsMonEquivalent: formatEther(event.args.actualGasUsed * receipt.effectiveGasPrice),
        block: receipt.blockNumber.toString(),
        bundler: receipt.from,
      };
    } catch {
      // not a UserOperationEvent
    }
  }
  return { error: `no UserOperationEvent for ${leg.userOp} in ${leg.tx}` };
}

async function report(label: string, mark: number, state: State, before: string) {
  const agent = state.agent!;
  const legs = legsSince(mark, agent.walletId);
  const after = await mon(agent.address);
  const rows = [];
  for (const leg of legs) rows.push({ ...leg, chain: await onChain(leg, agent.address) });
  const out = { label, monBefore: before, monAfter: after, legs: rows };
  console.log(JSON.stringify(out, null, 2));
  state.notes[label] = out;
  writeState(state);
  return out;
}

// ---------------------------------------------------------------------------
// MCP, as an outside client of the agent

/**
 * A minimal Streamable HTTP MCP client: initialize, then `tools/call`. Not the
 * SDK's: under `--conditions=source` it resolves a dependency's raw TypeScript,
 * which node refuses to strip inside node_modules.
 */
async function mcp(state: State) {
  let session: string | undefined;
  let id = 0;
  const rpcCall = async (method: string, params: unknown, notification = false) => {
    const response = await fetch(`${API}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${state.mcpToken!}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notification ? {} : { id: ++id }),
      }),
    });
    session ??= response.headers.get('mcp-session-id') ?? undefined;
    const text = await response.text();
    if (notification) return undefined;
    if (!response.ok) throw new Error(`MCP ${method} → ${response.status}: ${text}`);
    // JSON, or one SSE `message` event carrying it.
    const json = text.trimStart().startsWith('{')
      ? text
      : text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
    const message = JSON.parse(json) as { result?: unknown; error?: unknown };
    if (message.error) throw new Error(`MCP ${method}: ${JSON.stringify(message.error)}`);
    return message.result;
  };
  await rpcCall('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sen212-e2e', version: '1.0.0' },
  });
  await rpcCall('notifications/initialized', {}, true);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const started = Date.now();
      const result = (await rpcCall('tools/call', { name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = result.content.map((c) => c.text ?? '').join('\n');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // plain text
      }
      const ms = Date.now() - started;
      console.log(
        `mcp ${name} ${JSON.stringify(args)} → ${result.isError ? 'ERROR ' : ''}${ms} ms`,
      );
      console.log(
        `    ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`.slice(0, 1500),
      );
      return { isError: result.isError === true, body: parsed, ms };
    },
    close: async () => {
      if (!session) return;
      await fetch(`${API}/mcp`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${state.mcpToken!}`, 'mcp-session-id': session },
      }).catch(() => undefined);
    },
  };
}

/** Complete lines so far: the last element after the final newline is not one. */
const mark = () => Math.max(0, apiLogLines().length - 1);

// ---------------------------------------------------------------------------
// Privy reads

type PolicyRuleWire = { name: string; method: string; action: string };

async function policyShape(policyId: string) {
  const { client } = privy();
  const policy = await client.request<{ rules: PolicyRuleWire[]; owner_id?: string }>(
    'GET',
    `/v1/policies/${policyId}`,
  );
  const byMethod: Record<string, number> = {};
  for (const rule of policy.rules) byMethod[rule.method] = (byMethod[rule.method] ?? 0) + 1;
  const signNames = policy.rules
    .filter((r) => r.method === 'eth_signTransaction')
    .map((r) => r.name)
    .sort();
  const sendNames = policy.rules
    .filter((r) => r.method === 'eth_sendTransaction')
    .map((r) => r.name)
    .sort();
  return {
    rules: policy.rules.length,
    byMethod,
    // A twin's name is its sign rule's, cut to fit Privy's limit, plus " (sponsored)".
    everySignRuleHasASendTwin:
      signNames.length > 0 &&
      signNames.length === sendNames.length &&
      signNames.every((name) =>
        sendNames.some((twin) => {
          const stem = twin.replace(/ \(sponsored\)$/, '');
          return twin.endsWith(' (sponsored)') && name.startsWith(stem);
        }),
      ),
    ruleNames: policy.rules.map((r) => `${r.method}: ${r.name}`),
  };
}

function storedRecord(state: State): Record<string, unknown> | undefined {
  if (!state.stateDir) return undefined;
  const db = new DatabaseSync(join(state.stateDir, 'sente.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM agents WHERE id = ?').get(state.agent!.id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The mandate

function mandateForm(state: State, overrides: Partial<MandateForm> = {}): MandateForm {
  return {
    kuru: true,
    perpl: true,
    kuruMarkets: [SPOT.address, MON_MARKET.address],
    depositCaps: { USDC: '25', MON: '0.05' },
    perplCollateral: '100',
    perplMarkets: 'BTC-PERP',
    maxLeverage: '2',
    maxOrderNotional: '30',
    expiresAt: Math.floor(Date.now() / 1000) + 3 * 86_400,
    returnTo: state.user!.walletAddress,
    ...overrides,
  };
}

function built(form: MandateForm) {
  const result = buildMandate(form, Math.floor(Date.now() / 1000));
  if (!result.ok) throw new Error(`mandate does not build: ${JSON.stringify(result.errors)}`);
  return result.mandate;
}

// ---------------------------------------------------------------------------
// Phases

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(existing: State | null): Promise<void> {
  if (existing?.user) throw new Error(`${STATE_PATH} already has a user; delete it to start over`);
  const state: State = {
    api: API,
    createdAt: new Date().toISOString(),
    ...newPhoneKeys(),
    ...(option('state-dir') ? { stateDir: option('state-dir')! } : {}),
    notes: {},
  };
  writeState(state);
  const p = phone(state);
  const wallet = await p.wallet.register(devicePublicKeySpki(p.deviceKey));
  state.user = { walletId: wallet.walletId, walletAddress: wallet.address };
  writeState(state);
  console.log(
    `user wallet ${wallet.address} (Privy ${wallet.walletId}), starter kit ${JSON.stringify(wallet.starterKit)}`,
  );

  const treasury = privateKeyToAccount(treasuryKey());
  const writer = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(rpc),
  });
  const before = {
    mon: await mon(treasury.address),
    usdc: formatUnits(await erc20(USDC.address, treasury.address), 6),
    ausd: formatUnits(await erc20(AUSD.address, treasury.address), 6),
  };
  // 30 USDC from the treasury; AUSD from Agora's faucet, straight to the user.
  const usdcTx = await writer.writeContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [wallet.address, parseUnits('30', 6)],
    gas: 82_000n,
  });
  await chain.waitForTransactionReceipt({ hash: usdcTx });
  await sleep(3_000);
  const faucetTx = await writer.writeContract({
    address: AUSD_FAUCET,
    abi: [
      {
        name: 'requestFunds',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'recipient', type: 'address' }],
        outputs: [],
      },
    ],
    functionName: 'requestFunds',
    args: [wallet.address],
    gas: 150_000n,
  });
  const faucet = await chain.waitForTransactionReceipt({ hash: faucetTx });
  state.notes['setup'] = {
    treasuryBefore: before,
    usdcTx,
    faucetTx,
    faucetStatus: faucet.status,
    user: {
      usdc: formatUnits(await erc20(USDC.address, wallet.address), 6),
      ausd: formatUnits(await erc20(AUSD.address, wallet.address), 6),
      mon: await mon(wallet.address),
    },
  };
  writeState(state);
  console.log(JSON.stringify(state.notes['setup'], null, 2));
}

async function hire(state: State): Promise<void> {
  if (state.agent) throw new Error('already hired');
  const p = phone(state);
  const mandate = built(mandateForm(state));
  const started = Date.now();
  const { agent, mcpToken } = await p.agents.hire({
    name: 'sen212-sponsored-e2e',
    systemPrompt: 'SEN-212 end-to-end test agent. Never trade on your own.',
    strategy: 'Test only: every action comes from the test script over MCP.',
    model: 'moonshotai/kimi-k2.6',
    mandate,
    riskAcknowledged: true,
  });
  const hireMs = Date.now() - started;
  state.agent = {
    id: agent.id,
    walletId: agent.walletId,
    address: agent.address,
    policyId: agent.policyId,
  };
  state.mcpToken = mcpToken;
  writeState(state);
  console.log(
    `hired ${agent.id}: ${agent.address} (Privy ${agent.walletId}), policy ${agent.policyId}, ${agent.ownerKind}-owned, ${hireMs} ms`,
  );

  let pinned: Agent = agent;
  if (needsDepositPin(agent)) {
    const secured = await secureDeposits({
      api: p.agents,
      agent,
      mandate,
      ownWallet: state.user!.walletAddress,
      sign: p.sign,
    });
    if (secured.kind !== 'secured') throw new Error(`secureDeposits: ${JSON.stringify(secured)}`);
    pinned = secured.agent;
  }
  const record = storedRecord(state);
  state.notes['hire'] = {
    hireMs,
    ownerKind: agent.ownerKind,
    kuruDepositPinned: pinned.kuruDepositPinned,
    recordSponsoredSends: record?.['sponsoredSends'],
    policy: await policyShape(agent.policyId),
    agentMon: await mon(agent.address),
    code: await chain.getCode({ address: agent.address }),
  };
  writeState(state);
  console.log(JSON.stringify(state.notes['hire'], null, 2));
}

async function fund(state: State): Promise<void> {
  const p = phone(state);
  const agent = state.agent!;
  const send = (intent: Parameters<typeof sendSponsored>[1]) =>
    sendSponsored(p.wallet, intent, p.sign, { timeoutMs: 120_000 });
  const out: Record<string, unknown> = { monBefore: await mon(agent.address) };
  for (const [symbol, amount] of [
    ['USDC', '25'],
    ['AUSD', '100'],
  ] as const) {
    const token = tokenOf(symbol);
    const started = Date.now();
    const outcome = await fundAgent(send, {
      walletId: state.user!.walletId,
      token,
      to: agent.address,
      atoms: parseUnits(amount, token.decimals),
    });
    out[symbol] = { ...outcome, ms: Date.now() - started };
  }
  out['agent'] = {
    usdc: formatUnits(await erc20(USDC.address, agent.address), 6),
    ausd: formatUnits(await erc20(AUSD.address, agent.address), 6),
    mon: await mon(agent.address),
  };
  state.notes['fund'] = out;
  writeState(state);
  console.log(
    JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}

type McpClient = Awaited<ReturnType<typeof mcp>>;

/** Best bid and ask off `get_depth`, as decimal strings. */
async function bestOf(client: McpClient, market: string) {
  const depth = await client.call('get_depth', { venue: 'kuru', market, limit: 5 });
  const body = depth.body as { bids?: { price: string }[]; asks?: { price: string }[] };
  return { bid: body.bids?.[0]?.price, ask: body.asks?.[0]?.price };
}

/** `quote`'s worstPrice: the bound an agent passes to place_market. */
async function worstPrice(client: McpClient, market: string, side: 'buy' | 'sell', size: string) {
  const quote = await client.call('quote', {
    venue: 'kuru',
    market,
    side,
    size,
    maxSlippage: '0.02',
  });
  const price = (quote.body as { worstPrice?: string }).worstPrice;
  if (!price) throw new Error(`no worstPrice for ${side} ${size} ${market}`);
  return price;
}

/** One write through the agent, its legs reported off the API's log and the chain. */
async function write(
  state: State,
  client: McpClient,
  label: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const before = await mon(state.agent!.address);
  const m = mark();
  const result = await client.call(tool, args);
  await sleep(2_000);
  const legs = await report(label, m, state, before);
  state.notes[label] = { ...legs, toolMs: result.ms, isError: result.isError, tool: result.body };
  writeState(state);
  return result;
}

const SIZE_DECIMALS = Math.round(Math.log10(Number(SPOT.sizePrecision)));

type BalancesBody = { balances?: { asset: string; available: string }[] };

async function kuru(state: State): Promise<void> {
  const client = await mcp(state);
  const agent = state.agent!;
  try {
    await client.call('get_mandate');
    await client.call('record_thesis', {
      market: SPOT.symbol,
      direction: 'long',
      thesis: 'SEN-212 test: buy a little, then sell it back.',
      invalidation: 'Not a real trade; the test sells right after.',
    });
    if (!state.notes['kuru.deposit']) {
      await write(state, client, 'kuru.deposit', 'deposit', {
        market: SPOT.symbol,
        asset: 'USDC',
        amount: '20',
      });
    }

    // ~13 USDC of base at the ask, on the size step.
    const { ask } = await bestOf(client, SPOT.symbol);
    if (!ask) throw new Error('no ask on the book');
    const step = 10 ** -SIZE_DECIMALS;
    const size = (Math.ceil(13 / Number(ask) / step) * step).toFixed(SIZE_DECIMALS);
    await write(state, client, 'kuru.buy', 'place_market', {
      venue: 'kuru',
      market: SPOT.symbol,
      side: 'buy',
      size,
      slippageLimitPrice: await worstPrice(client, SPOT.symbol, 'buy', size),
    });

    const balances = await client.call('get_balances', { venue: 'kuru' });
    const body = balances.body as BalancesBody | BalancesBody[];
    const list = (Array.isArray(body) ? body[0]?.balances : body.balances) ?? [];
    const held = list.find((b) => b.asset === SPOT.base.symbol)?.available;
    if (!held || Number(held) === 0)
      throw new Error(`no ${SPOT.base.symbol} in Kuru after the buy`);
    const sellSize = (Math.floor(Number(held) / step) * step).toFixed(SIZE_DECIMALS);
    await client.call('record_thesis', {
      market: SPOT.symbol,
      direction: 'short',
      thesis: 'SEN-212 test: sell back what was bought.',
      invalidation: 'Not a real trade.',
    });
    await write(state, client, 'kuru.sell', 'place_market', {
      venue: 'kuru',
      market: SPOT.symbol,
      side: 'sell',
      size: sellSize,
      slippageLimitPrice: await worstPrice(client, SPOT.symbol, 'sell', sellSize),
    });
    await client.call('get_balances', { venue: 'kuru' });
  } finally {
    await client.close();
  }
  const p = phone(state);
  const events = await p.get<unknown>(`/agents/${agent.id}/events?limit=50`);
  state.notes['kuru.events'] = events;
  writeState(state);
  console.log(JSON.stringify(events).slice(0, 8000));
}

async function perpl(state: State): Promise<void> {
  const p = phone(state);
  const agent = state.agent!;
  if (!state.notes['perpl.onboard']) {
    const before = await mon(agent.address);
    const m = mark();
    const started = Date.now();
    const onboard = await p.post(`/agents/${agent.id}/perpl/onboard`);
    console.log(`onboard → ${onboard.status} ${JSON.stringify(onboard.body)}`);
    let status: { state?: string } = {};
    for (let i = 0; i < 40; i++) {
      status = await p.get(`/agents/${agent.id}/perpl`);
      console.log(`perpl ${JSON.stringify(status)}`.slice(0, 800));
      if (['ready', 'failed', 'needs_gas', 'cap_below_minimum'].includes(status.state ?? '')) break;
      await sleep(3_000);
    }
    const ms = Date.now() - started;
    const legs = await report('perpl.onboard', m, state, before);
    state.notes['perpl.onboard'] = { ...legs, ms, status };
    writeState(state);
    if (status.state !== 'ready') throw new Error(`Perpl onboarding ended ${status.state}`);
  }

  const client = await mcp(state);
  try {
    const markets = await client.call('list_markets', { venue: 'perpl' });
    const list =
      (markets.body as { markets?: { symbol: string; minSize?: string }[] }[])[0]?.markets ?? [];
    const minSize = list.find((x) => x.symbol === 'BTC-PERP')?.minSize ?? '0.001';
    const quote = await client.call('quote', {
      venue: 'perpl',
      market: 'BTC-PERP',
      side: 'buy',
      size: minSize,
      maxSlippage: '0.02',
    });
    const bound = (quote.body as { worstPrice?: string }).worstPrice;
    if (!bound) throw new Error('no Perpl quote');
    await client.call('record_thesis', {
      market: 'BTC-PERP',
      direction: 'long',
      thesis: 'SEN-212 test: the smallest long, closed right after.',
      invalidation: 'Not a real trade.',
    });
    await write(state, client, 'perpl.order', 'place_market', {
      venue: 'perpl',
      market: 'BTC-PERP',
      side: 'buy',
      size: minSize,
      slippageLimitPrice: bound,
      leverage: 1,
    });
    await sleep(3_000);
    await client.call('get_positions');
    await write(state, client, 'perpl.close', 'close_position', { market: 'BTC-PERP' });
    await sleep(3_000);
    state.notes['perpl.positionsAfter'] = (await client.call('get_positions')).body;
    writeState(state);
  } finally {
    await client.close();
  }
}

async function forbidden(state: State): Promise<void> {
  const agent = state.agent!;
  const { client, provider } = privy();
  const out: Record<string, unknown> = {};
  const nonceBefore = await chain.getTransactionCount({ address: agent.address });
  const blockBefore = await chain.getBlockNumber();
  const before = await mon(agent.address);

  // 1. Through the agent (AGENT_PRECHECK=off on the API, so nothing of ours
  //    stands between the tool and the enclave): a deposit over the 25 USDC cap.
  const mcpClient = await mcp(state);
  const m = mark();
  try {
    await mcpClient.call('record_thesis', {
      market: SPOT.symbol,
      direction: 'long',
      thesis: 'SEN-212: a deposit over the cap, which the enclave must refuse.',
      invalidation: 'n/a',
    });
    out['overCapDeposit'] = await mcpClient.call('deposit', {
      market: SPOT.symbol,
      asset: 'USDC',
      amount: '26',
    });
    // A market the mandate never names: WETH-USDC on Set C.
    const weth = KURU_TESTNET_MARKETS.find((x) => x.symbol === 'WETH-USDC');
    if (weth) {
      await mcpClient.call('record_thesis', {
        market: 'WETH-USDC',
        direction: 'long',
        thesis: 'SEN-212: a market the mandate never names.',
        invalidation: 'n/a',
      });
      out['unlistedMarket'] = await mcpClient.call('place_market', {
        venue: 'kuru',
        market: 'WETH-USDC',
        side: 'buy',
        size: '0.001',
        slippageLimitPrice: '100000',
      });
    }
  } finally {
    await mcpClient.close();
  }
  out['apiLegs'] = legsSince(m, agent.walletId);

  // 2. Straight at the sponsored path with the agent key: Privy's own answer.
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const calls = {
    approveOverCap: {
      to: USDC.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [accountCore, parseUnits('26', 6)],
      }),
    },
    approveUnlistedToken: {
      to: AUSD.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [accountCore, parseUnits('1', 6)],
      }),
    },
    transferElsewhere: {
      to: USDC.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: ['0x000000000000000000000000000000000000dEaD', 0n],
      }),
    },
  };
  for (const [name, call] of Object.entries(calls)) {
    const started = Date.now();
    try {
      const sent = await provider.sendSponsoredTransaction(agent.walletId, 10143, call);
      out[name] = { refused: false, sent, ms: Date.now() - started };
    } catch (error) {
      out[name] = {
        refused: error instanceof EnclaveRefusedError,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        method: (error as { method?: string }).method,
        ms: Date.now() - started,
      };
    }
  }

  // 3. One allowed call, raw, to read every field Privy answers with.
  const allowed = sponsoredAgentSendBody(10143, {
    to: USDC.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [accountCore, 1n] }),
    value: 0n,
  });
  const { agentKey } = privy();
  const started = Date.now();
  const raw = await client.post<{ data?: Record<string, unknown> }>(
    `/v1/wallets/${agent.walletId}/rpc`,
    allowed,
    { approvals: [agentKey] },
  );
  out['allowedRaw'] = { ms: Date.now() - started, response: raw };

  await sleep(5_000);
  const logs = await chain.getLogs({
    address: ENTRY_POINT,
    event: USER_OPERATION_EVENT[0],
    args: { sender: agent.address },
    fromBlock: blockBefore,
    toBlock: 'latest',
  });
  out['userOpsFromAgentSince'] = logs.map((l) => ({
    userOpHash: l.args.userOpHash,
    success: l.args.success,
    tx: l.transactionHash,
  }));
  out['nonce'] = {
    before: nonceBefore,
    after: await chain.getTransactionCount({ address: agent.address }),
  };
  out['mon'] = { before, after: await mon(agent.address) };
  state.notes['forbidden'] = out;
  writeState(state);
  console.log(JSON.stringify(out, null, 2));
}

async function amendTo(state: State, label: string, overrides: Partial<MandateForm>) {
  const p = phone(state);
  const agent = await p.agents.get(state.agent!.id);
  const mandate = built(mandateForm(state, overrides));
  const started = Date.now();
  const amended = await amendMandateWithApproval(
    p.agents,
    agent,
    mandate,
    state.user!.walletAddress,
    p.sign,
  );
  const result = {
    ms: Date.now() - started,
    maxOrderNotional: amended.mandate.maxOrderNotional,
    recordSponsoredSends: storedRecord(state)?.['sponsoredSends'],
    policy: await policyShape(agent.policyId),
  };
  state.notes[label] = result;
  writeState(state);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** One small deposit through the agent, reported per leg. */
async function smallDeposit(state: State, label: string, asset: 'USDC' | 'MON', amount: string) {
  const client = await mcp(state);
  const market = asset === 'MON' ? MON_MARKET.symbol : SPOT.symbol;
  try {
    await client.call('record_thesis', {
      market,
      direction: 'long',
      thesis: `SEN-212: ${label}`,
      invalidation: 'n/a',
    });
    const before = await mon(state.agent!.address);
    const m = mark();
    const result = await client.call('deposit', { market, asset, amount });
    await sleep(2_000);
    const legs = await report(label, m, state, before);
    state.notes[label] = { ...legs, tool: result };
    writeState(state);
  } finally {
    await client.close();
  }
}

async function amend(state: State): Promise<void> {
  await amendTo(state, 'amend.on', {
    maxOrderNotional: '35',
    depositCaps: { USDC: '24', MON: '0.05' },
  });
  await smallDeposit(state, 'amend.on.deposit', 'USDC', '1');
}

async function monPhase(state: State): Promise<void> {
  const agent = state.agent!;
  const treasury = privateKeyToAccount(treasuryKey());
  const writer = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(rpc),
  });
  if ((await chain.getBalance({ address: agent.address })) < parseEther('0.05')) {
    const code = await chain.getCode({ address: agent.address });
    // 21,000 runs out of gas: the delegated account executes Kernel's code on receive.
    const tx = await writer.sendTransaction({
      to: agent.address,
      value: parseEther('0.05'),
      gas: 60_000n,
    });
    const receipt = await chain.waitForTransactionReceipt({ hash: tx });
    state.notes['mon.fund'] = {
      tx,
      status: receipt.status,
      codeBefore: code,
      mon: await mon(agent.address),
    };
    writeState(state);
    console.log(JSON.stringify(state.notes['mon.fund']));
  }
  // A native MON deposit: the one call whose value is the agent's own MON.
  await smallDeposit(state, 'mon.depositNative', 'MON', '0.01');
  // And an ERC-20 one, sponsored, from the delegated wallet now holding MON.
  await smallDeposit(state, 'mon.depositUsdc', 'USDC', '1');
}

/** One Kuru withdraw through the agent (a single leg), reported. */
async function smallWithdraw(state: State, label: string) {
  const client = await mcp(state);
  try {
    await write(state, client, label, 'withdraw', { asset: 'USDC', amount: '1' });
  } finally {
    await client.close();
  }
}

/** Tops the agent up to `target` MON from the treasury (60,000 gas: it has code). */
async function topUpMon(state: State, target: string) {
  const agent = state.agent!.address;
  const have = await chain.getBalance({ address: agent });
  if (have >= parseEther(target)) return;
  const treasury = privateKeyToAccount(treasuryKey());
  const writer = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(rpc),
  });
  const tx = await writer.sendTransaction({
    to: agent,
    value: parseEther(target) - have,
    gas: 60_000n,
  });
  const receipt = await chain.waitForTransactionReceipt({ hash: tx });
  state.notes[`topUp.${target}`] = { tx, status: receipt.status, mon: await mon(agent) };
  writeState(state);
  console.log(JSON.stringify(state.notes[`topUp.${target}`]));
}

async function signpath(state: State): Promise<void> {
  // API restarted with AGENT_SPONSORED_SENDS=0: the rollback case. The agent
  // is delegated and pays its own gas again.
  await topUpMon(state, '0.15');
  await smallWithdraw(state, 'signpath.withdraw');
  await smallDeposit(state, 'signpath.depositNative', 'MON', '0.005');
  // An amend with the flag off: the policy loses its sponsored twins.
  await amendTo(state, 'signpath.amendOff', {
    maxOrderNotional: '33',
    depositCaps: { USDC: '23', MON: '0.05' },
  });
}

async function fallback(state: State): Promise<void> {
  // API back on AGENT_SPONSORED_SENDS=1, the policy without twins: every send
  // is refused on the sponsored path and carried by the sign path.
  await smallWithdraw(state, 'fallback.withdraw');
  await amendTo(state, 'fallback.amendOn', {
    maxOrderNotional: '32',
    depositCaps: { USDC: '22', MON: '0.05' },
  });
  await smallWithdraw(state, 'fallback.afterAmend');
}

async function returnFunds(state: State, label: string): Promise<void> {
  const p = phone(state);
  const agent = state.agent!;
  const before = await mon(agent.address);
  const m = mark();
  const started = Date.now();
  const result = await p.post(`/agents/${agent.id}/return`, {});
  const ms = Date.now() - started;
  console.log(`return → ${result.status} (${ms} ms) ${JSON.stringify(result.body)}`);
  await sleep(2_000);
  const legs = await report(label, m, state, before);
  state.notes[label] = {
    ...legs,
    status: result.status,
    body: result.body,
    ms,
    agentAfter: {
      usdc: formatUnits(await erc20(USDC.address, agent.address), 6),
      ausd: formatUnits(await erc20(AUSD.address, agent.address), 6),
      base: formatUnits(await erc20(SPOT.base.address, agent.address), SPOT.base.decimals),
    },
  };
  writeState(state);
}

async function revoke(state: State): Promise<void> {
  const p = phone(state);
  const agent = await p.agents.get(state.agent!.id);
  // Something for the revoked agent to send home through the revocation rules' twins.
  state.notes['revoke.fund'] = await fundAgent(
    (intent) => sendSponsored(p.wallet, intent, p.sign, { timeoutMs: 120_000 }),
    { walletId: state.user!.walletId, token: USDC, to: agent.address, atoms: parseUnits('2', 6) },
  );
  writeState(state);
  const started = Date.now();
  const revoked = await revokeWithApproval(p.agents, agent, state.user!.walletAddress, p.sign);
  state.notes['revoke'] = {
    ms: Date.now() - started,
    status: revoked.status,
    recordSponsoredSends: storedRecord(state)?.['sponsoredSends'],
    policy: await policyShape(agent.policyId),
  };
  writeState(state);
  console.log(JSON.stringify(state.notes['revoke'], null, 2));
  // Whatever is left, after the revoke, through the revocation rules' twins.
  await returnFunds(state, 'revoke.return');
  const portfolio = await p.get(`/agents/${agent.id}/portfolio`);
  const archive = await p.post(`/agents/${agent.id}/archive`, {});
  state.notes['archive'] = {
    status: archive.status,
    body: archive.body,
    portfolio,
    agentMon: await mon(agent.address),
  };
  writeState(state);
  console.log(JSON.stringify(state.notes['archive'], null, 2));
}

/**
 * The throwaway user's leftovers back to the treasury. The API composes a send
 * only to the user's own agents, so this goes to Privy directly: a sponsored
 * transfer the device key approves, as the wallet's owner (SEN-40).
 */
async function sweep(state: State): Promise<void> {
  const p = phone(state);
  const { client } = privy();
  const treasury = privateKeyToAccount(treasuryKey()).address;
  const out: Record<string, unknown> = {};
  for (const symbol of ['USDC', 'AUSD', SPOT.base.symbol]) {
    const token = tokenOf(symbol);
    if (!token) continue;
    const have = await erc20(token.address, state.user!.walletAddress);
    if (have === 0n) continue;
    const path = `/v1/wallets/${state.user!.walletId}/rpc`;
    const body = sponsoredAgentSendBody(10143, {
      to: token.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [treasury, have] }),
      value: 0n,
    });
    const signature = p.sign(client.authorizationPayload('POST', path, body));
    const sent = await client.request<{ data?: { user_operation_hash?: string } }>(
      'POST',
      path,
      body,
      { signatures: [signature] },
    );
    out[symbol] = { atoms: have.toString(), userOpHash: sent.data?.user_operation_hash };
    await sleep(5_000);
  }
  out['userAfter'] = {
    usdc: formatUnits(await erc20(USDC.address, state.user!.walletAddress), 6),
    ausd: formatUnits(await erc20(AUSD.address, state.user!.walletAddress), 6),
  };
  out['treasuryAfter'] = {
    mon: await mon(treasury),
    usdc: formatUnits(await erc20(USDC.address, treasury), 6),
    ausd: formatUnits(await erc20(AUSD.address, treasury), 6),
  };
  state.notes['sweep'] = out;
  writeState(state);
  console.log(JSON.stringify(out, null, 2));
}

async function main(): Promise<void> {
  const health = await fetch(`${API}/health`).then((r) => r.json() as Promise<{ status?: string }>);
  if (health.status !== 'ok') throw new Error(`${API}/health: ${JSON.stringify(health)}`);
  const state = readState();
  if (PHASE === 'setup') return setup(state);
  if (!state) throw new Error('run --phase setup first');
  if (state.api !== API) throw new Error(`state was made against ${state.api}, not ${API}`);
  const phases: Record<string, (s: State) => Promise<void>> = {
    hire,
    fund,
    kuru,
    perpl,
    forbidden,
    amend,
    mon: monPhase,
    signpath,
    fallback,
    // After the native_mon_reserve fix: refused before anything is sent.
    monrefusal: (s) => smallDeposit(s, 'mon.depositNativeRefused', 'MON', '0.01'),
    return: (s) => returnFunds(s, 'return'),
    revoke,
    sweep,
  };
  const run = PHASE ? phases[PHASE] : undefined;
  if (!run) throw new Error(`--phase one of: setup, ${Object.keys(phases).join(', ')}`);
  await run(state);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
