// Live user-trade run (SEN-81, SEN-82): this script is a phone. docs/user-trading.md
// has the results and how to start the local API it needs.
//
//   pnpm --filter @sente/mobile run trade:live -- <mode> [options]
//
//   fund      --usdc 60 [--ausd 150]   treasury → the throwaway user's Privy wallet
//   kuru      [--steps gtc,cancel,buy,sell,withdraw,p2] [--order-id <slot:id>]
//   perpl     [--label <text>]         probe P5: onboard, record /payload, enroll, trade
//   account                            the API's view of the user's Perpl account
//   sigcheck                           does the wallet's Privy EIP-712 signature recover?
//   supersede [--scope trade] [--count n] [--reverse]   Perpl's payload-order rule
//   userops   --tx <hash> --userop <hash>               the wallet's user ops since one
//
// It signs in with a throwaway secp256k1 key (POST /auth/challenge), registers a
// throwaway P-256 device key (POST /wallet/register), and then trades through
// the app's REAL code: `TradeApi`, `runTrade` (which runs `verifyKuruTrade`
// before anything is signed), `signPrivyAuthorization`, `perplTradeKey` and
// `createPerplTrader`. Nothing here imports the API. Point it at an API started
// with USER_TRADING=1 — never production:
//
//   --api http://localhost:3100   (default; a *.sente.lol host exits 2 unless
//                                 --really-production is also passed)
//   --keys <file>                 the throwaway keys, created 0600 on first run and
//                                 reused after, so a re-run is the same user
//   --out <file.json>             every step's hashes, for docs/user-trading.md
//
// Secrets: the keys file holds two throwaway private keys and is never printed.
// `fund` reads TREASURY_PRIVATE_KEY; `p2`, `sigcheck`, `supersede` and the
// read-key part of `perpl` read PRIVY_APP_ID/PRIVY_APP_SECRET, from the
// environment (`--env-file`); none is ever logged.
//
// Those Privy calls are the part that is NOT phone code: test harness that talks
// to Privy with the app's credentials — P2 to replay a request the API already
// sent, the rest to sign Perpl payloads for keys the API does not enroll.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  type KuruMarketConfig,
} from '@sente/venues/kuru';
import {
  PERPL_NETWORKS,
  PERPL_TESTNET_CONTRACTS,
  SCOPE,
  submitEnrollment,
  toViemTypedData,
  type PerplTypedData,
} from '@sente/venues/perpl';
import {
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  hashTypedData,
  http,
  parseAbi,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { devicePublicKeySpki, signPrivyAuthorization } from '../src/auth/deviceKey.ts';
import type { AuthorizationPayload } from '../src/auth/deviceKey.ts';
import { perplTradeKey } from '../src/auth/perplKey.ts';
import { publicClient } from '../src/chain/client.ts';
import { TradeApi } from '../src/trade/api.ts';
import { isProductionHost } from './productionGuard.ts';
import {
  runTrade,
  TradePriceMovedError,
  type KuruTradeDraft,
  type TradeFlowState,
  type TradeOutcome,
} from '../src/trade/flow.ts';
import { tradeIdempotencyKey, verifyTradeEnvelope } from '../src/trade/envelope.ts';
import { readKuruFree, readMarketFacts, worstPriceUnits } from '../src/trade/kuruMarket.ts';
import { createPerplTrader } from '../src/trade/perplTrader.ts';
import type { TradeView } from '../src/trade/types.ts';
import { WalletApi, type SessionAuth, type UserWallet } from '../src/wallet/api.ts';

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const mode = argv[0];
function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

const API = (option('api') ?? 'http://localhost:3100').replace(/\/+$/, '');
// Production registers a real wallet and sends it a starter kit of real testnet
// funds (CLAUDE.md, "Tests never touch production"). Refused unless asked for by name.
if (isProductionHost(API) && !argv.includes('--really-production')) {
  console.error(
    `trade-live: refusing --api ${API}, which is production. Point it at a local API ` +
      'started with USER_TRADING=1, or pass --really-production if Ignacio asked for a live run.',
  );
  process.exit(2);
}
const KEYS_FILE = resolve(option('keys') ?? '.trade-live-keys.json');
const OUT_FILE = option('out');

/** The user's slippage for the IOC legs: 1%. */
const SLIPPAGE_BPS = 100;
/** Kuru's minimum quote notional is 10 USDC; stay a little above it. */
const GTC_NOTIONAL_ATOMS = 10_200_000n;
const IOC_NOTIONAL_ATOMS = 12_000_000n;
/** Treasury transfer gas (Monad charges the limit, gotcha 4). */
const GAS = { USDC: 72_000n, AUSD: 82_000n } as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The throwaway "phone": an auth key and a device key

type Keys = { authKey: `0x${string}`; deviceKey: string };

function loadKeys(): Keys {
  if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as Keys;
  const keys: Keys = {
    authKey: generatePrivateKey(),
    deviceKey: bytesToHex(p256.utils.randomSecretKey()),
  };
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
  console.log(`new throwaway keys written to ${KEYS_FILE} (0600)`);
  return keys;
}

const keys = loadKeys();
const authAccount = privateKeyToAccount(keys.authKey);
const deviceKey = hexToBytes(keys.deviceKey);

/** `session/auth.ts` minus React: challenge, personal_sign, exchange. */
function sessionAuth(): SessionAuth {
  let token: string | null = null;
  const post = async (path: string, body: unknown): Promise<Record<string, string>> => {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} → ${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, string>;
  };
  return {
    token: () => token,
    async refresh() {
      const challenge = await post('/auth/challenge', { address: authAccount.address });
      const signature = await authAccount.signMessage({ message: challenge['message']! });
      token = (await post('/auth/session', { address: authAccount.address, signature }))['token']!;
      return token;
    },
  };
}

// ---------------------------------------------------------------------------
// Results

type StepRecord = {
  readonly run: string;
  readonly tradeId?: string;
  readonly status: string;
  readonly steps?: TradeView['steps'];
  readonly result?: TradeView['result'];
  readonly note?: string;
};
const records: StepRecord[] = [];

function record(entry: StepRecord): void {
  records.push(entry);
  console.log(`\n== ${entry.run}: ${entry.status}${entry.note ? ` — ${entry.note}` : ''}`);
  for (const step of entry.steps ?? []) {
    console.log(
      `   step ${step.index} ${step.kind.padEnd(8)} ${step.status.padEnd(9)} ` +
        `userOp ${step.userOpHash ?? '-'}  tx ${step.transactionHash ?? '-'}` +
        (step.error ? `  error ${step.error}` : ''),
    );
  }
  if (entry.result) console.log(`   result ${JSON.stringify(entry.result)}`);
  if (OUT_FILE) writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
}

// ---------------------------------------------------------------------------
// Setup shared by every mode

async function signIn(): Promise<{ auth: SessionAuth; wallet: UserWallet }> {
  const auth = sessionAuth();
  await auth.refresh();
  const wallet = await new WalletApi({ auth, baseUrl: API }).register(
    devicePublicKeySpki(deviceKey),
  );
  console.log(`auth key  ${authAccount.address}`);
  console.log(`wallet    ${wallet.address} (Privy ${wallet.walletId})`);
  for (const b of wallet.balances) console.log(`          ${b.amount} ${b.symbol}`);
  return { auth, wallet };
}

/** Every payload the device key signed, with its signature: P2 replays one. */
const signed: { payload: AuthorizationPayload; signature: string }[] = [];
const approver = (payload: AuthorizationPayload): string => {
  const signature = signPrivyAuthorization(deviceKey, payload);
  signed.push({ payload, signature });
  return signature;
};

// ---------------------------------------------------------------------------
// fund: treasury → the user's wallet, explicit gas

async function fund(): Promise<void> {
  const { wallet } = await signIn();
  const raw = process.env['TREASURY_PRIVATE_KEY']?.trim();
  if (!raw) throw new Error('set TREASURY_PRIVATE_KEY (--env-file the repo .env)');
  const treasury = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`);
  const client = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(process.env['MONAD_TESTNET_RPC_URL'] || undefined),
  });
  console.log(`treasury  ${treasury.address}`);
  const sends = [
    { symbol: 'USDC' as const, token: KURU_TESTNET_TOKENS.USDC.address, amount: option('usdc') },
    { symbol: 'AUSD' as const, token: PERPL_TESTNET_CONTRACTS.collateral, amount: option('ausd') },
  ];
  for (const send of sends) {
    if (!send.amount) continue;
    const atoms = parseUnits(send.amount, 6);
    const hash = await client.writeContract({
      address: send.token,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [wallet.address, atoms],
      gas: GAS[send.symbol],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`fund ${send.amount} ${send.symbol}: ${receipt.status} ${hash}`);
    if (receipt.status !== 'success') throw new Error(`${send.symbol} transfer reverted`);
  }
}

// ---------------------------------------------------------------------------
// kuru: the five runs and P2

function market(symbol: string): KuruMarketConfig {
  const found = KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`no market ${symbol}`);
  return found;
}

/** Size units whose quote notional at `price` is at least `notionalAtoms`. */
function sizeForNotional(m: KuruMarketConfig, price: bigint, notionalAtoms: bigint): bigint {
  // notionalAtoms = price * size * 10^quoteDec / (pricePrecision * sizePrecision)
  const denominator = price * 10n ** BigInt(m.quote.decimals);
  const numerator = notionalAtoms * m.pricePrecision * m.sizePrecision;
  return (numerator + denominator - 1n) / denominator;
}

function notionalAtoms(m: KuruMarketConfig, price: bigint, size: bigint): bigint {
  return (price * size * 10n ** BigInt(m.quote.decimals)) / (m.pricePrecision * m.sizePrecision);
}

/** Prints each flow phase once, not every poll of `following`. */
function progress(): (state: TradeFlowState) => void {
  let last = '';
  return (state) => {
    if (state.phase !== last) console.log(`   ${state.phase}`);
    last = state.phase;
  };
}

async function trade(
  api: TradeApi,
  wallet: UserWallet,
  run: string,
  makeDraft: () => Promise<KuruTradeDraft>,
): Promise<TradeOutcome> {
  const attempt = async (): Promise<TradeOutcome> => {
    const draft = await makeDraft();
    console.log(`\n-> ${run}: ${JSON.stringify(draft)}`);
    return runTrade(
      api,
      draft,
      { walletId: wallet.walletId, wallet: wallet.address, slippageBps: SLIPPAGE_BPS },
      approver,
      progress(),
      { timeoutMs: 120_000 },
    );
  };
  let outcome: TradeOutcome;
  try {
    outcome = await attempt();
  } catch (error) {
    // The UI's answer to a moved book: the user reviews the new price once.
    if (!(error instanceof TradePriceMovedError)) throw error;
    console.log('   price moved; reviewing once at the new worst price');
    outcome = await attempt();
  }
  const view = outcome.view;
  record({
    run,
    status: outcome.status,
    ...(view ? { tradeId: view.tradeId, steps: view.steps } : {}),
    ...(view?.result ? { result: view.result } : {}),
  });
  if (outcome.status !== 'completed') throw new Error(`${run} did not complete`);
  return outcome;
}

async function kuru(): Promise<void> {
  const { auth, wallet } = await signIn();
  const api = new TradeApi({ auth, baseUrl: API });
  const capabilities = await api.capabilities();
  console.log(`capabilities ${JSON.stringify(capabilities)}`);
  if (!capabilities.enabled) throw new Error('the API has USER_TRADING off');

  const steps = new Set((option('steps') ?? 'gtc,cancel,buy,sell,withdraw,p2').split(','));
  const usdc = KURU_TESTNET_TOKENS.USDC.address;
  const mon = market('MON-USDC');
  // MON-USDC's book was empty on 2026-10-09, so the IOC legs trade cbBTC-USDC.
  const ioc = market(option('ioc-market') ?? 'cbBTC-USDC');
  let orderId = option('order-id');

  if (steps.has('gtc')) {
    const outcome = await trade(api, wallet, '1 GTC buy MON-USDC far below the book', async () => {
      const facts = await readMarketFacts(publicClient, mon);
      // Half the best bid, or 0.01 USDC when nobody bids at all.
      const reference = facts.bestBid ?? facts.bestAsk ?? 20_000n;
      const price = reference / 2n - ((reference / 2n) % facts.params.tickSize);
      const size = sizeForNotional(mon, price, GTC_NOTIONAL_ATOMS);
      return {
        kind: 'kuru.place',
        market: mon.address,
        side: 'buy',
        orderType: 'limit',
        postOnly: true,
        sizeAtoms: size.toString(),
        priceUnits: price.toString(),
      };
    });
    orderId = outcome.view?.result?.orderId;
    if (!orderId) throw new Error('the GTC order did not rest, so there is nothing to cancel');
  }

  if (steps.has('cancel')) {
    if (!orderId) throw new Error('cancel needs --order-id or the gtc step');
    const id = orderId;
    await trade(api, wallet, '2 cancel the GTC order', () =>
      Promise.resolve({ kind: 'kuru.cancel', market: mon.address, orderId: id }),
    );
  }

  if (steps.has('buy')) {
    await trade(api, wallet, `3 IOC buy ${ioc.symbol}`, async () => {
      const facts = await readMarketFacts(publicClient, ioc);
      if (facts.bestAsk === null) throw new Error(`${ioc.symbol} has no asks`);
      const worst = worstPriceUnits(facts.bestAsk, SLIPPAGE_BPS, facts.params.tickSize, 'buy');
      return {
        kind: 'kuru.place',
        market: ioc.address,
        side: 'buy',
        orderType: 'market',
        sizeAtoms: sizeForNotional(ioc, facts.bestAsk, IOC_NOTIONAL_ATOMS).toString(),
        priceUnits: worst.toString(),
      };
    });
  }

  if (steps.has('sell')) {
    await trade(api, wallet, `4 IOC sell ${ioc.symbol} from the Kuru balance`, async () => {
      const facts = await readMarketFacts(publicClient, ioc);
      if (facts.bestBid === null) throw new Error(`${ioc.symbol} has no bids`);
      const free = await readKuruFree(publicClient, wallet.address, ioc.base.address);
      const size = (free * ioc.sizePrecision) / 10n ** BigInt(ioc.base.decimals);
      const worst = worstPriceUnits(facts.bestBid, SLIPPAGE_BPS, facts.params.tickSize, 'sell');
      if (notionalAtoms(ioc, worst, size) < facts.params.minQuoteNotional) {
        throw new Error(`only ${free} ${ioc.base.symbol} atoms free in Kuru: below min notional`);
      }
      return {
        kind: 'kuru.place',
        market: ioc.address,
        side: 'sell',
        orderType: 'market',
        sizeAtoms: size.toString(),
        priceUnits: worst.toString(),
      };
    });
  }

  if (steps.has('withdraw')) {
    await trade(api, wallet, '5 withdraw USDC from Kuru', async () => {
      const free = await readKuruFree(publicClient, wallet.address, usdc);
      console.log(`   Kuru free USDC ${formatUnits(free, 6)}`);
      if (free === 0n) throw new Error('no USDC in the Kuru account to withdraw');
      return { kind: 'kuru.withdraw', token: usdc, amountAtoms: free.toString() };
    });
  }

  if (steps.has('p2')) await replay(api, wallet);

  const after = await new WalletApi({ auth, baseUrl: API }).account();
  console.log('\nwallet after:');
  for (const b of after.balances) console.log(`          ${b.amount} ${b.symbol}`);
}

// ---------------------------------------------------------------------------
// perpl: probe P5 — onboard, record the live enrollment payloads, enroll, trade

const PERPL = PERPL_NETWORKS.testnet;
const PERPL_SYMBOL = 'BTC-PERP';
/** 0.0005 BTC: about $41 of notional at 2x, out of a 100 AUSD account. */
const PERPL_SIZE = '0.0005';
const ONBOARD_ATOMS = 100_000_000n; // 100 AUSD, Perpl's opening minimum

/** One authenticated JSON call to the local API, for the routes `TradeApi` does not wrap. */
async function apiCall<T>(auth: SessionAuth, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth.token() ?? (await auth.refresh())}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Perpl onboarding through `/trade`. The phone has no `verifyPerplOnboard` yet
 * (SEN-98), so this checks what it can before signing: every envelope with the
 * real `verifyTradeEnvelope`, and every target is AUSD or the Perpl Exchange.
 */
async function onboardPerpl(api: TradeApi, wallet: UserWallet): Promise<void> {
  const clientTradeId = globalThis.crypto.randomUUID();
  const prepared = await api.prepare({
    kind: 'perpl.onboard',
    clientTradeId,
    amountAtoms: ONBOARD_ATOMS.toString(),
  });
  const targets: readonly string[] = [
    PERPL_TESTNET_CONTRACTS.collateral,
    PERPL_TESTNET_CONTRACTS.exchange,
  ];
  for (const step of prepared.steps) {
    const envelope = verifyTradeEnvelope(step.payload, {
      walletId: wallet.walletId,
      idempotencyKey: tradeIdempotencyKey(clientTradeId, step.index),
      rpcMethod: 'eth_sendTransaction',
    });
    if (!envelope.ok) throw new Error(`step ${step.index} refused: ${envelope.problem}`);
    const to = (envelope.params['transaction'] as { to: string }).to;
    if (!targets.includes(to)) throw new Error(`step ${step.index} calls ${to}`);
    console.log(`   step ${step.index} ${step.kind}: ${step.title}`);
  }
  const signatures = prepared.steps.map((step) => approver(step.payload));
  let view = await api.commit(prepared.tradeId, signatures);
  const deadline = Date.now() + 180_000;
  while (!['completed', 'failed'].includes(view.status) && Date.now() < deadline) {
    await sleep(2_000);
    view = await api.status(prepared.tradeId);
  }
  record({
    run: 'P5 onboard 100 AUSD',
    status: view.status,
    tradeId: view.tradeId,
    steps: view.steps,
  });
  if (view.status !== 'completed') throw new Error('onboarding did not complete');
}

/** Perpl's `/v1/api-key/payload` answer, as text, exactly as served. */
async function rawPayload(address: Address, publicKeyHex: Hex, scope: number, label: string) {
  const request = {
    chain_id: PERPL.chainId,
    address,
    public_key: publicKeyHex,
    scope_mask: scope,
    label,
  };
  const response = await fetch(`${PERPL.restUrl}/v1/api-key/payload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`payload ${response.status}: ${text}`);
  return { request, text, parsed: JSON.parse(text) as { typed_data: PerplTypedData; mac: string } };
}

/**
 * The wallet's EIP-712 signature over `typed`, through Privy with the device
 * key's authorization — the request `perpl-enroll.service.ts` builds, made
 * here for the one extra (read-scoped) key the API would otherwise hold.
 */
async function privySignTypedData(wallet: UserWallet, typed: PerplTypedData): Promise<Hex> {
  const appId = process.env['PRIVY_APP_ID'];
  const appSecret = process.env['PRIVY_APP_SECRET'];
  if (!appId || !appSecret) throw new Error('needs PRIVY_APP_ID and PRIVY_APP_SECRET');
  const viemTyped = toViemTypedData(typed);
  const json = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)));
  const body = {
    method: 'eth_signTypedData_v4',
    params: {
      typed_data: {
        domain: json(viemTyped.domain),
        types: { EIP712Domain: typed.types['EIP712Domain'], ...viemTyped.types },
        primary_type: typed.primaryType,
        message: json(viemTyped.message),
      },
    },
  };
  const url = `https://api.privy.io/v1/wallets/${wallet.walletId}/rpc`;
  const headers = { 'privy-app-id': appId };
  const signature = signPrivyAuthorization(deviceKey, {
    version: 1,
    method: 'POST',
    url,
    body,
    headers,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-authorization-signature': signature,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as { data?: { signature?: Hex } };
  if (!response.ok || !answer.data?.signature) {
    throw new Error(`Privy signTypedData ${response.status}: ${JSON.stringify(answer)}`);
  }
  return answer.data.signature;
}

function ed25519Pop(secretKey: Uint8Array, typed: PerplTypedData): Hex {
  const digest = hashTypedData(toViemTypedData(typed) as Parameters<typeof hashTypedData>[0]);
  return `0x${bytesToHex(ed25519.sign(hexToBytes(digest.slice(2)), secretKey))}`;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type EnrollPrepare = {
  prepareId: string;
  expiresAt: string;
  items: { role: 'trade' | 'read'; payload: AuthorizationPayload; typedData: PerplTypedData }[];
};

async function perpl(): Promise<void> {
  const { auth, wallet } = await signIn();
  const api = new TradeApi({ auth, baseUrl: API });
  const tradeKey = perplTradeKey(deviceKey, wallet.address);
  const label = option('label') ?? 'sente-trade-live';
  const notes: Record<string, unknown> = { tradeKeyPublic: tradeKey.publicKeyHex };

  // 1. Onboard through /trade, unless an earlier run already did.
  let account = await apiCall<Record<string, unknown>>(auth, 'GET', '/trade/perpl/account');
  console.log(`perpl account before: ${JSON.stringify(account)}`);
  // The API learns `forwarding` only from an onboarding it ran itself, so after a
  // restart an onboarded account reads false; the chain already has it on.
  if (account['accountId'] === null) {
    await onboardPerpl(api, wallet);
    account = await apiCall(auth, 'GET', '/trade/perpl/account');
  }
  notes['accountAfterOnboard'] = account;

  // 2. The live payloads, verbatim, for a trade-scoped and a read-scoped key.
  const readSecret = ed25519.utils.randomSecretKey();
  const readPublic: Hex = `0x${bytesToHex(ed25519.getPublicKey(readSecret))}`;
  const tradeRaw = await rawPayload(wallet.address, tradeKey.publicKeyHex, SCOPE.trade, label);
  const readRaw = await rawPayload(wallet.address, readPublic, SCOPE.read, `${label}-read`);
  notes['payloadTrade'] = { request: tradeRaw.request, response: tradeRaw.text };
  notes['payloadRead'] = { request: readRaw.request, response: readRaw.text };
  console.log(`\n/payload trade scope:\n${tradeRaw.text}\n\n/payload read scope:\n${readRaw.text}`);
  if (OUT_FILE) writeFileSync(`${OUT_FILE}.payloads.json`, JSON.stringify(notes, null, 2));

  // 3. Enroll the phone's trade key (and the server's read key) through the API.
  const prepared = await apiCall<EnrollPrepare>(auth, 'POST', '/trade/perpl/enroll/prepare', {
    publicKeyHex: tradeKey.publicKeyHex,
    label,
  });
  notes['enrollPrepare'] = prepared;
  for (const item of prepared.items) {
    const envelope = verifyTradeEnvelope(item.payload, {
      walletId: wallet.walletId,
      idempotencyKey: `sente-enroll:${prepared.prepareId}:${item.role}`,
      rpcMethod: 'eth_signTypedData_v4',
    });
    if (!envelope.ok) throw new Error(`${item.role} enrollment refused: ${envelope.problem}`);
  }
  const tradeItem = prepared.items.find((item) => item.role === 'trade')!;
  const committed = await apiCall<{ apiKey: string; accountId: string; readKey: string }>(
    auth,
    'POST',
    '/trade/perpl/enroll/commit',
    {
      prepareId: prepared.prepareId,
      signatures: prepared.items.map((item) => approver(item.payload)),
      popSignature: ed25519Pop(tradeKey.secretKey, tradeItem.typedData),
    },
  );
  record({
    run: 'P5 enroll trade key + server read key via /trade/perpl/enroll',
    status: 'enrolled',
    note: `account ${committed.accountId}, readKey ${committed.readKey}, apiKey ${committed.apiKey.slice(0, 8)}…`,
  });
  const portfolio = await apiCall<{ perpl: unknown }>(auth, 'GET', '/portfolio');
  notes['portfolioPerpl'] = portfolio.perpl;
  console.log(`portfolio perpl section: ${JSON.stringify(portfolio.perpl)}`);

  // 4. A read-scoped key of our own: positions work, an order must be refused.
  // A fresh payload: the recorded one is older than the keys step 3 enrolled,
  // and Perpl refuses a payload older than the last enrollment.
  const readFresh = await rawPayload(wallet.address, readPublic, SCOPE.read, `${label}-read`);
  const readInfo = await submitEnrollment({
    restUrl: PERPL.restUrl,
    chainId: PERPL.chainId,
    address: wallet.address,
    typed_data: readFresh.parsed.typed_data,
    mac: readFresh.parsed.mac,
    signature: await privySignTypedData(wallet, readFresh.parsed.typed_data),
    popSignature: ed25519Pop(readSecret, readFresh.parsed.typed_data),
  });
  const reader = createPerplTrader({
    credentials: { apiKey: readInfo.api_key, secretKey: readSecret },
    restUrl: PERPL.restUrl,
    wsUrl: PERPL.wsUrl,
  });
  let readPositions: string;
  try {
    readPositions = JSON.stringify(await reader.positions(PERPL_SYMBOL));
  } catch (error) {
    readPositions = `failed: ${describeError(error)}`;
  }
  let readOrder: string;
  try {
    const order = await reader.placeMarket({
      symbol: PERPL_SYMBOL,
      side: 'buy',
      size: PERPL_SIZE,
      leverage: 2,
      maxSlippage: '0.01',
    });
    readOrder = `ACCEPTED (must not be): ${JSON.stringify(order)}`;
  } catch (error) {
    readOrder = `refused: ${describeError(error)}`;
  } finally {
    reader.release();
  }
  record({
    run: 'P5 read-scoped key: positions, then an order',
    status: readOrder.startsWith('refused') ? 'order refused (expected)' : 'ORDER ACCEPTED',
    note: `scope ${readInfo.scope_mask}; positions ${readPositions}; order ${readOrder}`,
  });

  // 5. Open and close a 2x position with the phone's trade key, over Node's WebSocket (no Origin).
  const trader = createPerplTrader({
    credentials: { apiKey: committed.apiKey, secretKey: tradeKey.secretKey },
    restUrl: PERPL.restUrl,
    wsUrl: PERPL.wsUrl,
  });
  tradeKey.secretKey.fill(0);
  try {
    const opened = await trader.placeMarket({
      symbol: PERPL_SYMBOL,
      side: 'buy',
      size: PERPL_SIZE,
      leverage: 2,
      maxSlippage: '0.01',
    });
    record({
      run: `P5 open 2x ${PERPL_SIZE} ${PERPL_SYMBOL} long`,
      status: opened.status,
      note: JSON.stringify(opened),
    });
    await sleep(3_000);
    const open = await trader.positions(PERPL_SYMBOL);
    console.log(`positions: ${JSON.stringify(open)}`);
    const closed = await trader.closePosition({ symbol: PERPL_SYMBOL, maxSlippage: '0.01' });
    record({
      run: `P5 close ${PERPL_SYMBOL}`,
      status: closed.status,
      note: JSON.stringify(closed),
    });
    await sleep(3_000);
    notes['positionsAfterClose'] = await trader.positions(PERPL_SYMBOL);
    console.log(`positions after close: ${JSON.stringify(notes['positionsAfterClose'])}`);
  } finally {
    trader.release();
    if (OUT_FILE) writeFileSync(`${OUT_FILE}.payloads.json`, JSON.stringify(notes, null, 2));
  }
}

// ---------------------------------------------------------------------------
// P2: replay the last signed send straight to Privy

const USER_OPERATION_EVENT = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
/** Monad's public RPC caps `eth_getLogs` ranges; stay under it. */
const LOG_RANGE = 100n;

/** The EntryPoint that carried `userOpHash`, and the block it landed in. */
async function landedAt(
  transactionHash: Hash,
  userOpHash: Hash,
): Promise<{ entryPoint: Address; block: bigint }> {
  const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: USER_OPERATION_EVENT,
        data: log.data,
        topics: log.topics,
      });
      if (event.args.userOpHash === userOpHash) {
        return { entryPoint: log.address, block: receipt.blockNumber };
      }
    } catch {
      // not a UserOperationEvent
    }
  }
  throw new Error(`no UserOperationEvent for ${userOpHash} in ${transactionHash}`);
}

type LandedOp = { userOpHash: Hash; transactionHash: Hash; success: boolean };

/** Every user operation `sender` landed through `entryPoint` from `fromBlock` on. */
async function userOpsSince(
  entryPoint: Address,
  sender: Address,
  fromBlock: bigint,
): Promise<LandedOp[]> {
  const latest = await publicClient.getBlockNumber();
  const ops: LandedOp[] = [];
  for (let from = fromBlock; from <= latest; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
    const logs = await publicClient.getLogs({
      address: entryPoint,
      event: USER_OPERATION_EVENT[0],
      args: { sender },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      ops.push({
        userOpHash: log.args.userOpHash!,
        transactionHash: log.transactionHash,
        success: log.args.success!,
      });
    }
  }
  return ops;
}

async function replay(api: TradeApi, wallet: UserWallet): Promise<void> {
  const last = signed.at(-1);
  if (!last) throw new Error('p2 needs a trade signed in this run');
  const appId = process.env['PRIVY_APP_ID'];
  const appSecret = process.env['PRIVY_APP_SECRET'];
  if (!appId || !appSecret) throw new Error('p2 needs PRIVY_APP_ID and PRIVY_APP_SECRET');

  const trades = await api.list(1);
  const landed = trades[0]?.steps.at(-1);
  if (!landed?.userOpHash || !landed.transactionHash) {
    throw new Error('the last trade has no landed step to compare against');
  }
  const { entryPoint, block } = await landedAt(landed.transactionHash, landed.userOpHash);

  // A second commit through the API must resend nothing.
  let recommit: string;
  try {
    const view = await api.commit(trades[0]!.tradeId, [last.signature]);
    recommit = `answered ${view.status}`;
  } catch (error) {
    recommit = `refused: ${error instanceof Error ? error.message : String(error)}`;
  }

  // The same signed request, byte for byte, straight to Privy.
  const { payload, signature } = last;
  const headers = payload.headers as Record<string, string>;
  const response = await fetch(payload.url, {
    method: payload.method,
    headers: {
      ...headers,
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-authorization-signature': signature,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload.body),
  });
  const answer = (await response.json()) as unknown;
  // Longer than WALLET_SEND_SPACING_MS and many blocks: a second operation
  // would have landed by now.
  await sleep(20_000);
  const ops = await userOpsSince(entryPoint, wallet.address, block);
  const answered = answer as { data?: { user_operation_hash?: string } };
  const same = answered.data?.user_operation_hash === landed.userOpHash;
  const pass = ops.length === 1 && ops[0]!.userOpHash === landed.userOpHash;
  record({
    run: 'P2 replay the last signed send',
    status: pass ? 'passed' : 'FAILED',
    note:
      `idempotency key ${headers['privy-idempotency-key']}; API re-commit ${recommit}; ` +
      `Privy ${response.status} ${JSON.stringify(answer)}; same userOp as the original: ${same}; ` +
      `user operations from the wallet since block ${block}: ${JSON.stringify(ops)}`,
  });
  if (!pass) throw new Error('the replay ran a second user operation');
}

// ---------------------------------------------------------------------------

/**
 * `sigcheck`: does the wallet's Privy EIP-712 signature over a live Perpl
 * payload recover to the wallet? Fetches a payload for a throwaway read key
 * (enrolls nothing) and recovers locally, the way Perpl's `ecrecover` would.
 */
async function sigcheck(): Promise<void> {
  const { wallet } = await signIn();
  const key: Hex = `0x${bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))}`;
  const raw = await rawPayload(wallet.address, key, SCOPE.read, 'sente-sigcheck');
  const signature = await privySignTypedData(wallet, raw.parsed.typed_data);
  const typed = toViemTypedData(raw.parsed.typed_data) as Parameters<typeof hashTypedData>[0];
  const recovered = await recoverTypedDataAddress({ ...typed, signature });
  console.log(
    `code at wallet: ${(await publicClient.getCode({ address: wallet.address })) ?? '0x'}`,
  );
  console.log(`signature: ${(signature.length - 2) / 2} bytes`);
  console.log(`recovers to ${recovered} (wallet ${wallet.address})`);
}

/**
 * `supersede`: does a newer `/payload` for the same wallet void an older one?
 * Fetches A then B (two throwaway read keys) and submits A, then B. Each
 * success enrolls a read-scoped key, so this costs up to two of 16 slots.
 */
async function supersede(): Promise<void> {
  const { wallet } = await signIn();
  const scope = option('scope') === 'trade' ? SCOPE.trade : SCOPE.read;
  const count = Number(option('count') ?? 2);
  const keys = Array.from({ length: count }, () => ed25519.utils.randomSecretKey());
  const payloads = [];
  for (const [i, secret] of keys.entries()) {
    const pub: Hex = `0x${bytesToHex(ed25519.getPublicKey(secret))}`;
    payloads.push(await rawPayload(wallet.address, pub, scope, `sente-supersede-${i}`));
  }
  const order = [...payloads.entries()];
  if (argv.includes('--reverse')) order.reverse();
  for (const [i, payload] of order) {
    const typed = payload.parsed.typed_data;
    try {
      const info = await submitEnrollment({
        restUrl: PERPL.restUrl,
        chainId: PERPL.chainId,
        address: wallet.address,
        typed_data: typed,
        mac: payload.parsed.mac,
        signature: await privySignTypedData(wallet, typed),
        popSignature: ed25519Pop(keys[i]!, typed),
      });
      console.log(`payload ${'AB'[i]}: enrolled, scope ${info.scope_mask}`);
    } catch (error) {
      console.log(`payload ${'AB'[i]}: ${describeError(error)}`);
    }
  }
}

/** `account`: what the API says about the user's Perpl account and portfolio. */
async function account(): Promise<void> {
  const { auth } = await signIn();
  console.log(JSON.stringify(await apiCall(auth, 'GET', '/trade/perpl/account')));
  console.log(JSON.stringify((await apiCall<{ perpl: unknown }>(auth, 'GET', '/portfolio')).perpl));
}

/** `userops --tx <hash> --userop <hash>`: the wallet's user operations since that one landed. */
async function userops(): Promise<void> {
  const tx = option('tx') as Hash | undefined;
  const userOp = option('userop') as Hash | undefined;
  if (!tx || !userOp) throw new Error('userops needs --tx and --userop');
  const { wallet } = await signIn();
  const { entryPoint, block } = await landedAt(tx, userOp);
  const ops = await userOpsSince(entryPoint, wallet.address, block);
  console.log(`EntryPoint ${entryPoint}, from block ${block}:`);
  for (const op of ops) console.log(`  ${op.userOpHash} tx ${op.transactionHash} ${op.success}`);
}

const modes: Record<string, () => Promise<void>> = {
  account,
  fund,
  kuru,
  perpl,
  sigcheck,
  supersede,
  userops,
};
const run = mode ? modes[mode] : undefined;
if (!run) {
  console.error(`usage: trade-live.ts <${Object.keys(modes).join('|')}> [options]`);
  process.exit(2);
}
await run();
