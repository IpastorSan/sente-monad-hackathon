// Live check (SEN-15): the probe agent takes its Kuru collateral back and
// returns it to its owner, under recipient-pinned rules. Monad testnet (10143).
//
//   pnpm --filter @sente/api run agent:withdraw-live [-- --env-file <path>] [-- --out <file.json>]
//        [-- --return-to 0x…]   # default: the dev treasury, standing in for the owner
//
// In order, with every hash printed:
//   1. Re-arms the SEN-6 probe wallet (PRIVY_AGENT_VENUES_*) with the owner key:
//      Kuru MON-USDC, deposits ≤ 1 USDC, 24 h, and `returnTo` = the treasury.
//      The treasury stands in for the owner's smart account: this wallet was
//      funded from it, and there is no smart-account owner on this agent.
//   2. Probes until the new policy answers twice in a row (PATCH lag, SEN-3/9).
//   3. Sign-only probes, NEVER broadcast (nonce a million ahead): withdraw to
//      itself signs; withdrawFromAccount / transferBetweenAccounts, which name
//      another account, are refused; a USDC transfer to the treasury signs and
//      one to anyone else is refused.
//   4. The real withdraw of every free USDC (the ABI, proven by a receipt), then
//      the real transfer of the wallet's USDC to the treasury.
//   5. PATCHes an EXPIRED mandate and probes again: approve is refused, the two
//      recovery rules still sign. The policy is LEFT in that recovery-only state.
//
// Stops before any PATCH if the agent lacks the gas, printing the `agent:fund`
// command. Secrets are never printed; ids, addresses and hashes are.

import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { compileMandate, parseMandate, readBackCaps } from '@sente/mandate';
import {
  erc20TransferCall,
  fromUnits,
  KURU_MEASURED_GAS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  withdrawCall,
  type KuruCall,
} from '@sente/venues/kuru';
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { monadTestnet } from 'viem/chains';

import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { EnclaveRefusedError } from '../src/agents/agents.errors.ts';
import { getAgentWallet, privyTransaction } from '../src/agents/privy/agent-wallet.ts';
import { PrivyAgentWalletProvider } from '../src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient } from '../src/agents/privy/privy.client.ts';
import { InMemoryAgentSecretStore } from '../src/agents/venues/agent-secret-store.ts';
import {
  AgentTransactionSender,
  agentChainClient,
  type AgentIdentity,
} from '../src/agents/venues/agent-transactions.ts';
import { AgentVenues } from '../src/agents/venues/agent-venues.ts';
import { envFileFromArgs } from './env-file.ts';

/** The dev treasury that funded the probe agent (docs/agents.md). */
const TREASURY: Address = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8';
/** Anyone else: a transfer here must be refused. */
const STRANGER: Address = '0x000000000000000000000000000000000000dEaD';
const USDC = KURU_TESTNET_TOKENS.USDC;
const WETH = KURU_TESTNET_TOKENS.WETH;
const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const DAY = 86_400;
/** A probe nonce this far ahead can never be mined, even if the signature leaked. */
const PROBE_NONCE_OFFSET = 1_000_000;
const SETTLE = { pollMs: 500, timeoutMs: 30_000, consecutive: 2 };

/** AccountCore's other balance moves, as its ABI spells them: each names another account. */
const ACCOUNT_CORE_OTHERS = parseAbi([
  'function withdrawFromAccount(address account, address token, uint256 amount)',
  'function transferBetweenAccounts(address fromAccount, address toAccount, address token, uint256 amount)',
  'event Withdrawal(uint40 indexed accountId, address indexed token, address indexed recipient, uint256 amount)',
]);

const results: Record<string, unknown> = {};
const failures: string[] = [];
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const show = (label: string, value: unknown) =>
  console.log(`${label.padEnd(30)} ${typeof value === 'string' ? value : json(value)}`);
const expect = (name: string, pass: boolean, evidence: string) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
  if (!pass) failures.push(`${name}: ${evidence}`);
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function mandateInput(expiresAt: number, returnTo: Address) {
  return {
    version: 1,
    chainId: 10143,
    expiresAt,
    venues: ['kuru'],
    kuru: { markets: [MON_USDC.address], maxDepositAtoms: { [USDC.address]: '1000000' } },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '5',
    returnTo,
  };
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const out = arg('--out');
  const returnToArg = arg('--return-to');
  if (returnToArg !== undefined && !isAddress(returnToArg))
    throw new Error('--return-to: bad address');
  const returnTo = getAddress(returnToArg ?? TREASURY);

  const config = loadAgentsConfig(process.env);
  const walletId = process.env['PRIVY_AGENT_VENUES_WALLET_ID']?.trim();
  const policyId = process.env['PRIVY_AGENT_VENUES_POLICY_ID']?.trim();
  if (!config.privy || !walletId || !policyId) {
    console.log('pending credentials: PRIVY_* or PRIVY_AGENT_VENUES_* is not configured');
    return 1;
  }
  const privy = config.privy;
  const client = new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret });
  const provider = new PrivyAgentWalletProvider({
    client,
    agentKey: privy.agentAuthKey,
    mandateOwnerKey: privy.mandateOwnerKey,
    agentQuorumId: privy.agentQuorumId,
    mandateQuorumId: privy.mandateQuorumId,
  });
  const rpc = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) }) as PublicClient;
  const chain = agentChainClient(pub);
  const address = getAddress((await getAgentWallet(client, walletId)).address);
  const agent: AgentIdentity = { agentId: 'sente-agent-withdraw-live', walletId, address };
  const sender = new AgentTransactionSender({ wallets: provider, chain });
  const venues = new AgentVenues({
    publicClient: pub,
    sender,
    secrets: new InMemoryAgentSecretStore(),
  });
  Object.assign(results, { walletId, policyId, address, returnTo });
  show('agent', `${walletId} ${address}, policy ${policyId}`);
  show('return address (owner stand-in)', returnTo);

  // --- Balances and the gas gate ---------------------------------------------
  const balances = async () => {
    const [mon, usdc, free, nonce] = await Promise.all([
      pub.getBalance({ address }),
      pub.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
      venues.forAgent(agent).then(async ({ kuru }) => {
        const b = (await kuru.getBalances()).find((x) => x.asset === 'USDC');
        return { available: b?.available ?? '0', locked: b?.locked ?? '0' };
      }),
      pub.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return { mon, usdc, kuru: free, nonce };
  };
  const before = await balances();
  const kuruAtoms = BigInt(Math.round(Number(before.kuru.available) * 10 ** USDC.decimals));
  const fees = await chain.fees();
  const gas =
    (kuruAtoms > 0n ? KURU_MEASURED_GAS.withdraw : 0n) +
    (kuruAtoms + before.usdc > 0n ? KURU_MEASURED_GAS.erc20Transfer : 0n);
  const needMon = gas * fees.maxFeePerGas;
  show('before', {
    MON: formatEther(before.mon),
    walletUSDC: formatUnits(before.usdc, USDC.decimals),
    kuruUSDC: before.kuru,
    nonce: before.nonce,
  });
  show(
    'gas budget',
    `${gas} gas at ${formatUnits(fees.maxFeePerGas, 9)} gwei = ${formatEther(needMon)} MON`,
  );
  results['before'] = { ...before, mon: formatEther(before.mon) };
  if (before.mon < needMon) {
    console.log(
      '\nThe agent is short of gas. Fund it, then rerun:\n' +
        `  pnpm --filter @sente/api run agent:fund -- --to ${address} --mon ${formatEther(needMon - before.mon)}`,
    );
    return 2;
  }

  // --- Sign-only probes -----------------------------------------------------------
  const probe = async (call: KuruCall): Promise<'signed' | 'refused'> => {
    const [nonce, f] = await Promise.all([chain.pendingNonce(address), chain.fees()]);
    const tx = privyTransaction({
      to: call.to,
      data: call.data ?? '0x',
      chainId: 10143,
      nonce: nonce + PROBE_NONCE_OFFSET,
      gas: 200_000n,
      ...f,
    });
    try {
      await provider.signTransaction(walletId, tx);
      return 'signed';
    } catch (error) {
      if (error instanceof EnclaveRefusedError) return 'refused';
      throw error;
    }
  };
  const settle = async (label: string, want: () => Promise<boolean>) => {
    const start = Date.now();
    let streak = 0;
    let probes = 0;
    for (;;) {
      probes += 1;
      streak = (await want()) ? streak + 1 : 0;
      if (streak >= SETTLE.consecutive) return { ok: true, afterMs: Date.now() - start, probes };
      if (Date.now() - start > SETTLE.timeoutMs) {
        return { ok: false, afterMs: Date.now() - start, probes, label };
      }
      await sleep(SETTLE.pollMs);
    }
  };

  const approve = (usdc: bigint): KuruCall => ({
    to: USDC.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [ACCOUNT_CORE, usdc],
    }),
  });
  const withdrawOwn = withdrawCall(ACCOUNT_CORE, USDC, 14_000_000n);
  const probes: Record<string, { call: KuruCall; want: 'signed' | 'refused' }> = {
    'withdraw 14 USDC to itself': { call: withdrawOwn, want: 'signed' },
    'withdrawFromAccount(treasury, …)': {
      call: {
        to: ACCOUNT_CORE,
        data: encodeFunctionData({
          abi: ACCOUNT_CORE_OTHERS,
          functionName: 'withdrawFromAccount',
          args: [returnTo, USDC.address, 1_000_000n],
        }),
      },
      want: 'refused',
    },
    'withdrawFromAccount(itself, …)': {
      call: {
        to: ACCOUNT_CORE,
        data: encodeFunctionData({
          abi: ACCOUNT_CORE_OTHERS,
          functionName: 'withdrawFromAccount',
          args: [address, USDC.address, 1_000_000n],
        }),
      },
      want: 'refused',
    },
    'transferBetweenAccounts(itself → stranger)': {
      call: {
        to: ACCOUNT_CORE,
        data: encodeFunctionData({
          abi: ACCOUNT_CORE_OTHERS,
          functionName: 'transferBetweenAccounts',
          args: [address, STRANGER, USDC.address, 1_000_000n],
        }),
      },
      want: 'refused',
    },
    'USDC transfer 14 to the owner': {
      call: erc20TransferCall(USDC.address, returnTo, 14_000_000n),
      want: 'signed',
    },
    'WETH transfer 1 to the owner': {
      call: erc20TransferCall(WETH.address, returnTo, 10n ** 18n),
      want: 'signed',
    },
    'USDC transfer 14 to a stranger': {
      call: erc20TransferCall(USDC.address, STRANGER, 14_000_000n),
      want: 'refused',
    },
    'USDC transfer 14 to the agent itself': {
      call: erc20TransferCall(USDC.address, address, 14_000_000n),
      want: 'refused',
    },
    'approve 1 USDC to AccountCore (in cap)': { call: approve(1_000_000n), want: 'signed' },
    'approve 2 USDC to AccountCore (over cap)': { call: approve(2_000_000n), want: 'refused' },
  };
  const runProbes = async (phase: string, which: Record<string, 'signed' | 'refused'>) => {
    const got: Record<string, string> = {};
    for (const [name, want] of Object.entries(which)) {
      const answer = await probe(probes[name]!.call);
      got[name] = answer;
      expect(
        `${phase}: ${name}`,
        answer === want,
        `${answer} (want ${want}); sign-only, never broadcast`,
      );
    }
    return got;
  };

  // --- 1–3. Arm the recovery rules under a live mandate, and probe ----------------
  const live = compileMandate(
    parseMandate(mandateInput(Math.floor(Date.now() / 1000) + DAY, returnTo)),
  );
  const caps = readBackCaps(live);
  show(
    'compiled',
    `${live.length} rules; kuruWithdraw ${caps.kuruWithdraw}; returnTo ${caps.returnTo}`,
  );
  results['liveRules'] = live;
  const patchStart = Date.now();
  await provider.updatePolicy(policyId, live);
  const patchMs = Date.now() - patchStart;
  const armed = await settle(
    'live mandate',
    async () =>
      (await probe(withdrawOwn)) === 'signed' &&
      (await probe(probes['USDC transfer 14 to a stranger']!.call)) === 'refused',
  );
  results['armed'] = { patchMs, ...armed };
  expect(
    'the live mandate reached the enclave',
    armed.ok,
    `PATCH ${patchMs} ms, then ${json(armed)}`,
  );
  if (!armed.ok) return 1;
  results['probesLive'] = await runProbes(
    'live',
    Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.want])),
  );

  // --- 4. The real withdraw, then the real return -----------------------------------
  const receiptOf = async (hash: Hex) => {
    const r = await pub.getTransactionReceipt({ hash });
    return {
      hash,
      status: r.status,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
      logs: r.logs,
    };
  };
  const events = (logs: readonly { address: Address; data: Hex; topics: Hex[] }[]) =>
    logs.flatMap((log) => {
      for (const abi of [ACCOUNT_CORE_OTHERS, erc20Abi] as const) {
        try {
          const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          return [
            { address: log.address, event: d.eventName, args: d.args as Record<string, unknown> },
          ];
        } catch {
          /* next */
        }
      }
      return [];
    });

  if (kuruAtoms > 0n) {
    const { kuru } = await venues.forAgent(agent);
    const amount = fromUnits(kuruAtoms, USDC.decimals);
    const execution = await kuru.withdraw('USDC', amount);
    const receipt = await receiptOf(execution.transactionHash);
    const decoded = events(receipt.logs);
    const withdrawal = decoded.find((e) => e.event === 'Withdrawal');
    const transfer = decoded.find((e) => e.event === 'Transfer');
    results['withdraw'] = { amount, ...receipt, logs: decoded };
    show(
      'withdraw',
      `${amount} USDC ${execution.transactionHash} ${receipt.status} gasUsed ${receipt.gasUsed}`,
    );
    expect('the withdraw landed', receipt.status === 'success', receipt.status);
    expect(
      'AccountCore paid the agent itself',
      !!withdrawal &&
        isAddressEqual(withdrawal.args['recipient'] as Address, address) &&
        !!transfer &&
        isAddressEqual(transfer.args['to'] as Address, address),
      `Withdrawal.recipient ${String(withdrawal?.args['recipient'])}, Transfer.to ${String(transfer?.args['to'])}`,
    );
  } else {
    show('withdraw', 'skipped: no free USDC in Kuru (a rerun after a withdraw)');
  }

  const walletUsdc = await pub.readContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  if (walletUsdc > 0n) {
    const call = erc20TransferCall(USDC.address, returnTo, walletUsdc);
    const estimate = await pub.estimateGas({ account: address, to: call.to, data: call.data });
    show('transfer gas', `estimated ${estimate}, fixed limit ${KURU_MEASURED_GAS.erc20Transfer}`);
    results['transferEstimate'] = estimate;
    if (estimate > KURU_MEASURED_GAS.erc20Transfer) {
      expect('the fixed transfer limit covers the estimate', false, `${estimate} > limit`);
      return 1;
    }
    const [landed] = await sender.sendAll(agent, [
      { ...call, gas: KURU_MEASURED_GAS.erc20Transfer },
    ]);
    const receipt = await receiptOf(landed!.transactionHash);
    const transfer = events(receipt.logs).find((e) => e.event === 'Transfer');
    results['returnTransfer'] = { amount: walletUsdc, ...receipt, logs: events(receipt.logs) };
    show(
      'return transfer',
      `${formatUnits(walletUsdc, USDC.decimals)} USDC ${landed!.transactionHash} ${receipt.status} gasUsed ${receipt.gasUsed}`,
    );
    expect('the return transfer landed', receipt.status === 'success', receipt.status);
    expect(
      'the USDC reached the owner',
      !!transfer && isAddressEqual(transfer.args['to'] as Address, returnTo),
      `Transfer ${String(transfer?.args['from'])} → ${String(transfer?.args['to'])} ${String(transfer?.args['value'])}`,
    );
  } else {
    show('return transfer', 'skipped: the wallet holds no USDC');
  }

  // --- 5. After expiry: the recovery rules survive, nothing else does --------------
  const expired = compileMandate(
    parseMandate(mandateInput(Math.floor(Date.now() / 1000) - 60, returnTo)),
  );
  const expiredStart = Date.now();
  await provider.updatePolicy(policyId, expired);
  const expiredPatchMs = Date.now() - expiredStart;
  const lapsed = await settle(
    'expired mandate',
    async () =>
      (await probe(approve(1_000_000n))) === 'refused' && (await probe(withdrawOwn)) === 'signed',
  );
  results['expired'] = { patchMs: expiredPatchMs, ...lapsed };
  expect(
    'the expired mandate reached the enclave',
    lapsed.ok,
    `PATCH ${expiredPatchMs} ms, then ${json(lapsed)}`,
  );
  if (lapsed.ok) {
    results['probesExpired'] = await runProbes('expired', {
      'withdraw 14 USDC to itself': 'signed',
      'USDC transfer 14 to the owner': 'signed',
      'USDC transfer 14 to a stranger': 'refused',
      'withdrawFromAccount(treasury, …)': 'refused',
      'approve 1 USDC to AccountCore (in cap)': 'refused',
    });
  }

  const after = await balances();
  results['after'] = { ...after, mon: formatEther(after.mon) };
  results['monSpent'] = formatEther(before.mon - after.mon);
  show('after', {
    MON: formatEther(after.mon),
    walletUSDC: formatUnits(after.usdc, USDC.decimals),
    kuruUSDC: after.kuru,
    nonce: after.nonce,
  });
  show('agent MON spent', formatEther(before.mon - after.mon));
  results['failures'] = failures;
  venues.release(agent.agentId);
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
