// Live probe (SEN-211): can an AGENT's Privy server wallet send through Privy
// gas sponsorship (`eth_sendTransaction` with `sponsor: true`) instead of
// signing and broadcasting itself — and does its mandate policy still bind?
//
//   pnpm --filter @sente/api run probe:agent-sponsor [-- --env-file <path>] [-- --out <file.json>]
//
// Every run provisions a NEW throwaway agent wallet through the provider the
// API uses (`PrivyAgentWalletProvider.provision`: the mandate policy, the
// mandate quorum as owner, the agent key as the only signer), under a real
// `compileMandate` policy (Kuru Set C, cbBTC-USDC, deposits <= 5 USDC). The
// wallet holds 0 MON and 0 USDC, on purpose: an ERC-20 `approve` needs no
// balance, so nothing is funded and nothing of value moves.
//
// The checks, in order:
//   a)  a sponsored, ALLOWED `approve(AccountCore, 1 USDC)`. It is also the
//       wallet's first sponsored send, so it EIP-7702-delegates it. Tried
//       against a ladder of policies, stopping at the first that lands:
//         a0  the policy exactly as compiled (every rule `eth_signTransaction`)
//         a1  + an `eth_sendTransaction` twin of every transaction rule
//         a2  + an `eth_sign7702Authorization` rule pinning the delegate
//   b)  sponsored sends the mandate must REFUSE: over the cap, the wrong
//       spender, a contract the mandate never names, and a MON value.
//   c)  a second allowed send at once, one ~4 s after the first, and one at
//       once after that (the wallet is delegated by then).
//   d)  `eth_signTransaction` from the delegated wallet — the fallback path.
//
// Secrets are never printed: ids, addresses and hashes only. Privy bodies are
// recorded with long base64 runs redacted.

import { existsSync, writeFileSync } from 'node:fs';

import { compileMandate, parseMandate, type PolicyRule } from '@sente/mandate';
import {
  KURU_DEPLOYMENT,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddressEqual,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionSerializedEIP1559,
} from 'viem';
import { monadTestnet } from 'viem/chains';

import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { getAgentWallet, privyTransaction } from '../src/agents/privy/agent-wallet.ts';
import { PrivyAgentWalletProvider } from '../src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';
import {
  AgentTransactionSender,
  agentChainClient,
  agentUserOperationClient,
} from '../src/agents/venues/agent-transactions.ts';
import { awaitUserOperation } from '../src/wallet/confirmation/user-operation-logs.ts';
import {
  readSendResponse,
  SEND_CAIP2,
  SEND_CHAIN_ID,
  walletRpcPath,
} from '../src/wallet/send/sponsored-send.ts';
import { envFileFromArgs } from './env-file.ts';

const USDC = getAddress(KURU_TESTNET_TOKENS.USDC.address);
const ACCOUNT_CORE = getAddress(KURU_TESTNET_CONTRACTS.accountCore);
const CAP = 5_000_000n; // 5 USDC per deposit/approve
const ALLOWED = 1_000_000n; // 1 USDC
/** The EIP-7702 delegate Privy installed on every wallet it sponsored so far (SEN-39, SEN-42). */
const KERNEL_DELEGATE = getAddress('0xd6cedde84be40893d153be9d467cd6ad37875b28');
const CONFIRM_TIMEOUT_MS = 45_000;
/** Privy applies a policy PATCH asynchronously (SEN-3 run 5). */
const PATCH_SETTLE_MS = 5_000;
/** `WALLET_SEND_SPACING_MS`, the user path's floor between sponsored sends. */
const SPACING_MS = 4_000;

interface CheckResult {
  id: string;
  title: string;
  outcome: string;
  pass: boolean | undefined;
}
const results: CheckResult[] = [];
const shapes: Record<string, unknown> = {};

function report(id: string, title: string, outcome: string, pass?: boolean): void {
  results.push({ id, title, outcome, pass });
  const badge = pass === undefined ? 'NOTE' : pass ? 'PASS' : 'FAIL';
  console.log(`${badge}  ${id.padEnd(4)} ${title}`);
  console.log(`        ${outcome}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, inner: unknown) =>
      typeof inner === 'bigint'
        ? inner.toString()
        : typeof inner === 'string'
          ? inner.replace(/[A-Za-z0-9+/=]{200,}/g, '[redacted]')
          : inner,
    ),
  ) as unknown;
}

function writeReport(): void {
  const index = process.argv.indexOf('--out');
  const out = index >= 0 ? process.argv[index + 1] : undefined;
  if (!out) return;
  writeFileSync(
    out,
    `${JSON.stringify(redact({ ranAt: new Date().toISOString(), results, shapes }), null, 2)}\n`,
  );
  console.log(`report written to ${out}`);
}

const approveData = (spender: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

/** The delegation itself, pinned to the one delegate Privy has used. */
function delegationRule(): PolicyRule {
  return {
    name: 'EIP-7702: delegate to Kernel',
    method: 'eth_sign7702Authorization',
    action: 'ALLOW',
    conditions: [
      {
        field_source: 'ethereum_7702_authorization',
        field: 'contract',
        operator: 'eq',
        value: KERNEL_DELEGATE,
      },
    ],
  } as unknown as PolicyRule;
}

type SendAttempt =
  | { ok: true; ms: number; at: number; fromBlock: bigint; userOpHash?: Hash; response: unknown }
  | { ok: false; ms: number; at: number; status: number; code?: string; error: string };

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (KURU_DEPLOYMENT.id !== 'set-c') {
    console.log(`KURU_DEPLOYMENT is ${KURU_DEPLOYMENT.id}; this probe compiles Set C`);
    return 1;
  }
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
    ...(privy.agentQuorumId ? { agentQuorumId: privy.agentQuorumId } : {}),
    ...(privy.mandateQuorumId ? { mandateQuorumId: privy.mandateQuorumId } : {}),
  });
  if (!privy.agentQuorumId || !privy.mandateQuorumId) {
    console.log('PRIVY_AGENT_QUORUM_ID / PRIVY_MANDATE_QUORUM_ID must be pinned');
    return 1;
  }
  const rpcUrl = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const rpc = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const returnTo = getAddress('0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8'); // the treasury

  // ---- 0. a throwaway agent wallet under a real mandate -------------------
  const market = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'cbBTC-USDC');
  if (!market) throw new Error('cbBTC-USDC is not a Set C market');
  const mandate = parseMandate({
    version: 1,
    chainId: SEND_CHAIN_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    venues: ['kuru'],
    kuru: {
      markets: [market.address.toLowerCase()],
      maxDepositAtoms: { [USDC.toLowerCase()]: CAP.toString() },
    },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '50',
    returnTo,
  });
  const compiled = compileMandate(mandate);
  const displayName = `sen211-probe-${Date.now().toString(36)}`;
  const wallet = await provider.provision({ rules: compiled, displayName });
  const walletId = wallet.walletId;
  const address = wallet.address;
  shapes.wallet = { walletId, address, policyId: wallet.policyId, rules: compiled.length };
  const [mon, codeBefore] = await Promise.all([
    rpc.getBalance({ address }),
    rpc.getCode({ address }),
  ]);
  report(
    '0',
    'throwaway agent wallet through PrivyAgentWalletProvider.provision',
    `${walletId} at ${address}, policy ${wallet.policyId} (${compiled.length} rules), ` +
      `MON ${mon}, code ${codeBefore ?? '0x'}`,
    mon === 0n,
  );

  // ---- the sponsored send, the way the agent key would ask for it ---------
  const send = async (transaction: Record<string, unknown>): Promise<SendAttempt> => {
    const body = {
      method: 'eth_sendTransaction',
      caip2: SEND_CAIP2,
      sponsor: true,
      params: { transaction: { ...transaction, chain_id: SEND_CHAIN_ID } },
    };
    // The confirm reads logs from here: a fixed lookback from the head misses
    // an operation confirmed long after it landed (run 3).
    const fromBlock = await rpc.getBlockNumber();
    const started = Date.now();
    try {
      const response = await client.post<unknown>(walletRpcPath(walletId), body, {
        approvals: [privy.agentAuthKey],
      });
      const at = Date.now();
      const { userOpHash } = readSendResponse(response);
      return {
        ok: true,
        ms: at - started,
        at,
        fromBlock,
        ...(userOpHash ? { userOpHash } : {}),
        response: redact(response),
      };
    } catch (error) {
      const at = Date.now();
      if (error instanceof PrivyError) {
        const message = (error.body as { error?: unknown } | null)?.error;
        return {
          ok: false,
          ms: at - started,
          at,
          status: error.status,
          ...(error.code ? { code: error.code } : {}),
          error: typeof message === 'string' ? message : JSON.stringify(redact(error.body)),
        };
      }
      throw error;
    }
  };
  const describe = (attempt: SendAttempt): string =>
    attempt.ok
      ? `accepted in ${attempt.ms} ms, userOp ${attempt.userOpHash ?? 'none'}`
      : `HTTP ${attempt.status} ${attempt.code ?? ''} "${attempt.error}" (${attempt.ms} ms)`;
  const allowed = () => ({ to: USDC, data: approveData(ACCOUNT_CORE, ALLOWED), value: '0x0' });
  const confirm = async (hash: Hash, fromBlock: bigint) =>
    awaitUserOperation(rpc, hash, { timeoutMs: CONFIRM_TIMEOUT_MS, fromBlock });

  // ---- a. the allowed send, against a ladder of policies -------------------
  const ladder: { id: string; title: string; rules: () => PolicyRule[] }[] = [
    {
      id: 'a0',
      title: 'the policy as compiled (eth_signTransaction rules only)',
      rules: () => compiled,
    },
    {
      id: 'a1',
      title: 'compiled with sponsoredSends (an eth_sendTransaction twin of every rule)',
      rules: () => compileMandate(mandate, { sponsoredSends: true }),
    },
    {
      id: 'a2',
      title: '+ an eth_sign7702Authorization rule pinning the Kernel delegate',
      rules: () => [...compileMandate(mandate, { sponsoredSends: true }), delegationRule()],
    },
  ];
  let first: Extract<SendAttempt, { ok: true }> | undefined;
  let landedUnder: string | undefined;
  let activeRules: PolicyRule[] = compiled;
  for (const step of ladder) {
    if (step.id !== 'a0') {
      activeRules = step.rules();
      await provider.updatePolicy(wallet.policyId, activeRules);
      await sleep(PATCH_SETTLE_MS);
    }
    const attempt = await send(allowed());
    shapes[step.id] = attempt;
    report(
      step.id,
      `sponsored approve(AccountCore, 1 USDC) — ${step.title}`,
      describe(attempt),
      undefined,
    );
    if (attempt.ok) {
      first = attempt;
      landedUnder = step.id;
      break;
    }
  }
  if (!first?.userOpHash) {
    report('a', 'an allowed sponsored send from an agent wallet', 'never accepted', false);
    return summarise();
  }

  // c0 FIRST: "immediately" must mean immediately, before the confirm below.
  const c0 = await send(allowed());
  shapes.c0 = c0;
  report(
    'c0',
    `a second allowed send ${c0.at - first.at - c0.ms} ms after the delegating one was accepted`,
    describe(c0),
    undefined,
  );

  const a = await confirm(first.userOpHash, first.fromBlock);
  shapes.aReceipt = a.outcome;
  const codeAfter = (await rpc.getCode({ address })) ?? '0x';
  report(
    'a',
    `the allowed send's USER OPERATION receipt (landed under ${landedUnder})`,
    a.outcome
      ? `success=${a.outcome.success} tx=${a.outcome.transactionHash} block=${a.outcome.blockNumber} ` +
          `paymaster=${a.outcome.paymaster} gasCost=${a.outcome.actualGasCost} ` +
          `request ${first.ms} ms + confirm ${a.elapsedMs} ms; code now ${codeAfter}`
      : `no UserOperationEvent within ${CONFIRM_TIMEOUT_MS} ms`,
    a.outcome?.success === true,
  );
  const allowance = await rpc.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address, ACCOUNT_CORE],
  });
  report('a+', 'USDC allowance to AccountCore on chain', `${allowance}`, allowance === ALLOWED);

  // ---- b. what the mandate must refuse, on the sponsored path -------------
  const refusals: { id: string; title: string; tx: Record<string, unknown> }[] = [
    {
      id: 'b1',
      title: 'approve(AccountCore, cap + 1) — over the cap',
      tx: { to: USDC, data: approveData(ACCOUNT_CORE, CAP + 1n), value: '0x0' },
    },
    {
      id: 'b2',
      title: 'approve(Perpl Exchange, 1 USDC) — a spender the mandate never names',
      tx: { to: USDC, data: approveData(PERPL_TESTNET_CONTRACTS.exchange, ALLOWED), value: '0x0' },
    },
    {
      id: 'b3',
      title: 'approve on AUSD — a contract the mandate never names',
      tx: {
        to: getAddress(PERPL_TESTNET_CONTRACTS.collateral),
        data: approveData(ACCOUNT_CORE, ALLOWED),
        value: '0x0',
      },
    },
    {
      id: 'b4',
      title: 'USDC transfer to a stranger — a recovery rule pins the recipient',
      tx: {
        to: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          // ZERO: Privy estimates gas BEFORE it evaluates the policy, and the
          // wallet holds no USDC, so a 1-atom transfer is refused by the
          // simulation and proves nothing about the policy (run 1).
          args: [getAddress('0x000000000000000000000000000000000000dEaD'), 0n],
        }),
        value: '0x0',
      },
    },
  ];
  for (const refusal of refusals) {
    await sleep(SPACING_MS);
    const attempt = await send(refusal.tx);
    shapes[refusal.id] = attempt;
    report(
      refusal.id,
      `REFUSED? ${refusal.title}`,
      describe(attempt),
      !attempt.ok && attempt.status === 400 && attempt.code === 'policy_violation',
    );
  }

  // ---- f. the value pin with no `value` key ----------------------------
  // Every rule pins `value lte 0x0`; the user path omits `value` when it is
  // zero. Does Privy treat an absent value as zero?
  await sleep(SPACING_MS);
  const f = await send({ to: USDC, data: approveData(ACCOUNT_CORE, ALLOWED) });
  shapes.f = f;
  report('f', 'an allowed approve with NO `value` key', describe(f), undefined);

  // ---- c. spaced and back-to-back from the delegated wallet ---------------
  await sleep(SPACING_MS);
  const c1 = await send(allowed());
  const c2 = await send(allowed());
  shapes.c1 = c1;
  shapes.c2 = c2;
  report('c1', `an allowed send ~${SPACING_MS} ms after the last request`, describe(c1), c1.ok);
  report(
    'c2',
    `an allowed send ${c2.at - c2.ms - c1.at} ms after c1 was accepted`,
    describe(c2),
    undefined,
  );
  for (const [id, attempt] of [
    ['c0r', c0],
    ['fr', f],
    ['c1r', c1],
    ['c2r', c2],
  ] as const) {
    if (!attempt.ok || !attempt.userOpHash) continue;
    const { outcome, elapsedMs } = await confirm(attempt.userOpHash, attempt.fromBlock);
    report(
      id,
      `${id.slice(0, -1)}'s USER OPERATION receipt`,
      outcome
        ? `success=${outcome.success} tx=${outcome.transactionHash} block=${outcome.blockNumber} after ${elapsedMs} ms`
        : `no UserOperationEvent within ${CONFIRM_TIMEOUT_MS} ms`,
      outcome?.success === true,
    );
  }

  // ---- g. the product path: AgentTransactionSender, sponsored -------------
  // What the API runs with AGENT_SPONSORED_SENDS=1: the sender sends, follows
  // the user operation, and cuts its own logs out of the bundle's receipt.
  await sleep(SPACING_MS);
  const sender = new AgentTransactionSender({
    wallets: provider,
    chain: agentChainClient(rpc as unknown as PublicClient),
    sponsored: agentUserOperationClient(rpc as unknown as PublicClient),
  });
  try {
    const started = Date.now();
    const [receipt] = await sender.sendAll({ walletId, address }, [
      { to: USDC, data: approveData(ACCOUNT_CORE, 2n * ALLOWED), gas: 80_000n },
    ]);
    const approvals = (receipt?.logs ?? []).filter((log) => isAddressEqual(log.address, USDC));
    shapes.g = receipt;
    report(
      'g',
      'AgentTransactionSender in sponsored mode: approve(AccountCore, 2 USDC)',
      receipt
        ? `success=${receipt.success} userOp=${receipt.userOpHash ?? 'none'} tx=${receipt.transactionHash} ` +
            `block=${receipt.blockNumber}, ${receipt.logs.length} log(s) of its own ` +
            `(${approvals.length} USDC Approval), ${Date.now() - started} ms end to end`
        : 'no receipt',
      receipt?.success === true &&
        receipt.userOpHash !== undefined &&
        receipt.logs.length === 1 &&
        approvals.length === 1,
    );
  } catch (error) {
    report(
      'g',
      'AgentTransactionSender in sponsored mode',
      `failed: ${(error as Error).message}`,
      false,
    );
  }

  // ---- d. the sign path, after delegation ---------------------------------
  const [nonce, fees] = await Promise.all([
    rpc.getTransactionCount({ address, blockTag: 'pending' }),
    rpc.estimateFeesPerGas(),
  ]);
  try {
    const signed = await provider.signTransaction(
      walletId,
      privyTransaction({
        to: USDC,
        data: approveData(ACCOUNT_CORE, ALLOWED),
        chainId: SEND_CHAIN_ID,
        nonce,
        gas: 60_000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      }),
    );
    const signer = await recoverTransactionAddress({
      serializedTransaction: signed as TransactionSerializedEIP1559,
    });
    report(
      'd',
      'eth_signTransaction from the DELEGATED wallet (not broadcast: it holds 0 MON)',
      `signed at nonce ${nonce}; recovers ${signer} (${isAddressEqual(signer, address) ? 'the wallet' : 'NOT the wallet'})`,
      isAddressEqual(signer, address),
    );
  } catch (error) {
    report(
      'd',
      'eth_signTransaction from the DELEGATED wallet',
      `failed: ${(error as Error).message}`,
      false,
    );
  }

  const after = await getAgentWallet(client, walletId);
  report(
    'e',
    'address after delegation',
    `${address} → ${after.address}; code ${codeBefore ?? '0x'} → ${(await rpc.getCode({ address })) ?? '0x'}`,
    isAddressEqual(getAddress(after.address), address),
  );
  shapes.finalRules = activeRules.map((rule) => `${rule.method}: ${rule.name}`);
  return summarise();
}

function summarise(): number {
  const failed = results.filter((result) => result.pass === false);
  console.log(`\n${results.length} checks; ${failed.length} failed`);
  for (const failure of failed) console.log(`  FAIL ${failure.id} ${failure.title}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    writeReport();
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`probe aborted: ${(error as Error).message}`);
    writeReport();
    process.exitCode = 1;
  },
);
