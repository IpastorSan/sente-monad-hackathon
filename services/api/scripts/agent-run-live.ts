// Live check (SEN-8): one real agent run on Monad testnet (10143), through the
// real AgentRunnerService, billed to a real per-user OpenRouter key.
//
//   pnpm --filter @sente/api run build            # this script loads dist/
//   pnpm --filter @sente/api run agent:run-live [-- --env-file <path>]
//        [-- --model moonshotai/kimi-k2.6] [-- --instruction "..."] [-- --out run.json]
//
// Without OPENROUTER_MANAGEMENT_KEY it prints "pending credentials" and exits
// 0, spending nothing. That is the state recorded in docs/agents.md.
//
// What it does, once the key exists:
//   1. Boots the compiled API (dist/app.module.js) as an application context:
//      the same providers `node dist/main.js` wires, no HTTP. The scheduler is
//      forced off (AGENT_TICK_SECONDS is cleared).
//   2. Reuses the FUNDED SEN-6 probe wallet (PRIVY_AGENT_VENUES_*: 12 USDC in
//      Kuru AccountCore, AUSD in Perpl account 505). Re-PATCHes its policy
//      with this script's small mandate — Kuru MON-USDC and Perpl BTC-PERP,
//      no order over 20 USDC — and waits 5 s for Privy to apply it (SEN-3).
//   3. Registers that wallet as an agent of user `sente-live-runner` in the
//      in-memory store (hire would mint a new, unfunded wallet).
//   4. Runs it once. The runner provisions the user's OpenRouter key
//      (OPENROUTER_DEFAULT_LIMIT_USD, default $5) on first use.
//   5. Prints the RunResult and its events, and exits 1 unless the run
//      produced at least one `thesis` event and one `order` event that landed.
//   6. Deletes the OpenRouter key it minted and closes the app, whatever happened.
//
// AGENT_PRECHECK=off passes straight through, so SEN-9's refusal demo is this
// script with that variable set and an instruction that breaks the mandate.
//
// Secrets: neither the management key nor the user key is ever printed; the
// runner redacts the key from every error it records. Ids, addresses, hashes
// and the model's own words are printed.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { envFileFromArgs } from './env-file.ts';

const USER_ID = 'sente-live-runner';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
const DEFAULT_INSTRUCTION =
  'Live check. Record a thesis for MON-USDC on Kuru. Then place exactly ONE GTC buy limit ' +
  'order on Kuru MON-USDC at about half the best bid, sized to a notional of about 5 USDC, so ' +
  'it rests without filling. Then cancel that order and end your turn. Do nothing else.';
/** Privy applies a policy PATCH asynchronously (SEN-3 run 5). */
const PATCH_SETTLE_MS = 5_000;
const DAY = 86_400;

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

function mandateInput(expiresAt: number, usdc: string, market: string) {
  return {
    version: 1,
    chainId: 10143,
    expiresAt,
    venues: ['kuru', 'perpl'],
    kuru: {
      markets: [market.toLowerCase()],
      maxDepositAtoms: { [usdc.toLowerCase()]: '20000000' }, // 20 USDC per tx
    },
    perpl: { maxCollateralAtoms: '100000000', maxLeverage: 5, markets: ['BTC-PERP'] },
    maxOrderNotional: '20',
  };
}

/** What the script reads off the compiled services. Loose on purpose: dist is untyped here. */
interface RunEvent {
  seq: number;
  kind: string;
  layer?: string;
  tool?: string;
  detail: Record<string, unknown>;
}
interface RunResultShape {
  runId: string;
  stopReason: string;
  iterations: number;
  toolCalls: number;
  costUsd?: number;
  finalText?: string;
  error?: string;
  events: RunEvent[];
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  if (!has('OPENROUTER_MANAGEMENT_KEY')) {
    console.log('pending credentials: OPENROUTER_MANAGEMENT_KEY not set');
    console.log(
      'Set it in the repo-root .env, then: pnpm --filter @sente/api run build && ' +
        'pnpm --filter @sente/api run agent:run-live',
    );
    return 0;
  }
  const missing = [
    'PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'PRIVY_AGENT_AUTH_KEY',
    'PRIVY_MANDATE_OWNER_KEY',
    'PRIVY_AGENT_VENUES_WALLET_ID',
    'PRIVY_AGENT_VENUES_WALLET_ADDRESS',
    'PRIVY_AGENT_VENUES_POLICY_ID',
  ].filter((name) => !has(name));
  if (missing.length > 0) {
    console.error(
      `missing ${missing.join(', ')}: this script reuses the funded SEN-6 probe wallet; ` +
        'run `pnpm --filter @sente/api run agent:venues-live` first',
    );
    return 1;
  }
  if (!existsSync(resolve(dist, 'app.module.js'))) {
    console.error('dist/ is missing: run `pnpm --filter @sente/api run build` first');
    return 1;
  }

  // One run, on demand: never let the scheduler run anything else.
  delete process.env['AGENT_TICK_SECONDS'];
  const model = arg('--model') ?? DEFAULT_MODEL;
  const instruction = arg('--instruction') ?? DEFAULT_INSTRUCTION;
  const out = arg('--out');

  require('reflect-metadata');
  // Imported only now, so the pending-credentials path loads nothing heavy.
  const { NestFactory } = await import('@nestjs/core');
  const { compileMandate, parseMandate } = await import('@sente/mandate');
  const { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } = await import('@sente/venues/kuru');
  const load = (path: string) => require(resolve(dist, path)) as Record<string, unknown>;
  const { AppModule } = load('app.module.js');
  const { AGENT_STORE } = load('agents/store/agent-store.js');
  const { AGENT_WALLETS } = load('agents/agent-wallet.provider.js');
  const { AgentRunnerService } = load('agents/runner/agent-runner.service.js');
  const { OPENROUTER_KEYS } = load('credits/credits.service.js');
  const { CREDIT_KEYS } = load('credits/store/credit-key-store.js');

  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const store = app.get(AGENT_STORE as symbol) as {
      insert(record: unknown): Promise<void>;
    };
    const wallets = app.get(AGENT_WALLETS as symbol) as {
      updatePolicy(policyId: string, rules: unknown[]): Promise<void>;
    };
    const runner = app.get(AgentRunnerService as never) as {
      run(principal: { userId: string }, agentId: string, options: object): Promise<RunResultShape>;
    };

    const market = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
    const mandate = parseMandate(
      mandateInput(
        Math.floor(Date.now() / 1000) + DAY,
        KURU_TESTNET_TOKENS.USDC.address,
        market.address,
      ),
    );
    const walletId = process.env['PRIVY_AGENT_VENUES_WALLET_ID']!.trim();
    const address = process.env['PRIVY_AGENT_VENUES_WALLET_ADDRESS']!.trim();
    const policyId = process.env['PRIVY_AGENT_VENUES_POLICY_ID']!.trim();
    await wallets.updatePolicy(policyId, compileMandate(mandate));
    console.log(`policy ${policyId} re-PATCHed for this run; settling ${PATCH_SETTLE_MS} ms`);
    await sleep(PATCH_SETTLE_MS);

    const now = new Date();
    const agentId = randomUUID();
    await store.insert({
      id: agentId,
      userId: USER_ID,
      name: 'Live runner probe',
      systemPrompt:
        'You are a cautious probe agent. Keep every order tiny and never let one fill by accident.',
      strategy: 'Follow the run instruction exactly, and nothing more.',
      model,
      mandate,
      walletId,
      address,
      policyId,
      mcpTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      status: 'active',
      policyCleared: false,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`agent ${agentId} = wallet ${walletId} ${address}, model ${model}`);
    console.log(`precheck ${process.env['AGENT_PRECHECK']?.trim() || 'on'}; running…`);

    const result = await runner.run({ userId: USER_ID }, agentId, { instruction });
    for (const event of result.events) {
      console.log(
        `#${event.seq} ${event.kind}${event.layer ? `/${event.layer}` : ''}` +
          `${event.tool ? ` ${event.tool}` : ''} ${JSON.stringify(event.detail)}`,
      );
    }
    const { events: _events, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2));
    if (out) writeFileSync(out, JSON.stringify(result, null, 2));

    const theses = result.events.filter((e) => e.kind === 'thesis').length;
    const orders = result.events.filter(
      (e) => e.kind === 'order' && e.detail['status'] === 'ok',
    ).length;
    console.log(`theses ${theses}, orders that landed ${orders}`);
    return theses >= 1 && orders >= 1 ? 0 : 1;
  } finally {
    // The user key this run minted: delete it by hash, never read it.
    try {
      const keyStore = app.get(CREDIT_KEYS as symbol) as {
        find(userId: string): Promise<{ hash: string } | undefined>;
      };
      const keys = app.get(OPENROUTER_KEYS as symbol) as { deleteKey(hash: string): Promise<void> };
      const record = await keyStore.find(USER_ID);
      if (record) {
        await keys.deleteKey(record.hash);
        console.log('deleted the run’s OpenRouter key');
      }
    } catch (error) {
      console.error(`could not delete the run’s OpenRouter key: ${String(error)}`);
    }
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
