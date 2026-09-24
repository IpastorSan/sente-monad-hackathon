// Live check (SEN-17): an owner hires an agent, funds it, revokes it, and takes
// the money back — through the product's own routes. Monad testnet (10143).
//
//   pnpm --filter @sente/api run build           # this script loads dist/
//   pnpm --filter @sente/api run agent:return-live [-- --usdc 1.5] [--kuru 0.5]
//        [-- --env-file <path>] [-- --out <file.json>]
//
// In order, with every hash and balance printed:
//   1. Binds the dev treasury as the owner's registered wallet, so hire resolves
//      `mandate.returnTo` from the registry exactly as it does for a real user.
//      The treasury STANDS IN for the owner's Privy wallet (same shortcut as
//      SEN-15): the money comes from it and goes back to it, so a run costs
//      nothing but gas.
//   2. `AgentsService.hire` — a real Privy wallet and policy, with the return
//      rules compiled in. The gas drip funds it; the treasury tops it up if the
//      drip was short.
//   3. Funds it with USDC from the treasury, and has the AGENT deposit part of it
//      into its own Kuru account, so the return has both legs to do.
//   4. `AgentsService.revoke` — and reads the policy back: the risk-taking rules
//      are gone, the two recovery rules remain.
//   5. `ReturnFundsService.returnFunds` on the REVOKED agent: withdraw, then
//      transfer, then balances before and after.
//
// `AGENT_MANDATE_OWNER=server` is set by this script: it revokes with the
// server's owner key, and a device-owned revoke needs a phone (SEN-44). The
// return itself is agent-signed, so it is identical either way.
//
// Secrets are never printed; ids, addresses, hashes and amounts are.

import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { envFileFromArgs } from './env-file.ts';

/** The dev treasury (docs/agents.md), standing in for the owner's wallet. */
const TREASURY = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8' as const;
const USER_ID = 'sen17-return-live';
const DAY = 86_400;
/** Monad's reserve-balance window (gotcha 12): the treasury sends MON, then waits. */
const TREASURY_SPACING_MS = 2_500;
/** approve + first deposit + withdraw + transfer, the limits Monad charges in full. */
const AGENT_GAS = 52_089n + 252_059n + 150_407n + 46_525n;

const here = dirname(new URL(import.meta.url).pathname);
const dist = resolve(here, '../dist');
const require = createRequire(import.meta.url);

const results: Record<string, unknown> = {};
const failures: string[] = [];
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const show = (label: string, value: unknown) =>
  console.log(`${label.padEnd(28)} ${typeof value === 'string' ? value : json(value)}`);
const expect = (name: string, pass: boolean, evidence: string) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
  if (!pass) failures.push(`${name}: ${evidence}`);
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function amountArg(name: string, fallback: string): string {
  const raw = arg(name) ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a positive decimal`);
  return raw;
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const out = arg('--out');
  const fundUsdc = amountArg('--usdc', '1.5');
  const kuruUsdc = amountArg('--kuru', '0.5');

  if (!existsSync(resolve(dist, 'app.module.js'))) {
    console.error('dist/ is missing or stale: run `pnpm --filter @sente/api run build` first');
    return 1;
  }
  const treasuryKey = process.env['TREASURY_PRIVATE_KEY']?.trim().replace(/^0x/i, '');
  if (!treasuryKey || !/^[0-9a-f]{64}$/i.test(treasuryKey)) {
    console.error('TREASURY_PRIVATE_KEY is missing or malformed in the env file (value not shown)');
    return 1;
  }
  // Nothing runs but this script, and the revoke is signed by the server key.
  delete process.env['AGENT_TICK_SECONDS'];
  process.env['AGENT_MANDATE_OWNER'] = 'server';
  // No HTTP server is started and no session token is minted here, so the auth
  // module's dev placeholder is enough; a real secret is a deployment concern.
  process.env['AUTH_PLACEHOLDER'] ??= '1';

  require('reflect-metadata');
  const { NestFactory } = await import('@nestjs/core');
  const {
    createPublicClient,
    createWalletClient,
    erc20Abi,
    formatEther,
    formatUnits,
    getAddress,
    http,
    parseUnits,
  } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { monadTestnet } = await import('viem/chains');
  const { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } = await import('@sente/venues/kuru');

  const load = (path: string) => require(resolve(dist, path)) as Record<string, unknown>;
  const { AppModule } = load('app.module.js');
  const { AgentsService } = load('agents/agents.service.js');
  const { ReturnFundsService } = load('agents/recovery/return-funds.service.js');
  const { AgentVenues } = load('agents/venues/agent-venues.js');
  const { AGENT_PUBLIC_CLIENT } = load('agents/venues/agent-venues.providers.js');
  const { AGENT_WALLETS } = load('agents/agent-wallet.provider.js');
  const { USER_WALLET_REGISTRY } = load('wallet/store/user-wallet-registry.js');
  const { getPolicy } = load('agents/privy/policies.js') as {
    getPolicy: (client: unknown, id: string) => Promise<{ rules: { name: string }[] }>;
  };
  const { PrivyClient } = load('agents/privy/privy.client.js') as {
    PrivyClient: new (c: { appId: string; appSecret: string }) => unknown;
  };
  const { loadAgentsConfig } = load('agents/agents.config.js') as {
    loadAgentsConfig: () => { privy?: { appId: string; appSecret: string } };
  };

  const USDC = KURU_TESTNET_TOKENS.USDC;
  const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
  const owner = getAddress(TREASURY);
  const rpc = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
  const treasury = privateKeyToAccount(`0x${treasuryKey}`);
  const treasuryWallet = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(rpc),
  });

  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['warn', 'error'],
  });
  try {
    const get = <T>(token: unknown) => app.get(token as never) as T;
    const agents = get<{
      hire(
        principal: { userId: string },
        input: Record<string, unknown>,
      ): Promise<{ agent: Record<string, unknown> }>;
      revoke(
        principal: { userId: string },
        id: string,
      ): Promise<{ status: string; policyCleared?: boolean }>;
    }>(AgentsService);
    const returns = get<{
      returnFunds(
        principal: { userId: string },
        id: string,
        command?: { asset?: string },
      ): Promise<{
        returnTo: string;
        monSpent: string;
        assets: {
          asset: string;
          withdrawn?: { amount: string; transactionHash: string; success: boolean };
          returned?: { amount: string; transactionHash: string; success: boolean };
          skipped?: string;
        }[];
      }>;
    }>(ReturnFundsService);
    const venues = get<{
      forAgent(a: { agentId: string; walletId: string; address: string }): Promise<{
        kuru: {
          deposit(asset: string, amount: string): Promise<{ transactionHash: string }>;
          getBalances(): Promise<{ asset: string; available: string; locked: string }[]>;
        };
      }>;
      release(agentId: string): void;
    }>(AgentVenues);
    const registry = get<{
      find(userId: string): Promise<unknown>;
      bind(binding: Record<string, unknown>): Promise<{ ok: boolean }>;
    }>(USER_WALLET_REGISTRY);
    void get(AGENT_WALLETS); // fails fast when Privy is not configured
    void get(AGENT_PUBLIC_CLIENT);
    const privy = loadAgentsConfig().privy;
    if (!privy) {
      console.log('pending credentials: PRIVY_APP_ID / PRIVY_APP_SECRET is not configured');
      return 1;
    }
    const privyClient = new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret });

    console.log('SENTE — RETURN TO OWNER (SEN-17), live on Monad testnet');
    show('owner (treasury stand-in)', owner);

    // --- 1. The owner's registered wallet ------------------------------------
    if (!(await registry.find(USER_ID))) {
      await registry.bind({
        userId: USER_ID,
        walletId: 'treasury-stand-in',
        address: owner,
        ownerQuorumId: 'unused-in-server-mode',
        devicePublicKey: 'sen17-live-stand-in',
      });
    }
    const balances = async (agent: string) => {
      const [mon, usdc] = await Promise.all([
        pub.getBalance({ address: agent as `0x${string}` }),
        pub.readContract({
          address: USDC.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [agent as `0x${string}`],
        }),
      ]);
      const ownerUsdc = await pub.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      return { mon, usdc, ownerUsdc };
    };

    // --- 2. Hire -------------------------------------------------------------
    const principal = { userId: USER_ID };
    const hired = await agents.hire(principal, {
      name: 'SEN-17 return probe',
      systemPrompt: '',
      strategy: 'Hold. This agent exists to prove the way out.',
      model: 'anthropic/claude-sonnet-5',
      mandate: {
        version: 1,
        chainId: 10143,
        expiresAt: Math.floor(Date.now() / 1000) + DAY,
        venues: ['kuru'],
        kuru: {
          markets: [MON_USDC.address],
          maxDepositAtoms: { [USDC.address]: parseUnits('1', USDC.decimals).toString() },
        },
        perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
        maxOrderNotional: '5',
      },
    });
    const agent = hired.agent as unknown as {
      id: string;
      walletId: string;
      address: string;
      policyId: string;
      mandate: { returnTo?: string };
      gasFunding?: { funded: boolean; reason?: string; amountWei?: string };
    };
    show('agent', `${agent.id} ${agent.address} policy ${agent.policyId}`);
    results['agent'] = {
      id: agent.id,
      address: agent.address,
      policyId: agent.policyId,
      walletId: agent.walletId,
    };
    expect(
      'hire set returnTo to the owner’s registered wallet, with no client value',
      agent.mandate.returnTo === owner,
      `returnTo ${String(agent.mandate.returnTo)}`,
    );
    const hirePolicy = await getPolicy(privyClient, agent.policyId);
    expect(
      'the policy carries the return rules',
      hirePolicy.rules.some((rule) => rule.name === `Return ${USDC.symbol} to the owner`),
      `${hirePolicy.rules.length} rules: ${hirePolicy.rules.map((r) => r.name).join(', ')}`,
    );

    // --- 3. Fund it, and have it deposit into Kuru ---------------------------
    const fees = await pub.estimateFeesPerGas();
    const needMon = AGENT_GAS * (fees.maxFeePerGas ?? 0n);
    show(
      'gas budget',
      `${AGENT_GAS} gas at ${formatUnits(fees.maxFeePerGas ?? 0n, 9)} gwei = ` +
        `${formatEther(needMon)} MON`,
    );
    let before = await balances(agent.address);
    show('after hire', {
      agentMON: formatEther(before.mon),
      agentUSDC: formatUnits(before.usdc, USDC.decimals),
      drip: agent.gasFunding?.funded ? 'funded' : (agent.gasFunding?.reason ?? 'none'),
    });

    if (before.mon < needMon) {
      const top = needMon - before.mon;
      const hash = await treasuryWallet.sendTransaction({
        to: agent.address as `0x${string}`,
        value: top,
        gas: 21_000n,
      });
      await pub.waitForTransactionReceipt({ hash });
      show('treasury MON top-up', `${formatEther(top)} MON ${hash}`);
      results['topUp'] = { amountMon: formatEther(top), hash };
      // Gotcha 12: the treasury holds under 10 MON, so its next send waits.
      await sleep(TREASURY_SPACING_MS);
    }

    const fundAtoms = parseUnits(fundUsdc, USDC.decimals);
    const fundHash = await treasuryWallet.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [agent.address as `0x${string}`, fundAtoms],
      gas: 82_000n,
    });
    const fundReceipt = await pub.waitForTransactionReceipt({ hash: fundHash });
    show('treasury USDC', `${fundUsdc} USDC ${fundHash} ${fundReceipt.status}`);
    results['funded'] = { usdc: fundUsdc, hash: fundHash, status: fundReceipt.status };
    expect('the agent was funded', fundReceipt.status === 'success', fundReceipt.status);

    const identity = { agentId: agent.id, walletId: agent.walletId, address: agent.address };
    const { kuru } = await venues.forAgent(identity);
    const deposit = await kuru.deposit(USDC.symbol, kuruUsdc);
    const collateral = await kuru.getBalances();
    show(
      'agent deposit into Kuru',
      `${kuruUsdc} USDC ${deposit.transactionHash}; free collateral now ` +
        `${collateral.find((b) => b.asset === USDC.symbol)?.available ?? '0'} USDC`,
    );
    results['deposit'] = { usdc: kuruUsdc, hash: deposit.transactionHash };

    before = await balances(agent.address);
    show('before the return', {
      agentMON: formatEther(before.mon),
      agentWalletUSDC: formatUnits(before.usdc, USDC.decimals),
      agentKuruUSDC: collateral.find((b) => b.asset === USDC.symbol)?.available ?? '0',
      ownerUSDC: formatUnits(before.ownerUsdc, USDC.decimals),
    });
    results['before'] = {
      agentMon: formatEther(before.mon),
      agentWalletUsdc: formatUnits(before.usdc, USDC.decimals),
      agentKuruUsdc: collateral.find((b) => b.asset === USDC.symbol)?.available ?? '0',
      ownerUsdc: formatUnits(before.ownerUsdc, USDC.decimals),
    };

    // --- 4. Revoke, and read the policy back ---------------------------------
    const revoked = await agents.revoke(principal, agent.id);
    const afterRevoke = await getPolicy(privyClient, agent.policyId);
    const names = afterRevoke.rules.map((rule) => rule.name);
    show('revoked', `status ${revoked.status}, policy now: ${names.join(', ') || '(empty)'}`);
    results['revokedPolicy'] = names;
    expect(
      'revoke left the way out and nothing else',
      revoked.status === 'revoked' &&
        revoked.policyCleared === true &&
        names.includes('Kuru: withdraw to its own wallet') &&
        names.includes(`Return ${USDC.symbol} to the owner`) &&
        !names.some((name) => name.startsWith('Kuru: approve') || name.startsWith('Kuru: trade')),
      `${names.length} rule(s)`,
    );

    // --- 5. The return, on a REVOKED agent -----------------------------------
    const outcome = await returns.returnFunds(principal, agent.id, { asset: USDC.symbol });
    const usdcLeg = outcome.assets.find((a) => a.asset === USDC.symbol);
    show('return: withdraw', usdcLeg?.withdrawn ?? 'none');
    show('return: transfer', usdcLeg?.returned ?? usdcLeg?.skipped ?? 'none');
    results['return'] = outcome;
    expect(
      'the return went to the owner’s wallet',
      outcome.returnTo === owner,
      `returnTo ${outcome.returnTo}`,
    );
    expect(
      'the withdraw landed',
      usdcLeg?.withdrawn?.success === true,
      usdcLeg?.withdrawn?.transactionHash ?? 'no withdraw',
    );
    expect(
      'the transfer landed',
      usdcLeg?.returned?.success === true,
      usdcLeg?.returned?.transactionHash ?? 'no transfer',
    );

    const after = await balances(agent.address);
    const afterCollateral = await kuru.getBalances();
    show('after the return', {
      agentMON: formatEther(after.mon),
      agentWalletUSDC: formatUnits(after.usdc, USDC.decimals),
      agentKuruUSDC: afterCollateral.find((b) => b.asset === USDC.symbol)?.available ?? '0',
      ownerUSDC: formatUnits(after.ownerUsdc, USDC.decimals),
    });
    results['after'] = {
      agentMon: formatEther(after.mon),
      agentWalletUsdc: formatUnits(after.usdc, USDC.decimals),
      agentKuruUsdc: afterCollateral.find((b) => b.asset === USDC.symbol)?.available ?? '0',
      ownerUsdc: formatUnits(after.ownerUsdc, USDC.decimals),
    };
    expect(
      'the agent wallet was emptied of USDC',
      after.usdc === 0n,
      `${formatUnits(after.usdc, USDC.decimals)} USDC left`,
    );
    const returnedAtoms = usdcLeg?.returned
      ? parseUnits(usdcLeg.returned.amount, USDC.decimals)
      : 0n;
    expect(
      'the owner received exactly what the return reported',
      after.ownerUsdc - before.ownerUsdc === returnedAtoms && returnedAtoms === fundAtoms,
      `owner USDC ${formatUnits(before.ownerUsdc, USDC.decimals)} → ` +
        `${formatUnits(after.ownerUsdc, USDC.decimals)} (+${usdcLeg?.returned?.amount ?? '0'}, ` +
        `funded ${fundUsdc})`,
    );
    show('agent MON spent on the return', outcome.monSpent);
    venues.release(agent.id);
  } finally {
    await app.close();
  }

  results['failures'] = failures;
  if (out) writeFileSync(out, JSON.stringify(JSON.parse(json(results)), null, 2));
  console.log(
    failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`,
  );
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
