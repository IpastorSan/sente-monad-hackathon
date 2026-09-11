// Live check (SEN-6): an agent's Privy wallet places and cancels real orders
// on both venues, Monad testnet (10143).
//
//   pnpm --filter @sente/api run agent:venues-live [-- --env-file <path>] [-- --out <file.json>]
//
// What it does, in order, with every hash printed:
//   1. Reuses the probe agent wallet recorded in .env as PRIVY_AGENT_VENUES_*,
//      or provisions one (`sente-agent-venues-live`) under a compiled mandate:
//      Kuru MON-USDC with deposits ≤ 20 USDC per tx, Perpl BTC-PERP with
//      collateral ≤ 100 AUSD. The wallet is only CREATED, in the shared Privy
//      app, and only its own policy is ever PATCHed (to renew its expiry).
//   2. Checks the agent's balances and, if it is short, prints the exact
//      `agent:fund` command and stops. Nothing is funded from here.
//   3. Enclave check, no gas: a 25 USDC Kuru deposit (over the cap) must be
//      refused with EnclaveRefusedError, and the nonce must not move.
//   4. Kuru: deposit (if needed), one GTC bid far below the touch, cancel.
//   5. Perpl: onboard (three Privy-signed txs, skipped if the account exists),
//      enroll an API key once and reuse it, one POST_ONLY bid ~10% under the
//      book and its cancel, then a minimum-size position opened and closed.
//
// Secrets: the Privy app secret, the authorization keys and the Perpl API key
// are never printed. What is printed is ids, addresses and hashes.
//
// Enrollment is once per AGENT (the AgentSecretStore), but that store is in
// memory, so each RUN of this script enrolls one new key (max 16 per account).

import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { compileMandate, parseMandate } from '@sente/mandate';
import { KURU_MEASURED_GAS, KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { monadTestnet } from 'viem/chains';

import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { EnclaveRefusedError } from '../src/agents/agents.errors.ts';
import { getAgentWallet } from '../src/agents/privy/agent-wallet.ts';
import { PrivyAgentWalletProvider } from '../src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient } from '../src/agents/privy/privy.client.ts';
import { InMemoryAgentSecretStore } from '../src/agents/venues/agent-secret-store.ts';
import {
  AgentTransactionSender,
  agentChainClient,
  type AgentIdentity,
} from '../src/agents/venues/agent-transactions.ts';
import { AgentVenues } from '../src/agents/venues/agent-venues.ts';
import {
  PERPL_ONBOARDING_GAS,
  PerplAgentAccounts,
  perplAccountReader,
} from '../src/agents/venues/perpl-agent.ts';
import {
  AGENT_APPROVE_GAS,
  PrivyKuruSubmitter,
} from '../src/agents/venues/privy-kuru-submitter.ts';
import { envFileFromArgs, upsertEnv } from './env-file.ts';

const KURU_SYMBOL = 'MON-USDC';
const PERPL_SYMBOL = 'BTC-PERP';
const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === KURU_SYMBOL)!;
const USDC = KURU_TESTNET_TOKENS.USDC;
const KURU_DEPOSIT = '12';
const KURU_ORDER_NOTIONAL = 10.5;
const PERPL_OPEN_ATOMS = 100_000_000n; // the testnet minimum, 100 AUSD
const WEEK = 7 * 86_400;
/** Privy applies a policy PATCH asynchronously (SEN-3 run 5). */
const PATCH_SETTLE_MS = 5_000;

const results: Record<string, unknown> = {};
const failures: string[] = [];
const show = (label: string, value: unknown) =>
  console.log(
    `${label.padEnd(24)} ${
      typeof value === 'string'
        ? value
        : JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
    }`,
  );

function mandateInput(expiresAt: number) {
  return {
    version: 1,
    chainId: 10143,
    expiresAt,
    venues: ['kuru', 'perpl'],
    kuru: {
      markets: [MON_USDC.address.toLowerCase()],
      maxDepositAtoms: { [USDC.address.toLowerCase()]: '20000000' }, // 20 USDC per tx
    },
    perpl: {
      maxCollateralAtoms: String(PERPL_OPEN_ATOMS),
      maxLeverage: 5,
      markets: [PERPL_SYMBOL],
    },
    maxOrderNotional: '200',
  };
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    failures.push(`${name}: ${message}`);
    show(`FAILED ${name}`, message);
    return undefined;
  }
}

const decimalsOf = (value: string) => (value.split('.')[1] ?? '').length;

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

  const config = loadAgentsConfig(process.env);
  if (!config.privy) {
    console.log('pending credentials: PRIVY_* is not configured');
    return 0;
  }
  const privy = config.privy;
  const client = new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret });
  const provider = new PrivyAgentWalletProvider({
    client,
    agentKey: privy.agentAuthKey,
    mandateOwnerKey: privy.mandateOwnerKey,
    agentQuorumId: privy.agentQuorumId,
    mandateQuorumId: privy.mandateQuorumId,
    onQuorumsCreated: (q) =>
      upsertEnv(envFile, {
        PRIVY_AGENT_QUORUM_ID: q.agentQuorumId,
        PRIVY_MANDATE_QUORUM_ID: q.mandateQuorumId,
      }),
  });
  const rpc = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;

  // --- 1. The probe agent wallet ---------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  let walletId = process.env['PRIVY_AGENT_VENUES_WALLET_ID'];
  let policyId = process.env['PRIVY_AGENT_VENUES_POLICY_ID'];
  let address: Address;
  if (walletId && policyId) {
    address = getAddress((await getAgentWallet(client, walletId)).address);
    // Always re-PATCH with freshly compiled rules: this keeps the policy in step
    // with @sente/mandate (the Perpl enrollment struct changed under us once,
    // 2026-09-11) and renews its expiry. Only this script's own policy.
    const renewed = now + WEEK;
    await provider.updatePolicy(policyId, compileMandate(parseMandate(mandateInput(renewed))));
    upsertEnv(envFile, { PRIVY_AGENT_VENUES_EXPIRES_AT: String(renewed) }, { overwrite: true });
    show('policy recompiled', `${policyId} until ${new Date(renewed * 1000).toISOString()}`);
    await sleep(PATCH_SETTLE_MS);
    show('agent wallet (reused)', `${walletId} ${address}`);
  } else {
    const expiresAt = now + WEEK;
    const provisioned = await provider.provision({
      rules: compileMandate(parseMandate(mandateInput(expiresAt))),
      displayName: 'sente-agent-venues-live',
    });
    ({ walletId, policyId } = provisioned);
    address = provisioned.address;
    upsertEnv(envFile, {
      PRIVY_AGENT_VENUES_WALLET_ID: walletId,
      PRIVY_AGENT_VENUES_WALLET_ADDRESS: address,
      PRIVY_AGENT_VENUES_POLICY_ID: policyId,
      PRIVY_AGENT_VENUES_EXPIRES_AT: String(expiresAt),
    });
    show('agent wallet (new)', `${walletId} ${address} policy ${policyId}`);
  }
  const agent: AgentIdentity = { agentId: 'sente-agent-venues-live', walletId, address };
  Object.assign(results, { walletId, policyId, address });

  const sender = new AgentTransactionSender({ wallets: provider, chain: agentChainClient(pub) });
  const secrets = new InMemoryAgentSecretStore();
  const accountOf = perplAccountReader(pub);
  const perplAccounts = new PerplAgentAccounts({ sender, wallets: provider, secrets, accountOf });
  const venues = new AgentVenues({ publicClient: pub, sender, secrets });

  // --- 2. Funding ---------------------------------------------------------------
  const balanceOf = (token: Address) =>
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  const [mon, ausd, usdc, perplAccount, fees] = await Promise.all([
    pub.getBalance({ address }),
    balanceOf(PERPL_TESTNET_CONTRACTS.collateral),
    balanceOf(USDC.address),
    accountOf(address),
    pub.estimateFeesPerGas(),
  ]);
  const { kuru } = await venues.forAgent(agent);
  const kuruUsdc = (await kuru.getBalances()).find((b) => b.asset === 'USDC');
  const kuruNeedsDeposit = Number(kuruUsdc?.available ?? '0') < KURU_ORDER_NOTIONAL;

  // --skip-kuru: rerun only the Perpl half (Kuru costs ~0.07 MON a pass).
  const skipKuru = process.argv.includes('--skip-kuru');
  const gas =
    (skipKuru
      ? 0n
      : (kuruNeedsDeposit ? AGENT_APPROVE_GAS + KURU_MEASURED_GAS.firstDeposit : 0n) +
        KURU_MEASURED_GAS.placeTakingOneLevel +
        KURU_MEASURED_GAS.cancelOne) +
    (perplAccount === null
      ? PERPL_ONBOARDING_GAS.approve +
        PERPL_ONBOARDING_GAS.createAccount +
        PERPL_ONBOARDING_GAS.allowOrderForwarding
      : 0n);
  const needMon = (gas * fees.maxFeePerGas! * 11n) / 10n;
  const needAusd = perplAccount === null ? PERPL_OPEN_ATOMS : 0n;
  const needUsdc =
    !skipKuru && kuruNeedsDeposit ? BigInt(KURU_DEPOSIT) * 10n ** BigInt(USDC.decimals) : 0n;
  show('agent balances', {
    MON: formatEther(mon),
    AUSD: formatUnits(ausd, PERPL_COLLATERAL_DECIMALS),
    USDC: formatUnits(usdc, USDC.decimals),
    kuruAccountUsdc: kuruUsdc?.available ?? '0',
    perplAccount: perplAccount ?? 'none',
  });
  show('this run needs', {
    gas: gas.toString(),
    MON: formatEther(needMon),
    AUSD: formatUnits(needAusd, PERPL_COLLATERAL_DECIMALS),
    USDC: formatUnits(needUsdc, USDC.decimals),
  });
  results['monBefore'] = formatEther(mon);
  if (mon < needMon || ausd < needAusd || usdc < needUsdc) {
    const topUp = (have: bigint, need: bigint) => (have >= need ? 0n : need - have);
    console.log(
      '\nThe agent is short. Fund it, then rerun:\n' +
        `  pnpm --filter @sente/api run agent:fund -- --to ${address}` +
        ` --mon ${formatEther(topUp(mon, needMon))}` +
        ` --ausd ${formatUnits(topUp(ausd, needAusd), PERPL_COLLATERAL_DECIMALS)}` +
        ` --usdc ${formatUnits(topUp(usdc, needUsdc), USDC.decimals)}`,
    );
    return 2;
  }

  // --- 3. The enclave refuses an over-cap deposit, and nothing is sent ---------
  await step('enclave refusal', async () => {
    const before = await pub.getTransactionCount({ address, blockTag: 'pending' });
    let refused: EnclaveRefusedError | undefined;
    try {
      await new PrivyKuruSubmitter({ wallet: agent, sender }).submit(
        kuru.depositCalls('USDC', '25'),
      );
    } catch (error) {
      if (!(error instanceof EnclaveRefusedError)) throw error;
      refused = error;
    }
    const after = await pub.getTransactionCount({ address, blockTag: 'pending' });
    results['refusal'] = {
      refused: !!refused,
      method: refused?.method,
      nonceBefore: before,
      nonceAfter: after,
    };
    show('over-cap deposit', results['refusal']);
    if (!refused || after !== before)
      throw new Error('the over-cap deposit was not cleanly refused');
  });

  // --- 4. Kuru: deposit, rest a bid far from the touch, cancel ------------------
  await step('kuru', async () => {
    if (skipKuru) {
      results['kuru'] = 'skipped (--skip-kuru)';
      show('kuru', 'skipped (--skip-kuru)');
      return;
    }
    const kuruResult: Record<string, unknown> = {};
    results['kuru'] = kuruResult;
    if (kuruNeedsDeposit) {
      const deposit = await kuru.deposit('USDC', KURU_DEPOSIT);
      kuruResult['depositTx'] = deposit.transactionHash;
      show('kuru deposit', `${KURU_DEPOSIT} USDC ${deposit.transactionHash}`);
    }
    kuruResult['accountId'] = await kuru.accountId();

    const market = (await kuru.getMarkets()).find((m) => m.symbol === KURU_SYMBOL);
    if (!market) throw new Error(`${KURU_SYMBOL} is not listed`);
    const depth = await kuru.getDepth({ symbol: KURU_SYMBOL, limit: 1 });
    const bestBid = Number(depth.bids[0]?.price ?? depth.asks[0]?.price ?? NaN);
    if (!(bestBid > 0)) throw new Error('empty book: no reference price');
    const tick = Number(market.tickSize);
    const step_ = Number(market.stepSize);
    const priceNum = Math.floor((bestBid * 0.5) / tick) * tick;
    const price = priceNum.toFixed(decimalsOf(market.tickSize));
    const size = (Math.ceil(KURU_ORDER_NOTIONAL / priceNum / step_) * step_).toFixed(
      decimalsOf(market.stepSize),
    );
    show('kuru bid', `${size} MON at ${price} (best bid ${bestBid})`);

    const placed = await kuru.placeLimit({
      symbol: KURU_SYMBOL,
      side: 'buy',
      size,
      price,
      timeInForce: 'GTC',
      clientOrderId: `sente-sen6-${Date.now()}`,
    });
    Object.assign(kuruResult, {
      orderId: placed.id,
      status: placed.status,
      placeTx: placed.txHash,
      price,
      size,
    });
    show('kuru placed', { id: placed.id, status: placed.status, tx: placed.txHash });

    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) {
      seen = (await kuru.getOpenOrders(KURU_SYMBOL)).some((o) => o.id === placed.id);
      if (!seen) await sleep(1_000);
    }
    kuruResult['gatewayListedIt'] = seen;

    const cancelled = await kuru.cancel({ symbol: KURU_SYMBOL, orderId: placed.id });
    Object.assign(kuruResult, { cancelStatus: cancelled.status, cancelTx: cancelled.txHash });
    show('kuru cancelled', { id: cancelled.id, status: cancelled.status, tx: cancelled.txHash });
    if (cancelled.status !== 'cancelled') throw new Error(`cancel ended ${cancelled.status}`);
  });

  // --- 5. Perpl: onboard, enroll once, order + cancel, open + close -------------
  await step('perpl', async () => {
    const perplResult: Record<string, unknown> = {};
    results['perpl'] = perplResult;
    const onboarding = await perplAccounts.onboard(agent);
    Object.assign(perplResult, {
      accountId: onboarding.accountId,
      onboarded: onboarding.onboarded,
      onboardingTxs: onboarding.transactions,
    });
    show('perpl account', {
      id: onboarding.accountId,
      onboardedNow: onboarding.onboarded,
      txs: onboarding.transactions,
    });

    const first = await perplAccounts.credentials(agent);
    const second = await perplAccounts.credentials(agent);
    perplResult['credentialsReused'] = first.apiKey === second.apiKey;
    show(
      'perpl api key',
      `enrolled; held server-side; reused on second call: ${first.apiKey === second.apiKey}`,
    );

    const { perpl } = await venues.forAgent(agent);
    if (!perpl) throw new Error('AgentVenues gave no Perpl venue after enrollment');
    try {
      show('perpl balances', await perpl.getBalances());
      const depth = await perpl.getDepth({ symbol: PERPL_SYMBOL, limit: 1 });
      const bestBid = Number(depth.bids[0]?.price ?? '0');
      const restingPrice = (Math.floor(bestBid * 9) / 10).toFixed(1); // ~10% under the book
      const resting = await perpl.placeLimit({
        symbol: PERPL_SYMBOL,
        side: 'buy',
        size: '0.001',
        price: restingPrice,
        timeInForce: 'POST_ONLY',
      });
      Object.assign(perplResult, {
        restingOrderId: resting.id,
        restingStatus: resting.status,
        restingTx: resting.txHash,
      });
      show('perpl resting', {
        id: resting.id,
        status: resting.status,
        price: resting.price,
        tx: resting.txHash,
      });
      const cancelled = await perpl.cancel({ symbol: PERPL_SYMBOL, orderId: resting.id });
      Object.assign(perplResult, { cancelStatus: cancelled.status, cancelTx: cancelled.txHash });
      show('perpl cancelled', { id: cancelled.id, status: cancelled.status, tx: cancelled.txHash });

      await perpl.setLeverage({ symbol: PERPL_SYMBOL, leverage: 5 });
      const opened = await perpl.placeMarket({
        symbol: PERPL_SYMBOL,
        side: 'buy',
        size: '0.001',
        maxSlippage: '0.005',
      });
      Object.assign(perplResult, {
        openOrderId: opened.id,
        openStatus: opened.status,
        openFilled: opened.filledSize,
        openAvg: opened.averageFillPrice,
        openTx: opened.txHash,
      });
      show('perpl opened', {
        id: opened.id,
        status: opened.status,
        filled: opened.filledSize,
        tx: opened.txHash,
      });
      let [position] = await perpl.getPositions(PERPL_SYMBOL);
      for (let i = 0; !position && i < 20; i++) {
        await sleep(500);
        [position] = await perpl.getPositions(PERPL_SYMBOL);
      }
      if (!position) throw new Error('filled, but no position arrived on the socket');
      show('perpl position', {
        size: position.size,
        entry: position.entryPrice,
        leverage: position.leverage,
      });
      const closed = await perpl.closePosition({ symbol: PERPL_SYMBOL });
      Object.assign(perplResult, {
        closeOrderId: closed.id,
        closeStatus: closed.status,
        closeFilled: closed.filledSize,
        closeAvg: closed.averageFillPrice,
        closeTx: closed.txHash,
      });
      show('perpl closed', {
        id: closed.id,
        status: closed.status,
        filled: closed.filledSize,
        tx: closed.txHash,
      });
      let remaining = await perpl.getPositions(PERPL_SYMBOL);
      for (let i = 0; remaining.length > 0 && i < 20; i++) {
        await sleep(500);
        remaining = await perpl.getPositions(PERPL_SYMBOL);
      }
      perplResult['positionsAfter'] = remaining.length;
      show('perpl balances after', await perpl.getBalances());
    } finally {
      venues.release(agent.agentId); // closes the socket, as a revoke would
    }
  });

  const monAfter = await pub.getBalance({ address });
  results['monAfter'] = formatEther(monAfter);
  results['monSpent'] = formatEther(mon - monAfter);
  results['failures'] = failures;
  show('agent MON spent', formatEther(mon - monAfter));
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(results, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
  }
  console.log(failures.length === 0 ? '\nALL STEPS PASSED' : `\n${failures.length} STEP(S) FAILED`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
