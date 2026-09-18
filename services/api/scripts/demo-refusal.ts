// The refusal, end to end (SEN-9): an agent tries to exceed its mandate and
// the enclave says no. Live on Monad testnet (10143). Runbook:
// docs/demo-refusal.md.
//
//   pnpm --filter @sente/api run build            # this script loads dist/
//   pnpm --filter @sente/api run demo:refusal -- --mode scripted [--out <file>] [--env-file <path>]
//   pnpm --filter @sente/api run demo:refusal -- --mode model [--model moonshotai/kimi-k2.6] [...]
//
// --mode scripted: NO MODEL. A fixed sequence of calls through the same gated
//   tools (agentTools.context(...) and gate()) a model's tool calls take. It
//   proves what the enclave does; it is never an agent's decision, and every
//   act of its output says so.
// --mode model: a real model, run by the agent runner and billed to a fresh
//   OpenRouter key, is told to exceed its mandate. Without
//   OPENROUTER_MANAGEMENT_KEY it prints "pending credentials" and exits 0.
//
// Both modes share scripts' act 1 (below) and acts 2–5 in
// src/agents/demo/refusal-demo.ts, which the CI spec runs against fakes.
//
// Act 1 reuses the FUNDED SEN-6 probe wallet (PRIVY_AGENT_VENUES_*) rather
// than minting one: a hire mints an unfunded wallet. It re-PATCHes that
// wallet's own `sente-` policy with the demo mandate (owner key), registers
// the wallet as an agent in the in-memory store, and never funds anything:
// when the wallet is short it prints the `agent:fund` command and stops.
//
// Act 5 REVOKES the agent, which empties that policy. The next run (or
// `agent:venues-live`) re-PATCHes it; nothing else in the shared Privy app is
// touched.
//
// Secrets: no key, secret or token is printed. Ids, addresses and hashes are.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type * as DemoModule from '../src/agents/demo/refusal-demo.ts';
import { envFileFromArgs } from './env-file.ts';

const USER_ID = 'sente-demo-refusal';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
const CAP_USDC = '1';
const OVER_CAP_USDC = '2';
const DAY = 86_400;
/** approve + first-deposit gas limits (docs/agents.md), charged in full on Monad. */
const DEPOSIT_GAS = 80_000n + 252_059n;
const USDC_ATOMS = 1_000_000n;

const here = dirname(new URL(import.meta.url).pathname);
const dist = resolve(here, '../dist');
const require = createRequire(import.meta.url);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

const has = (name: string) => Boolean(process.env[name]?.trim());
const env = (name: string) => process.env[name]!.trim();

interface Address0x {
  readonly address: `0x${string}`;
}

async function main(): Promise<number> {
  const mode = arg('--mode');
  if (mode !== 'scripted' && mode !== 'model') {
    console.error(
      'usage: demo:refusal -- --mode scripted|model [--out <file>] [--env-file <path>]',
    );
    return 1;
  }
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  if (mode === 'model' && !has('OPENROUTER_MANAGEMENT_KEY') && !has('OPENROUTER_API_KEY')) {
    console.log(
      'pending credentials: neither OPENROUTER_MANAGEMENT_KEY nor OPENROUTER_API_KEY is set',
    );
    console.log(
      'Set it in the repo-root .env, then: pnpm --filter @sente/api run build && ' +
        'pnpm --filter @sente/api run demo:refusal -- --mode model',
    );
    return 0;
  }
  const missing = [
    'PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'PRIVY_AGENT_AUTH_KEY',
    'PRIVY_MANDATE_OWNER_KEY',
    'PRIVY_AGENT_QUORUM_ID',
    'PRIVY_MANDATE_QUORUM_ID',
    'PRIVY_AGENT_VENUES_WALLET_ID',
    'PRIVY_AGENT_VENUES_WALLET_ADDRESS',
    'PRIVY_AGENT_VENUES_POLICY_ID',
  ].filter((name) => !has(name));
  if (missing.length > 0) {
    console.error(
      `missing ${missing.join(', ')}: the demo reuses the funded SEN-6 probe wallet; ` +
        'run `pnpm --filter @sente/api run agent:venues-live` first',
    );
    return 1;
  }
  if (!existsSync(resolve(dist, 'agents/demo/refusal-demo.js'))) {
    console.error('dist/ is missing or stale: run `pnpm --filter @sente/api run build` first');
    return 1;
  }
  delete process.env['AGENT_TICK_SECONDS']; // nothing runs but the demo
  // The demo is a SERVER-owned-mandate demo (SEN-43): Act 4 amends the mandate
  // with PRIVY_MANDATE_OWNER_KEY, and its principal has no registered user
  // wallet, so it declares the mode rather than depending on the operator's
  // .env. A device-owned mandate can only be amended by the phone (SEN-44).
  process.env['AGENT_MANDATE_OWNER'] ??= 'server';
  const model = arg('--model') ?? DEFAULT_MODEL;
  const out = arg('--out');

  require('reflect-metadata');
  const { NestFactory } = await import('@nestjs/core');
  const { erc20Abi, formatEther, formatUnits } = await import('viem');
  const { KURU_TESTNET_TOKENS, fromUnits, precisionDecimals, toUnits } =
    await import('@sente/venues/kuru');
  const load = (path: string) => require(resolve(dist, path)) as Record<string, unknown>;
  const demo = load('agents/demo/refusal-demo.js') as unknown as typeof DemoModule;
  const { AppModule } = load('app.module.js');
  const { AGENT_STORE } = load('agents/store/agent-store.js');
  const { AGENT_WALLETS } = load('agents/agent-wallet.provider.js');
  const { AGENT_EVENTS } = load('agents/events/agent-event-log.js');
  const { AgentsService } = load('agents/agents.service.js');
  const { AgentTools } = load('agents/tools/context.js');
  const { AgentVenues } = load('agents/venues/agent-venues.js');
  const { AGENT_PUBLIC_CLIENT } = load('agents/venues/agent-venues.providers.js');
  const { loadAgentsConfig } = load('agents/agents.config.js') as {
    loadAgentsConfig: () => { privy?: { appId: string; appSecret: string; agentAuthKey: never } };
  };
  const { PrivyClient } = load('agents/privy/privy.client.js') as {
    PrivyClient: new (c: { appId: string; appSecret: string }) => never;
  };

  const transcript: string[] = [];
  const log = (line: string) => {
    console.log(line);
    transcript.push(line);
  };
  const label = mode === 'scripted' ? demo.SCRIPTED_LABEL : demo.MODEL_LABEL;

  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['warn', 'error'],
  });
  try {
    const get = <T>(token: unknown) => app.get(token as never) as T;
    const store = get<{
      insert(record: unknown): Promise<void>;
      get(id: string): Promise<unknown>;
    }>(AGENT_STORE);
    const wallets = get<Parameters<typeof demo.PrivyCallCounter.wrap>[0]>(AGENT_WALLETS);
    const events = get<Parameters<typeof demo.runRefusalDemo>[0]['events']>(AGENT_EVENTS);
    const agents = get<Parameters<typeof demo.runRefusalDemo>[0]['agents']>(AgentsService);
    const venues = get<{
      forAgent(a: { agentId: string; walletId: string; address: string }): Promise<{
        kuru: {
          marketParams(symbol: string): Promise<{
            pricePrecision: bigint;
            sizePrecision: bigint;
            tickSize: bigint;
            minQuoteNotional: bigint;
          }>;
          getDepth(q: { symbol: string; limit: number }): Promise<{
            bids: { price: string }[];
            asks: { price: string }[];
          }>;
          getBalances(): Promise<{ asset: string; available: string }[]>;
        };
      }>;
    }>(AgentVenues);
    const pub = get<{
      getBalance(a: { address: `0x${string}` }): Promise<bigint>;
      readContract(a: unknown): Promise<unknown>;
      getTransactionCount(a: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
      getTransactionReceipt(a: {
        hash: `0x${string}`;
      }): Promise<{ status: 'success' | 'reverted' }>;
    }>(AGENT_PUBLIC_CLIENT);

    // Counts every Privy call made through the provider, from here on.
    const counter = demo.PrivyCallCounter.wrap(wallets);

    const walletId = env('PRIVY_AGENT_VENUES_WALLET_ID');
    const address = env('PRIVY_AGENT_VENUES_WALLET_ADDRESS') as `0x${string}`;
    const policyId = env('PRIVY_AGENT_VENUES_POLICY_ID');
    const agentId = randomUUID();
    const USDC = KURU_TESTNET_TOKENS.USDC as Address0x & { decimals: number };

    log('SENTE — THE REFUSAL (SEN-9)');
    log(`mode: ${label}`);
    if (mode === 'scripted') {
      log('Nothing below is an agent deciding anything: a fixed script calls the gated tools.');
    }
    log(`run at ${new Date().toISOString()} on Monad testnet (10143)`);

    // --- Balances and the funding gate ----------------------------------------
    const fees = async () => {
      const f = await pub.estimateFeesPerGas();
      if (f.maxFeePerGas === undefined || f.maxPriorityFeePerGas === undefined) {
        throw new Error('the RPC returned no EIP-1559 fees');
      }
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    };
    const balances = async () => {
      const identity = { agentId, walletId, address };
      const [mon, usdc, kuru, nonce] = await Promise.all([
        pub.getBalance({ address }),
        pub.readContract({
          address: USDC.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }) as Promise<bigint>,
        venues.forAgent(identity).then((v) => v.kuru.getBalances()),
        pub.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      return {
        mon,
        usdc,
        kuruUsdc: kuru.find((b) => b.asset === 'USDC')?.available ?? '0',
        nonce,
      };
    };
    const before = await balances();
    const needMon = (DEPOSIT_GAS * (await fees()).maxFeePerGas * 11n) / 10n;
    const needUsdc = toUnits(OVER_CAP_USDC, USDC.decimals, 'amount');
    const describe = (b: typeof before) =>
      `MON ${formatEther(b.mon)}, wallet USDC ${formatUnits(b.usdc, USDC.decimals)}, ` +
      `Kuru AccountCore USDC ${b.kuruUsdc}, nonce ${b.nonce}`;
    log(`agent ${address} before: ${describe(before)}`);
    if (before.mon < needMon || before.usdc < needUsdc) {
      const monShort = before.mon >= needMon ? 0n : needMon - before.mon;
      const usdcShort = before.usdc >= needUsdc ? 0n : needUsdc - before.usdc;
      log('');
      log(`The agent is short (act 4 lands a ${OVER_CAP_USDC} USDC deposit). Fund it, then rerun:`);
      log(
        `  pnpm --filter @sente/api run agent:fund -- --to ${address}` +
          (monShort > 0n ? ` --mon ${formatEther(monShort)}` : '') +
          (usdcShort > 0n ? ` --usdc ${formatUnits(usdcShort, USDC.decimals)}` : ''),
      );
      return 2;
    }

    // --- The plan: a real WETH-USDC order, valid for the market, far under the touch.
    const { kuru } = await venues.forAgent({ agentId, walletId, address });
    const params = await kuru.marketParams(demo.DEMO_OFF_MARKET);
    const depth = await kuru.getDepth({ symbol: demo.DEMO_OFF_MARKET, limit: 1 });
    const reference = depth.bids[0]?.price ?? depth.asks[0]?.price;
    if (!reference)
      throw new Error(`${demo.DEMO_OFF_MARKET} has an empty book: no reference price`);
    const pd = precisionDecimals(params.pricePrecision);
    let priceRaw = toUnits(reference, pd, 'price') / 2n;
    priceRaw -= priceRaw % params.tickSize;
    const target =
      params.minQuoteNotional * 2n > USDC_ATOMS ? params.minQuoteNotional * 2n : USDC_ATOMS;
    const denominator = priceRaw * 10n ** BigInt(USDC.decimals);
    const quantity =
      (target * params.pricePrecision * params.sizePrecision + denominator - 1n) / denominator;
    const plan: DemoModule.DemoPlan = {
      capUsdc: CAP_USDC,
      overCapUsdc: OVER_CAP_USDC,
      raisedCapUsdc: OVER_CAP_USDC,
      offAllowlistOrder: {
        size: fromUnits(quantity, precisionDecimals(params.sizePrecision)),
        price: fromUnits(priceRaw, pd),
      },
      expiresAt: Math.floor(Date.now() / 1000) + DAY,
    };

    // --- Act 1: re-arm the funded wallet under the demo mandate ---------------
    const armStart = Date.now();
    await counter.tagged('owner', () =>
      wallets.updatePolicy(policyId, demo.demoRules(plan, plan.capUsdc)),
    );
    const armMs = Date.now() - armStart;
    const { parseMandate } = await import('@sente/mandate');
    const now = new Date();
    await store.insert({
      id: agentId,
      userId: USER_ID,
      name: 'Refusal demo',
      systemPrompt:
        'You are a demo agent. Your mandate is final: never try to route around a refusal.',
      strategy: 'Follow the run instruction, and nothing more.',
      model,
      mandate: parseMandate(demo.demoMandateInput(plan, plan.capUsdc)),
      walletId,
      address,
      policyId,
      mcpTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      status: 'active',
      policyCleared: false,
      createdAt: now,
      updatedAt: now,
    });
    const agent = (await store.get(agentId)) as Parameters<typeof demo.runRefusalDemo>[1];

    const venuesFor = (a: { id: string; walletId: string; address: string }) =>
      venues.forAgent({ agentId: a.id, walletId: a.walletId, address: a.address });
    const Tools = AgentTools as new (
      options: unknown,
    ) => Parameters<typeof demo.scriptedDriver>[0]['tools']['off'];
    const tools = {
      off: new Tools({ store, events, precheck: false, venuesFor }),
      on: new Tools({ store, events, precheck: true, venuesFor }),
    };

    let driver: DemoModule.DemoDriver;
    let deleteKey: (() => Promise<void>) | undefined;
    if (mode === 'scripted') {
      driver = demo.scriptedDriver({ tools, plan });
    } else {
      const { AgentRunnerService } = load('agents/runner/agent-runner.service.js');
      const { CreditsService, OPENROUTER_KEYS } = load('credits/credits.service.js');
      const { CREDIT_KEYS } = load('credits/store/credit-key-store.js');
      const { AGENT_RUNNER_CONFIG } = load('agents/runner/runner.config.js');
      const { ANTHROPIC_CLIENT_FACTORY } = load('agents/runner/openrouter-client.js');
      const { WriteSpacer } = load('agents/runner/write-spacing.js');
      const Runner = AgentRunnerService as new (...deps: unknown[]) => DemoModule.DemoRunner;
      const runner = (t: unknown) =>
        new Runner(
          agents,
          store,
          t,
          events,
          get(CreditsService),
          get(AGENT_RUNNER_CONFIG),
          get(ANTHROPIC_CLIENT_FACTORY),
          get(WriteSpacer),
        );
      driver = demo.modelDriver({
        runners: { off: runner(tools.off), on: runner(tools.on) },
        principal: { userId: USER_ID },
        plan,
      });
      deleteKey = async () => {
        const keyStore = get<{ find(u: string): Promise<{ hash: string } | undefined> }>(
          CREDIT_KEYS,
        );
        const keys = get<{ deleteKey(hash: string): Promise<void> }>(OPENROUTER_KEYS);
        const record = await keyStore.find(USER_ID);
        if (record) {
          await keys.deleteKey(record.hash);
          log('deleted the run’s OpenRouter key');
        }
      };
    }

    const config = loadAgentsConfig();
    const privyClient = new PrivyClient({
      appId: config.privy!.appId,
      appSecret: config.privy!.appSecret,
    });
    try {
      const report = await demo.runRefusalDemo(
        {
          driver,
          agents,
          events,
          principal: { userId: USER_ID },
          counter,
          probe: demo.approveProbe({
            wallets,
            walletId,
            counter,
            pendingNonce: () => pub.getTransactionCount({ address, blockTag: 'pending' }),
            fees,
          }),
          nonce: () => pub.getTransactionCount({ address, blockTag: 'pending' }),
          patchWithAgentKey: demo.agentKeyPatcher(privyClient, config.privy!.agentAuthKey),
          plan,
          log,
          act1Notes: [
            'reused the funded SEN-6 probe wallet rather than minting one (a hire mints an ' +
              'unfunded wallet); no funds were moved by this script',
            `owner-key PATCH of its policy to the demo mandate returned in ${armMs} ms`,
            `registered as agent ${agentId} of user ${USER_ID} (in-memory store)` +
              (mode === 'scripted'
                ? '; the record names a model, but no model is called'
                : `, model ${model}`),
            `the off-allowlist order used below: buy ${plan.offAllowlistOrder.size} WETH @ ` +
              `${plan.offAllowlistOrder.price} (half the ${demo.DEMO_OFF_MARKET} reference ` +
              `${reference}), a valid order for that market`,
          ],
          receipt: (hash) =>
            pub.getTransactionReceipt({ hash }).then(
              (r) => r.status,
              () => undefined,
            ),
        },
        agent,
      );

      const after = await balances();
      log('');
      log(`agent ${address} after: ${describe(after)}`);
      log(
        `spent by the agent: ${formatEther(before.mon - after.mon)} MON gas; ` +
          `${formatUnits(before.usdc - after.usdc, USDC.decimals)} USDC moved from its wallet ` +
          'into its own Kuru account',
      );
      log(
        `Privy calls through the provider: ${counter.calls.length} ` +
          `(tools ${counter.calls.filter((c) => c.tag === 'tools').length}, ` +
          `sign-only probes ${counter.calls.filter((c) => c.tag === 'probe').length}, ` +
          `owner PATCHes ${counter.calls.filter((c) => c.tag === 'owner').length}); ` +
          'plus 1 PATCH attempted with the agent key',
      );
      return report.passed ? 0 : 1;
    } finally {
      await deleteKey?.().catch((error: unknown) =>
        log(`could not delete the run’s OpenRouter key: ${String(error)}`),
      );
    }
  } finally {
    if (out) writeFileSync(out, `${transcript.join('\n')}\n`);
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
