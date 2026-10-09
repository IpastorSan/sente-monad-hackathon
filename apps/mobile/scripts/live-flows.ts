// Post-deploy real flows (SEN-186, tier 3 stage B of the 2026-10-09 test audit):
// one persistent test user and one persistent agent, driven through the app's
// REAL code, against a deployed API. This script is a phone, like
// `trade-live.ts`, and it moves real testnet funds, so it runs only when asked.
//
//   pnpm --filter @sente/mobile run live:flows -- --bootstrap [--resume] [--api <url>] [--yes]
//   pnpm --filter @sente/mobile run live:flows -- [--api <url>] [--yes]
//
// `infra/live-check.sh --flows` runs the second form (one line there:
// `mise exec -- pnpm --filter @sente/mobile run live:flows -- --yes`).
//
// --api   defaults to https://api.sente.lol. The target is printed first, and
//         production is refused without --yes. A run refuses any host other
//         than the one recorded at bootstrap.
//
// --bootstrap, once: a new identity in `<repo>/.secrets/sente-live-check-user.json`
// (0600, gitignored, never printed), then POST /wallet/register and the starter
// kit, the user's Perpl account (100 AUSD) and trade key, ONE device-owned agent
// `live-check-agent` (Kimi, manual schedule) funded through the Fund path with
// 15 USDC and 100 AUSD, and that agent's own Perpl account opened with its
// enclave-held key (PRIVY_* from the repo .env, the same keys as the box). It
// refuses when the file already names anything; `--resume` finishes a
// bootstrap that stopped part-way and creates only what is missing.
//
// A run (no flag), stopping at the first FAIL, each step PASS/FAIL:
//   1 session   sign in, GET /wallet: starter kit sent, enough USDC and AUSD
//   2 pre-cleanup  no open orders or positions anywhere, else clean up and FAIL
//   3 kuru      runTrade: post-only bid at half the best bid, minimum notional,
//               then its cancel; every step's user operation read off the chain
//   4 perpl     the phone's Perpl trader through `<api>/perpl`: post-only bid at
//               half the mark, minimum size, cancel, no positions
//   5 agent-run POST /agents/:id/run, judged on its events; credits budget
//   6 enclave-refusal  SIGN-ONLY with the agent key: an over-cap Kuru deposit is
//               refused and the nonce does not move; a within-cap one is signed
//               and never broadcast
//   7 post-cleanup  as 2, the user's Kuru USDC back to the wallet, then deltas
//
// Ids that must survive a retry (the `/trade` client trade ids) derive from the
// run id, the UTC day and the git commit.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hexToBytes } from '@noble/hashes/utils.js';
import {
  depositCalls,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  type KuruMarketConfig,
} from '@sente/venues/kuru';
import { erc20Abi, formatEther, formatUnits, parseUnits, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadAgentsConfig } from '../../../services/api/src/agents/agents.config.ts';
import { EnclaveRefusedError } from '../../../services/api/src/agents/agents.errors.ts';
import { privyTransaction } from '../../../services/api/src/agents/privy/agent-wallet.ts';
import { PrivyAgentWalletProvider } from '../../../services/api/src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient } from '../../../services/api/src/agents/privy/privy.client.ts';
import { InMemoryAgentSecretStore } from '../../../services/api/src/agents/venues/agent-secret-store.ts';
import {
  agentChainClient,
  AgentTransactionSender,
} from '../../../services/api/src/agents/venues/agent-transactions.ts';
import {
  PERPL_ONBOARDING_GAS,
  PerplAgentAccounts,
  perplAccountReader,
} from '../../../services/api/src/agents/venues/perpl-agent.ts';
import { kuruGasLimit } from '../../../services/api/src/agents/venues/privy-kuru-submitter.ts';
import { AgentsApi, type Agent, type RunResult } from '../src/agents/api.ts';
import { FUNDING_TOKENS } from '../src/agents/fund.ts';
import { fundAgent } from '../src/agents/initialFunding.ts';
import { buildMandate, type Token } from '../src/agents/mandate.ts';
import { devicePublicKeySpki, signPrivyAuthorization } from '../src/auth/deviceKey.ts';
import { perplTradeKey } from '../src/auth/perplKey.ts';
import { publicClient } from '../src/chain/client.ts';
import { CreditsApi } from '../src/credits/api.ts';
import { MarketsApi } from '../src/markets/api.ts';
import { isPerpsEnabled, isTradingEnabled, TradeApi } from '../src/trade/api.ts';
import {
  kuruCancelDraft,
  perplSetupNeeds,
  runPerplEnrollment,
  runPerplOnboard,
  runTrade,
  type KuruTradeDraft,
  type TradeFlowState,
} from '../src/trade/flow.ts';
import { readMarketFacts } from '../src/trade/kuruMarket.ts';
import { perplProxyNetwork } from '../src/trade/perplProxy.ts';
import { createPerplTrader, type PerplTrader } from '../src/trade/perplTrader.ts';
import type { TradeView } from '../src/trade/types.ts';
import { sendSponsored } from '../src/wallet/send.ts';
import { WalletApi, type SessionAuth, type UserWallet } from '../src/wallet/api.ts';
import {
  AGENT_INSTRUCTION,
  AGENT_MODEL,
  AGENT_NAME,
  agentMandateForm,
  agentMaxOrderNotional,
  BOOTSTRAP,
  bootstrapRefusal,
  clientTradeIdFor,
  creditsProblems,
  decimalHalfOnTick,
  DECIMALS,
  deltaProblems,
  deltasOf,
  halfOnTick,
  judgeAgentRun,
  normalizeApi,
  parseSecrets,
  PERPL_KEY_LABEL,
  PERPL_SYMBOL,
  PRODUCTION_API,
  recordedIds,
  remainingPhases,
  runIdOf,
  runRefusal,
  SECRETS_FILE_NAME,
  signed,
  startBudgetProblems,
  targetRefusal,
  type CreditsReading,
  type Holdings,
  type LiveSecrets,
  type RunEvent,
} from './live-flows/plan.ts';
import { landedAt, newPhoneKeys, sessionAuth, sizeForNotional } from './phone.ts';

// ---------------------------------------------------------------------------
// Arguments and the secrets file

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

/** The repo root from this file's own location, never the cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRETS_DIR = join(REPO_ROOT, '.secrets');
const SECRETS_PATH = join(SECRETS_DIR, SECRETS_FILE_NAME);

function readSecrets(): LiveSecrets | null {
  if (!existsSync(SECRETS_PATH)) return null;
  return parseSecrets(readFileSync(SECRETS_PATH, 'utf8'));
}

/** Refuses a path git would track: the file holds two private keys. */
function writeSecrets(secrets: LiveSecrets): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const ignored = spawnSync('git', ['check-ignore', '-q', SECRETS_PATH], { cwd: REPO_ROOT });
  if (ignored.status !== 0) {
    throw new Error(`${SECRETS_PATH} is not gitignored; refusing to write keys there`);
  }
  const temporary = `${SECRETS_PATH}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, SECRETS_PATH);
}

function gitSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git rev-parse HEAD failed');
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Output

class StepFailure extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'StepFailure';
    this.kind = kind;
  }
}

const fail = (kind: string, message: string): never => {
  throw new StepFailure(kind, message);
};

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const note = (text: string) => console.log(`       ${text}`);

/** Runs one step, prints PASS or FAIL, and rethrows a failure so the run stops there. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return result;
  } catch (error) {
    const kind = error instanceof StepFailure ? error.kind : name;
    console.log(
      `FAIL ${name}: ${kind} — ${error instanceof StepFailure ? error.message : describe(error)}`,
    );
    throw error;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const atoms = (value: bigint) => formatUnits(value, DECIMALS);

// ---------------------------------------------------------------------------
// The phone

const USDC = KURU_TESTNET_TOKENS.USDC;
const tokenBySymbol = (symbol: string): Token => {
  const token = FUNDING_TOKENS.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`no funding token ${symbol}`);
  return token;
};

type Phone = {
  api: string;
  address: Address;
  deviceKey: Uint8Array;
  auth: SessionAuth;
  wallet: WalletApi;
  trade: TradeApi;
  agents: AgentsApi;
  credits: CreditsApi;
  markets: MarketsApi;
  sign: (payload: Parameters<typeof signPrivyAuthorization>[1]) => string;
};

function phoneFor(api: string, secrets: LiveSecrets): Phone {
  const account = privateKeyToAccount(secrets.authKey);
  const deviceKey = hexToBytes(secrets.deviceKey);
  const auth = sessionAuth(api, account);
  const options = { auth, baseUrl: api };
  return {
    api,
    address: account.address,
    deviceKey,
    auth,
    wallet: new WalletApi(options),
    trade: new TradeApi(options),
    agents: new AgentsApi(options),
    credits: new CreditsApi(options),
    markets: new MarketsApi(options),
    sign: (payload) => signPrivyAuthorization(deviceKey, payload),
  };
}

/** Prints each flow phase once, not every poll of `following`. */
function progress(): (state: TradeFlowState) => void {
  let last = '';
  return (state) => {
    if (state.phase !== last) note(state.phase);
    last = state.phase;
  };
}

/** The Perpl trader the web build uses: through Sente's proxy (`createAppPerplTrader` on web). */
function perplTrader(phone: Phone, walletAddress: Address, apiKey: string): PerplTrader {
  const key = perplTradeKey(phone.deviceKey, walletAddress);
  try {
    return createPerplTrader({
      credentials: { apiKey, secretKey: key.secretKey },
      ...perplProxyNetwork(phone.api),
    });
  } finally {
    key.secretKey.fill(0);
  }
}

async function perplMarket(
  phone: Phone,
): Promise<{ minSize: string; tickSize: string; mark: string }> {
  const { markets } = await phone.markets.markets();
  const market = markets.find((m) => m.venue === 'perpl' && m.symbol === PERPL_SYMBOL);
  if (!market) return fail('perpl', `/markets lists no Perpl ${PERPL_SYMBOL}`);
  const ticker = await phone.markets.ticker('perpl', PERPL_SYMBOL);
  if (!ticker.mark) return fail('perpl', `${PERPL_SYMBOL} has no mark price`);
  return { minSize: market.minSize, tickSize: market.tickSize, mark: ticker.mark };
}

async function erc20Balance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

// ---------------------------------------------------------------------------
// Bootstrap

async function bootstrap(api: string, existing: LiveSecrets | null): Promise<void> {
  const refusal = bootstrapRefusal(existing, flag('resume'));
  if (refusal) {
    console.log(refusal);
    process.exitCode = existing && remainingPhases(existing).length === 0 ? 0 : 1;
    return;
  }
  let secrets: LiveSecrets = existing ?? {
    version: 1,
    api,
    createdAt: new Date().toISOString(),
    ...newPhoneKeys(),
  };
  const save = (next: LiveSecrets) => {
    secrets = next;
    writeSecrets(next);
  };
  if (!existing) {
    save(secrets);
    console.log(`identity     new keys in ${SECRETS_PATH} (0600, never printed)`);
  }
  const phone = phoneFor(api, secrets);
  console.log(`auth address ${phone.address}`);
  const idempotency = (phase: string) => () =>
    clientTradeIdFor(`bootstrap-${secrets.createdAt}`, phase);

  // 1. The user's wallet, and the starter kit it is sent.
  let wallet: UserWallet = await phone.wallet.register(devicePublicKeySpki(phone.deviceKey));
  if (!secrets.user) {
    for (let i = 0; wallet.starterKit?.status !== 'sent'; i++) {
      const status = wallet.starterKit?.status ?? 'none';
      if (status === 'failed' || status === 'disabled' || i >= 60) {
        throw new Error(`starter kit ${status}: the bootstrap needs it sent`);
      }
      await sleep(5_000);
      wallet = await phone.wallet.account();
    }
    save({
      ...secrets,
      user: { address: phone.address, walletId: wallet.walletId, walletAddress: wallet.address },
    });
  }
  const user = secrets.user!;
  console.log(`user wallet  ${user.walletAddress} (Privy ${user.walletId})`);
  console.log(`starter kit  ${JSON.stringify(wallet.starterKit)}`);
  const ctx = { walletId: user.walletId, wallet: user.walletAddress };

  // 2. The user's Perpl account (100 AUSD) and the phone's trade key.
  let account = await phone.trade.perplAccount();
  const needs = perplSetupNeeds(account, secrets.perpl?.apiKey ?? null);
  if (needs.open || needs.forwarding) {
    const outcome = await runPerplOnboard(
      phone.trade,
      { amountAtoms: BOOTSTRAP.perplOpenAtoms.toString() },
      { ...ctx, accountOpen: !needs.open },
      phone.sign,
      progress(),
      { newClientTradeId: idempotency('perpl-onboard'), timeoutMs: 180_000 },
    );
    if (outcome.status !== 'completed' && outcome.status !== 'already_onboarded') {
      throw new Error(`Perpl onboarding ended ${outcome.status}`);
    }
    account = await phone.trade.perplAccount();
  }
  if (account.accountId === null) throw new Error('Perpl onboarding left no account');
  if (!secrets.perpl) save({ ...secrets, perpl: { accountId: account.accountId } });
  console.log(`user Perpl   account ${account.accountId}`);
  if (!secrets.perpl?.apiKey) {
    const apiKey =
      account.apiKey ??
      (
        await runPerplEnrollment(
          phone.trade,
          ctx,
          { sign: phone.sign, tradeKey: (w) => perplTradeKey(phone.deviceKey, w) },
          { save: () => Promise.resolve() },
          { label: PERPL_KEY_LABEL },
        )
      ).apiKey;
    save({ ...secrets, perpl: { accountId: account.accountId, apiKey } });
  }
  console.log('user Perpl   trade key enrolled (api key kept in the secrets file)');

  // 3. The agent: one device-owned hire, manual schedule.
  if (!secrets.agent) {
    const perpl = await perplMarket(phone);
    const form = agentMandateForm({
      kuruMarket: KURU_TESTNET_MARKETS[0]!.address,
      maxOrderNotional: agentMaxOrderNotional(perpl.mark, perpl.minSize),
      nowSeconds: Math.floor(Date.now() / 1000),
      returnTo: user.walletAddress,
    });
    const built = buildMandate(form, Math.floor(Date.now() / 1000));
    if (!built.ok)
      throw new Error(`the agent's mandate does not build: ${JSON.stringify(built.errors)}`);
    const { agent } = await phone.agents.hire({
      name: AGENT_NAME,
      systemPrompt:
        "You are Sente's post-deploy live check. Do exactly what the run instruction says and nothing else.",
      strategy:
        'Live check only: never trade unless a run instruction asks for one specific order.',
      model: AGENT_MODEL,
      mandate: built.mandate,
      riskAcknowledged: true,
    });
    save({
      ...secrets,
      agent: {
        id: agent.id,
        walletId: agent.walletId,
        address: agent.address,
        policyId: agent.policyId,
        ownerKind: agent.ownerKind ?? 'server',
      },
    });
    if (agent.ownerKind !== 'device') {
      console.log(`WARNING: the agent is ${agent.ownerKind ?? 'server'}-owned, not device-owned`);
    }
    console.log(
      `agent        ${agent.id}: wallet ${agent.address} (Privy ${agent.walletId}), ` +
        `policy ${agent.policyId}, maxOrderNotional ${built.mandate.maxOrderNotional}, ` +
        `market ${KURU_TESTNET_MARKETS[0]!.symbol} + ${PERPL_SYMBOL}`,
    );
  }
  const agent = secrets.agent!;

  // 4. Fund it through the Fund path: 15 USDC for Kuru, 100 AUSD for its Perpl account.
  const accountOf = perplAccountReader(publicClient);
  if (!secrets.agentFunding?.usdc || !secrets.agentFunding.ausd) {
    const send = (intent: Parameters<typeof sendSponsored>[1]) =>
      sendSponsored(phone.wallet, intent, phone.sign, { timeoutMs: 120_000 });
    const funding = { ...secrets.agentFunding };
    const top = async (symbol: 'USDC' | 'AUSD', target: bigint, skip: boolean) => {
      const token = tokenBySymbol(symbol);
      const have = await erc20Balance(token.address, agent.address);
      if (skip || have >= target) return 'already funded';
      const outcome = await fundAgent(send, {
        walletId: user.walletId,
        token,
        to: agent.address,
        atoms: target - have,
      });
      if (outcome.kind !== 'sent')
        throw new Error(`funding ${outcome.label}: ${JSON.stringify(outcome)}`);
      return outcome.transactionHash ?? 'sent';
    };
    funding.usdc ??= await top('USDC', BOOTSTRAP.agentUsdcAtoms, false);
    save({ ...secrets, agentFunding: funding });
    const agentHasPerpl = (await accountOf(agent.address)) !== null;
    funding.ausd ??= await top('AUSD', BOOTSTRAP.agentAusdAtoms, agentHasPerpl);
    save({ ...secrets, agentFunding: funding });
  }
  console.log(
    `agent funded USDC ${secrets.agentFunding!.usdc}, AUSD ${secrets.agentFunding!.ausd}`,
  );

  // 5. The agent's own Perpl account, signed in the enclave under its mandate.
  if (!secrets.agentPerpl) {
    const config = loadAgentsConfig(process.env);
    if (!config.privy) throw new Error('the agent Perpl step needs PRIVY_* in the repo .env');
    const provider = new PrivyAgentWalletProvider({
      client: new PrivyClient({ appId: config.privy.appId, appSecret: config.privy.appSecret }),
      agentKey: config.privy.agentAuthKey,
      mandateOwnerKey: config.privy.mandateOwnerKey,
    });
    const gas =
      PERPL_ONBOARDING_GAS.approve +
      PERPL_ONBOARDING_GAS.createAccount +
      PERPL_ONBOARDING_GAS.allowOrderForwarding;
    const [mon, fees] = await Promise.all([
      publicClient.getBalance({ address: agent.address }),
      publicClient.estimateFeesPerGas(),
    ]);
    const needMon = (gas * fees.maxFeePerGas * 11n) / 10n;
    if ((await accountOf(agent.address)) === null && mon < needMon) {
      throw new Error(
        `the agent holds ${formatEther(mon)} MON and its Perpl onboarding needs ${formatEther(needMon)}: ` +
          'wait for the hire gas drip, or `pnpm --filter @sente/api run agent:fund -- --to ' +
          `${agent.address} --mon 0.05`,
      );
    }
    const sender = new AgentTransactionSender({
      wallets: provider,
      chain: agentChainClient(publicClient),
    });
    const accounts = new PerplAgentAccounts({
      sender,
      wallets: provider,
      secrets: new InMemoryAgentSecretStore(),
      accountOf,
    });
    const onboarding = await accounts.onboard(
      { agentId: agent.id, walletId: agent.walletId, address: agent.address },
      BOOTSTRAP.perplOpenAtoms,
    );
    save({
      ...secrets,
      agentPerpl: {
        accountId: onboarding.accountId.toString(),
        transactions: [...onboarding.transactions],
      },
    });
  }
  console.log(
    `agent Perpl  account ${secrets.agentPerpl!.accountId} ` +
      `(txs ${secrets.agentPerpl!.transactions.join(', ') || 'none: it already existed'})`,
  );
  console.log(`\nbootstrapped: ${recordedIds(secrets).join(', ')}`);
}

// ---------------------------------------------------------------------------
// A run

type RunContext = {
  phone: Phone;
  secrets: LiveSecrets;
  runId: string;
  user: NonNullable<LiveSecrets['user']>;
  agent: NonNullable<LiveSecrets['agent']>;
  apiKey: string;
};

async function holdings(phone: Phone): Promise<Holdings & { kuruFreeUsdc: bigint }> {
  const portfolio = await phone.trade.portfolio();
  if (!portfolio.wallet.ok)
    return fail('budget', `the wallet section failed: ${portfolio.wallet.error}`);
  if (!portfolio.kuru.ok) return fail('budget', `the Kuru section failed: ${portfolio.kuru.error}`);
  const balances = portfolio.wallet.balances;
  const wallet = (symbol: string) => BigInt(balances.find((b) => b.symbol === symbol)?.raw ?? '0');
  const kuruUsdc = portfolio.kuru.balances.find((b) => b.asset === 'USDC');
  const toAtoms = (decimal: string | undefined) => (decimal ? parseUnits(decimal, DECIMALS) : 0n);
  return {
    usdcAtoms: wallet('USDC') + toAtoms(kuruUsdc?.total),
    ausdAtoms: wallet('AUSD'),
    kuruFreeUsdc: toAtoms(kuruUsdc?.available),
  };
}

async function creditsNow(phone: Phone): Promise<CreditsReading> {
  const overview = await phone.credits.overview();
  return { usedUsd: overview.usedUsd, remainingUsd: overview.remainingUsd };
}

/** One Kuru trade through the app's flow; every step's user operation read off the chain. */
async function kuruTrade(run: RunContext, name: string, draft: KuruTradeDraft): Promise<TradeView> {
  const outcome = await runTrade(
    run.phone.trade,
    draft,
    { walletId: run.user.walletId, wallet: run.user.walletAddress },
    run.phone.sign,
    progress(),
    { newClientTradeId: () => clientTradeIdFor(run.runId, name), timeoutMs: 120_000 },
  );
  const view = outcome.view;
  if (outcome.status !== 'completed' || !view) {
    return fail(name, `the trade ended ${outcome.status}${view ? ` (${view.tradeId})` : ''}`);
  }
  for (const s of view.steps) {
    if (!s.userOpHash || !s.transactionHash) {
      return fail(name, `step ${s.index} ${s.kind} has no user operation on record`);
    }
    const landed = await landedAt(publicClient, s.transactionHash as Hash, s.userOpHash as Hash);
    if (!landed.success)
      return fail(name, `step ${s.index} ${s.kind}: the user operation reverted`);
    note(`step ${s.index} ${s.kind}: userOp ${s.userOpHash} succeeded in ${s.transactionHash}`);
  }
  return view;
}

type Leftovers = { found: string[]; cleaned: string[] };

/** Open orders and positions anywhere; each is cancelled or closed, and reported. */
async function sweep(run: RunContext, label: string): Promise<Leftovers> {
  const found: string[] = [];
  const cleaned: string[] = [];
  const portfolio = await run.phone.trade.portfolio();
  if (!portfolio.kuru.ok) return fail('dirty-state', `cannot read Kuru: ${portfolio.kuru.error}`);
  for (const order of portfolio.kuru.openOrders) {
    found.push(`user Kuru order ${order.symbol} ${order.id}`);
    const draft = kuruCancelDraft(order);
    if (!draft) continue;
    await kuruTrade(run, `${label}-cancel-${order.id}`, draft);
    cleaned.push(`cancelled user Kuru ${order.id}`);
  }

  const trader = perplTrader(run.phone, run.user.walletAddress, run.apiKey);
  try {
    for (const order of await trader.openOrders()) {
      found.push(`user Perpl order ${order.symbol} ${order.id}`);
      await trader.cancel({ symbol: order.symbol, orderId: order.id });
      cleaned.push(`cancelled user Perpl ${order.id}`);
    }
    for (const position of await trader.positions()) {
      found.push(`user Perpl position ${position.symbol} ${position.size}`);
      await trader.closePosition({ symbol: position.symbol, maxSlippage: '0.01' });
      cleaned.push(`closed user Perpl ${position.symbol}`);
    }
  } finally {
    trader.release();
  }

  const agentPortfolio = await run.phone.agents.portfolio(run.agent.id);
  if (!agentPortfolio) return fail('dirty-state', 'GET /agents/:id/portfolio is not deployed');
  const agentLeft: string[] = [];
  if (agentPortfolio.kuru.ok) {
    for (const o of agentPortfolio.kuru.openOrders)
      agentLeft.push(`agent Kuru order ${o.symbol} ${o.id}`);
  }
  if (agentPortfolio.perpl.ok && agentPortfolio.perpl.status === 'ok') {
    for (const o of agentPortfolio.perpl.openOrders)
      agentLeft.push(`agent Perpl order ${o.symbol} ${o.id}`);
    for (const p of agentPortfolio.perpl.positions)
      agentLeft.push(`agent Perpl position ${p.symbol} ${p.size}`);
  }
  if (agentLeft.length > 0) {
    found.push(...agentLeft);
    // The agent's venue keys live on the server; the agent itself cleans up.
    await run.phone.agents.run(
      run.agent.id,
      'Cancel every open order you have and close every open position. Do nothing else.',
    );
    cleaned.push('asked the agent to cancel and close everything');
  }
  return { found, cleaned };
}

function assertClean(left: Leftovers): void {
  for (const line of left.cleaned) note(line);
  if (left.found.length > 0) fail('dirty-state', `found ${left.found.join('; ')}`);
}

async function withdrawKuruUsdc(run: RunContext, name: string): Promise<void> {
  const { kuruFreeUsdc } = await holdings(run.phone);
  if (kuruFreeUsdc === 0n) return;
  await kuruTrade(run, name, {
    kind: 'kuru.withdraw',
    token: USDC.address,
    amountAtoms: kuruFreeUsdc.toString(),
  });
  note(`withdrew ${atoms(kuruFreeUsdc)} USDC from Kuru to the wallet`);
}

/** Starts the agent run and waits for its summary and events, through SEN-178's run routes. */
async function agentRun(run: RunContext): Promise<{ result: RunResult; events: RunEvent[] }> {
  const id = run.agent.id;
  const startedAt = Date.now();
  let result: (RunResult & { events?: RunEvent[] }) | undefined;
  try {
    const outcome = await run.phone.agents.run(id, AGENT_INSTRUCTION);
    if (outcome.kind === 'unavailable')
      return fail('agent-run', 'POST /agents/:id/run is not deployed');
    result = outcome.result as RunResult & { events?: RunEvent[] };
  } catch (error) {
    // A proxy may give up on a long request; the run carries on server-side.
    note(`run request ended early (${describe(error)}); following the run routes`);
  }
  let runId = result?.runId;
  for (let i = 0; i < 120; i++) {
    const runs = await run.phone.agents.runs(id);
    // An API without the run routes: the POST's own answer is all there is.
    if (runs === null && runId) break;
    const summary = (runs ?? []).find((r) =>
      runId ? r.runId === runId : r.startedAt >= startedAt - 5_000,
    );
    if (summary && summary.status !== 'running') {
      runId = summary.runId;
      const transcript = await run.phone.agents.runTranscript(id, summary.runId);
      const end = transcript.entries.find((e) => e.kind === 'end');
      note(
        `run ${summary.runId}: ${summary.stopReason ?? end?.kind ?? '?'}, ${summary.iterations} turns, ` +
          `${summary.toolCalls} tool calls, $${(summary.costUsd ?? 0).toFixed(4)}`,
      );
      break;
    }
    await sleep(3_000);
  }
  if (!runId) return fail('agent-run', 'no run appeared under GET /agents/:id/runs');
  const page = await run.phone.agents.events(id, undefined, 200);
  const events = page.events.filter((e) => e.runId === runId) as RunEvent[];
  const summary = (await run.phone.agents.runs(id))?.find((r) => r.runId === runId);
  return {
    result: result ?? {
      runId,
      stopReason: summary?.stopReason ?? 'unknown',
      iterations: summary?.iterations ?? 0,
      ...(summary?.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
    },
    events: events.length > 0 ? events : (result?.events ?? []),
  };
}

/** Step 6: the enclave refuses an over-cap deposit for the agent, signed only, never sent. */
async function enclaveRefusal(run: RunContext, agent: Agent): Promise<void> {
  const config = loadAgentsConfig(process.env);
  if (!config.privy) return fail('enclave-refusal', 'PRIVY_* is not in the repo .env');
  const provider = new PrivyAgentWalletProvider({
    client: new PrivyClient({ appId: config.privy.appId, appSecret: config.privy.appSecret }),
    agentKey: config.privy.agentAuthKey,
    mandateOwnerKey: config.privy.mandateOwnerKey,
  });
  const capAtoms = Object.entries(agent.mandate.kuru.maxDepositAtoms).find(
    ([token]) => token.toLowerCase() === USDC.address.toLowerCase(),
  )?.[1];
  if (capAtoms === undefined) return fail('enclave-refusal', 'the mandate has no USDC deposit cap');

  const address = run.agent.address;
  const nonceBefore = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
  const fees = await publicClient.estimateFeesPerGas();
  // A nonce a million ahead: even a signature that leaked could never be mined.
  const farNonce = nonceBefore + 1_000_000;
  /** One thunk per leg (approve, deposit), so each is signed only when asked for. */
  const legs = (amount: bigint) =>
    depositCalls(KURU_TESTNET_CONTRACTS.accountCore, USDC, amount, address).map(
      (call, i) => () =>
        provider.signTransaction(
          run.agent.walletId,
          privyTransaction({
            to: call.to,
            data: call.data,
            value: call.value ?? 0n,
            chainId: 10143,
            nonce: farNonce + i,
            gas: kuruGasLimit(call),
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          }),
        ),
    );

  const over = capAtoms + 1_000_000n;
  let refused: EnclaveRefusedError | undefined;
  try {
    // The approve leg first; the enclave must refuse it before the deposit matters.
    await legs(over)[0]!();
  } catch (error) {
    if (!(error instanceof EnclaveRefusedError)) throw error;
    refused = error;
  }
  if (!refused)
    return fail(
      'enclave-refusal',
      `a ${atoms(over)} USDC deposit (cap ${atoms(capAtoms)}) was SIGNED`,
    );
  note(`${atoms(over)} USDC over a ${atoms(capAtoms)} cap: refused (${refused.reason})`);

  const within = 1_000_000n;
  let legsSigned = 0;
  for (const leg of legs(within)) {
    await leg();
    legsSigned += 1;
  }
  note(`${atoms(within)} USDC within the cap: ${legsSigned} legs signed, not broadcast`);

  const nonceAfter = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
  if (nonceAfter !== nonceBefore) {
    fail('enclave-refusal', `the agent's nonce moved ${nonceBefore} → ${nonceAfter}`);
  }
  note(`agent nonce ${nonceBefore} → ${nonceAfter}`);
}

async function runFlows(api: string, secrets: LiveSecrets): Promise<void> {
  const runId = runIdOf(new Date(), gitSha());
  const phone = phoneFor(api, secrets);
  const run: RunContext = {
    phone,
    secrets,
    runId,
    user: secrets.user!,
    agent: secrets.agent!,
    apiKey: secrets.perpl!.apiKey!,
  };
  console.log(`run ${runId}: user ${run.user.walletAddress}, agent ${run.agent.id}\n`);
  let baseline: Holdings | undefined;
  let creditsBefore: CreditsReading | undefined;
  let creditsAfter: CreditsReading | undefined;
  let agentMonBefore: bigint | undefined;
  let finalDeltas: ReturnType<typeof deltasOf> | undefined;

  try {
    // 1
    await step('1 session', async () => {
      const wallet = await phone.wallet.account();
      if (wallet.walletId !== run.user.walletId) {
        fail('identity', `GET /wallet answers ${wallet.walletId}, not ${run.user.walletId}`);
      }
      const capabilities = await phone.trade.capabilities();
      const gate = { buildFlag: '1', capabilities, network: 'testnet' as const };
      if (!isTradingEnabled(gate)) {
        fail(
          'trading-off',
          `Kuru trading is off or the builder pin disagrees: ${JSON.stringify(capabilities)}`,
        );
      }
      if (!isPerpsEnabled(gate)) fail('trading-off', 'perps are off for users');
      const now = await holdings(phone);
      const problems = startBudgetProblems({
        starterKit: wallet.starterKit?.status,
        holdings: now,
      });
      if (problems.length > 0) fail('budget', problems.join('; '));
      creditsBefore = await creditsNow(phone);
      agentMonBefore = await publicClient.getBalance({ address: run.agent.address });
      note(
        `USDC ${atoms(now.usdcAtoms)} (Kuru free ${atoms(now.kuruFreeUsdc)}), AUSD ${atoms(now.ausdAtoms)}`,
      );
      note(
        `credits used $${creditsBefore.usedUsd.toFixed(4)}, left $${creditsBefore.remainingUsd ?? '?'}`,
      );
    });

    // 2
    await step('2 pre-cleanup', async () => {
      const left = await sweep(run, 'pre');
      await withdrawKuruUsdc(run, 'pre-withdraw');
      assertClean(left);
      baseline = await holdings(phone);
    });

    // 3
    await step('3 kuru', async () => {
      const market: KuruMarketConfig = KURU_TESTNET_MARKETS[0]!;
      const facts = await readMarketFacts(publicClient, market);
      if (facts.bestBid === null) fail('kuru', `${market.symbol} has no bids`);
      const price = halfOnTick(facts.bestBid!, facts.params.tickSize);
      const notional = (facts.params.minQuoteNotional * 102n) / 100n;
      const size = sizeForNotional(market, price, notional);
      note(`${market.symbol}: bid ${size} size units at ${price} (best bid ${facts.bestBid})`);
      const placed = await kuruTrade(run, 'kuru-place', {
        kind: 'kuru.place',
        market: market.address,
        side: 'buy',
        orderType: 'limit',
        postOnly: true,
        sizeAtoms: size.toString(),
        priceUnits: price.toString(),
      });
      const orderId = placed.result?.orderId;
      if (placed.result?.status !== 'resting' || !orderId) {
        fail('kuru', `the bid did not rest: ${JSON.stringify(placed.result)}`);
      }
      note(`resting ${orderId}`);
      await kuruTrade(run, 'kuru-cancel', {
        kind: 'kuru.cancel',
        market: market.address,
        orderId: orderId!,
      });
    });

    // 4
    await step('4 perpl', async () => {
      const market = await perplMarket(phone);
      const price = decimalHalfOnTick(market.mark, market.tickSize);
      const trader = perplTrader(phone, run.user.walletAddress, run.apiKey);
      try {
        const placed = await trader.placeLimit({
          symbol: PERPL_SYMBOL,
          side: 'buy',
          size: market.minSize,
          price,
          leverage: 2,
          timeInForce: 'POST_ONLY',
          clientOrderId: `lf-${runId}`.slice(0, 32),
        });
        note(
          `bid ${market.minSize} at ${price} (mark ${market.mark}): ${placed.status} ${placed.id}`,
        );
        if (placed.status !== 'open') fail('perpl', `the bid was not acked open: ${placed.status}`);
        const cancelled = await trader.cancel({ symbol: PERPL_SYMBOL, orderId: placed.id });
        if (cancelled.status !== 'cancelled') fail('perpl', `the cancel ended ${cancelled.status}`);
        note(`cancelled ${cancelled.id}`);
        const positions = await trader.positions(PERPL_SYMBOL);
        if (positions.length > 0)
          fail('perpl', `positions after the cancel: ${JSON.stringify(positions)}`);
      } finally {
        trader.release();
      }
    });

    // 5
    await step('5 agent-run', async () => {
      let verdict: ReturnType<typeof judgeAgentRun> = { ok: false, problem: 'not run' };
      for (let attempt = 1; attempt <= 2 && !verdict.ok; attempt++) {
        const { result, events } = await agentRun(run);
        verdict = judgeAgentRun({ stopReason: result.stopReason, events });
        if (!verdict.ok) note(`attempt ${attempt}: ${verdict.problem}`);
      }
      creditsAfter = await creditsNow(phone);
      if (!verdict.ok) fail('agent-run', verdict.problem);
      const problems = creditsProblems(creditsBefore!, creditsAfter);
      if (problems.length > 0) fail('budget', problems.join('; '));
    });

    // 6
    await step('6 enclave-refusal', async () => {
      await enclaveRefusal(run, await phone.agents.get(run.agent.id));
    });

    // 7
    await step('7 post-cleanup', async () => {
      const left = await sweep(run, 'post');
      await withdrawKuruUsdc(run, 'post-withdraw');
      assertClean(left);
      finalDeltas = deltasOf(baseline!, await holdings(phone));
      note(`USDC ${signed(finalDeltas.usdcAtoms)}, AUSD ${signed(finalDeltas.ausdAtoms)}`);
      const problems = deltaProblems(finalDeltas);
      if (problems.length > 0) fail('budget', problems.join('; '));
    });
  } finally {
    const agentMonAfter = await publicClient
      .getBalance({ address: run.agent.address })
      .catch(() => undefined);
    console.log('\nbudget this run:');
    if (creditsBefore && creditsAfter) {
      console.log(`  model credits  $${(creditsAfter.usedUsd - creditsBefore.usedUsd).toFixed(4)}`);
    }
    if (finalDeltas) {
      console.log(`  user USDC      ${signed(finalDeltas.usdcAtoms)} (wallet + Kuru)`);
      console.log(`  user AUSD      ${signed(finalDeltas.ausdAtoms)} (wallet)`);
    }
    if (agentMonBefore !== undefined && agentMonAfter !== undefined) {
      console.log(`  agent MON gas  ${formatEther(agentMonBefore - agentMonAfter)}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const api = normalizeApi(option('api') ?? PRODUCTION_API);
  const secrets = readSecrets();
  console.log(`target ${api}${api === PRODUCTION_API ? ' (PRODUCTION)' : ''}`);
  console.log(`secrets ${SECRETS_PATH}`);
  const refusal = targetRefusal({ api, recorded: secrets?.api ?? null, yes: flag('yes') });
  if (refusal) {
    console.log(refusal);
    process.exitCode = 2;
    return;
  }
  if (flag('bootstrap')) return bootstrap(api, secrets);
  const notReady = runRefusal(secrets);
  if (notReady) {
    console.log(notReady);
    process.exitCode = 2;
    return;
  }
  await runFlows(api, secrets!);
  console.log('\nALL FLOWS PASSED');
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    if (!(error instanceof StepFailure)) console.error(describe(error));
    process.exit(1);
  },
);
