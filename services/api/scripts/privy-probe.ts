// Live probe (SEN-3): does the compiled mandate policy make Privy's enclave
// sign what it should and refuse what it shouldn't, for Monad testnet (10143)?
//
//   pnpm --filter @sente/api run probe:privy [-- --env-file <path>] [-- --out <file.json>]
//
// Reads the repo-root .env (or --env-file). Needs PRIVY_APP_ID,
// PRIVY_APP_SECRET, and the two keys from `privy:keys`. Without the app
// credentials it prints "pending credentials" and exits 0, touching nothing.
//
// NOTHING IS BROADCAST. Every check stops at a signature. The probe's wallets
// are never funded; nonce, gas and fees are read from Monad RPC only so the
// signed transactions are realistic.
//
// It only CREATES Privy objects, every one named `sente-probe…` (or "Sente
// …" for the owner quorums), and only ever PATCHes a policy it created in this
// run. The Privy app may be shared with other projects; nothing else is read
// or touched. New ids are written back to the env file as PRIVY_PROBE_* —
// Privy's list endpoints answer 405, so that is the only record of them.
//
// Secrets: the app secret and both authorization keys are never printed. What
// is printed is ids, addresses, Privy's own error bodies, and signed
// transactions for unfunded testnet wallets.
//
// Checks (docs/privy-policy-enforcement.md, "Verified live on 10143"):
//   0.  encoding — which forms Privy takes for chain_id eq / current_unix_timestamp lte
//   M.  the compiled mandate is accepted as a policy at all
//   1.  Kuru deposit under the cap           → signed
//   2.  the same deposit over the cap        → refused (policy_violation)
//   3.  OrderBook.batch to an unlisted market → refused (and to a listed one → signed)
//   4.  check 1 with chain_id 1              → refused
//   5.  aggregation (rolling sum) + a rule referencing it: 2nd approve → refused
//       (re-tried after 5 s and 30 s, since Privy updates aggregations after signing)
//   6.  Perpl enrollment typed data          → signed (and a wrong statement → refused)
//   6c–6h. one condition at a time, to find which one decides
//   7.  PATCH the policy with the agent key  → 401; with the owner key → ok
//   7c. the owner lowers the cap → the same deposit is refused (time to take effect)
//   8.  eth_signTransaction latency, p50 over 10

import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  aggregationLte,
  compileMandate,
  compileRollingCap,
  hexUint,
  parseMandate,
  PERPL_ENROLL_TYPED_DATA,
  txChainIdEq,
  txToEq,
  typedDataChainIdEq,
  typedDataMessageEq,
  typedDataVerifyingContractEq,
  unixTimestampLte,
  type PolicyCondition,
  type PolicyRule,
} from '@sente/mandate';
import {
  cancelOrderCall,
  depositCalls,
  KURU_MEASURED_GAS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import { PERPL_API_KEY_TYPED_DATA } from '@sente/venues/perpl';
import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
  type TypedDataDefinition,
} from 'viem';
import { monadTestnet } from 'viem/chains';

import type { ProvisionedAgentWallet } from '../src/agents/agent-wallet.provider.ts';
import { loadAgentsConfig } from '../src/agents/agents.config.ts';
import { EnclaveRefusedError } from '../src/agents/agents.errors.ts';
import {
  getAgentWallet,
  privyTransaction,
  toPrivyTypedData,
  type PrivyTransactionRequest,
} from '../src/agents/privy/agent-wallet.ts';
import { PrivyAgentWalletProvider } from '../src/agents/privy/privy-agent-wallet.provider.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';
import { envFileFromArgs, upsertEnv } from './env-file.ts';

const CHAIN_ID = 10143;
const USDC = KURU_TESTNET_TOKENS.USDC;
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
const WETH_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'WETH-USDC')!;
const usdc = (whole: number): bigint => BigInt(whole) * 10n ** BigInt(USDC.decimals);

/**
 * Privy applies a policy PATCH asynchronously: run 5 signed against the OLD
 * rule immediately after one (0b). Every PATCH-then-sign check waits this long.
 */
const SETTLE_MS = 5_000;

type Expected = 'signed' | 'refused' | 'unauthorized' | 'ok' | 'observe';

interface CheckResult {
  id: string;
  title: string;
  expected: Expected;
  outcome: string;
  pass: boolean;
  detail?: unknown;
}

const results: CheckResult[] = [];
const ids: Record<string, string> = {};
const shapes: Record<string, unknown> = {};

type Outcome =
  | { kind: 'signed' | 'ok'; value: unknown }
  | { kind: 'refused'; detail: string | undefined }
  | { kind: 'unauthorized' | 'error'; status?: number; body?: unknown; message: string };

type TxFor = (
  wallet: Address,
  call: { to: Address; data?: Hex; value?: bigint },
  gas: bigint,
) => Promise<PrivyTransactionRequest>;

type Record_ = (entries: Record<string, string>, overwrite?: boolean) => void;

async function attempt(fn: () => Promise<unknown>, success: 'signed' | 'ok'): Promise<Outcome> {
  try {
    return { kind: success, value: await fn() };
  } catch (error) {
    if (error instanceof EnclaveRefusedError) return { kind: 'refused', detail: error.detail };
    if (error instanceof PrivyError) {
      return {
        kind: error.isMissingApproval ? 'unauthorized' : 'error',
        status: error.status,
        body: error.body,
        message: error.message,
      };
    }
    return { kind: 'error', message: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'signed':
    case 'ok':
      return outcome.kind;
    case 'refused':
      return `refused (policy_violation${outcome.detail ? `: ${outcome.detail}` : ''})`;
    default:
      return `${outcome.kind} ${outcome.status ?? ''} ${JSON.stringify(outcome.body ?? outcome.message)}`;
  }
}

function report(
  id: string,
  title: string,
  expected: Expected,
  outcome: string,
  pass: boolean,
  detail?: unknown,
) {
  results.push({ id, title, expected, outcome, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(3)} ${title}`);
  console.log(
    `        expected ${expected}; got ${outcome}${detail === undefined ? '' : `  ${String(detail)}`}`,
  );
}

async function check(
  id: string,
  title: string,
  expected: Expected,
  fn: () => Promise<unknown>,
  verify?: (value: unknown) => Promise<string | undefined>,
): Promise<Outcome> {
  const outcome = await attempt(fn, expected === 'ok' ? 'ok' : 'signed');
  let text = describe(outcome);
  let pass = expected === 'observe' || outcome.kind === expected;
  if (pass && verify && (outcome.kind === 'signed' || outcome.kind === 'ok')) {
    const problem = await verify(outcome.value);
    if (problem) {
      pass = false;
      text += ` — BUT ${problem}`;
    } else text += ' — verified';
  }
  const detail = outcome.kind === 'signed' ? `${String(outcome.value).slice(0, 26)}…` : undefined;
  report(id, title, expected, text, pass, detail);
  return outcome;
}

/** A signed tx must be for the chain and `to` we asked, and recover to the wallet. */
function verifySignedTx(tx: PrivyTransactionRequest, wallet: Address) {
  return async (value: unknown): Promise<string | undefined> => {
    const signed = value as TransactionSerialized;
    const parsed = parseTransaction(signed);
    if (parsed.chainId !== tx.chain_id) return `signed for chain ${parsed.chainId}`;
    if (!parsed.to || !isAddressEqual(parsed.to, tx.to)) return `signed to ${parsed.to}`;
    const from = await recoverTransactionAddress({ serializedTransaction: signed });
    return isAddressEqual(from, wallet) ? undefined : `recovers to ${from}, not ${wallet}`;
  };
}

/** A typed-data signature must recover to the wallet. */
function verifySignedTyped(typed: TypedDataDefinition, wallet: Address) {
  return async (value: unknown): Promise<string | undefined> => {
    const from = await recoverTypedDataAddress({ ...typed, signature: value as Hex });
    return isAddressEqual(from, wallet) ? undefined : `recovers to ${from}, not ${wallet}`;
  };
}

function compact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      key === 'abi' && Array.isArray(v) ? `[abi: ${v.length} fragment(s)]` : v,
    ),
  );
}

/** A condition spelled by hand, to test forms `@sente/mandate` does not emit. */
function raw(
  field_source: string,
  field: string,
  operator: string,
  value: string,
): PolicyCondition {
  return { field_source, field, operator, value } as unknown as PolicyCondition;
}

/** Perpl's enrollment typed data, as the adapter would build it for `signer`. */
function enrollment(
  signer: Address,
  statement: string = PERPL_API_KEY_TYPED_DATA.statement,
): TypedDataDefinition {
  return {
    domain: PERPL_API_KEY_TYPED_DATA.domain,
    types: PERPL_API_KEY_TYPED_DATA.types,
    primaryType: PERPL_API_KEY_TYPED_DATA.primaryType,
    message: {
      signer,
      statement,
      publicKey: `0x${randomBytes(32).toString('hex')}`,
      scope: '3',
      label: 'sente-probe',
      time: BigInt(Date.now()),
    },
  } as unknown as TypedDataDefinition;
}

function writeReport(): void {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (!out) return;
  const body = { ranAt: new Date().toISOString(), chainId: CHAIN_ID, ids, results, shapes };
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`report written to ${out}`);
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  if (!process.env['PRIVY_APP_ID']?.trim() || !process.env['PRIVY_APP_SECRET']?.trim()) {
    console.log('pending credentials: PRIVY_APP_ID/PRIVY_APP_SECRET not set');
    console.log('Set them in the repo-root .env, then:');
    console.log('  pnpm --filter @sente/api run privy:keys');
    console.log('  pnpm --filter @sente/api run probe:privy');
    return 0;
  }
  let config;
  try {
    config = loadAgentsConfig(process.env);
  } catch (error) {
    // Names variables, never values (agents.config.ts).
    console.log(`pending credentials: ${(error as Error).message}`);
    return 0;
  }
  const privyConfig = config.privy!;

  const client = new PrivyClient({ appId: privyConfig.appId, appSecret: privyConfig.appSecret });
  const record: Record_ = (entries, overwrite = true) => {
    Object.assign(ids, entries);
    upsertEnv(envFile, entries, { overwrite });
  };
  const provider = new PrivyAgentWalletProvider({
    client,
    agentKey: privyConfig.agentAuthKey,
    mandateOwnerKey: privyConfig.mandateOwnerKey,
    agentQuorumId: privyConfig.agentQuorumId,
    mandateQuorumId: privyConfig.mandateQuorumId,
    onQuorumsCreated: (q) => {
      record({
        PRIVY_PROBE_AGENT_QUORUM_ID: q.agentQuorumId,
        PRIVY_PROBE_MANDATE_QUORUM_ID: q.mandateQuorumId,
      });
      // Let the API reuse them instead of registering new quorums on boot.
      record(
        { PRIVY_AGENT_QUORUM_ID: q.agentQuorumId, PRIVY_MANDATE_QUORUM_ID: q.mandateQuorumId },
        false,
      );
    },
  });
  const quorums = await provider.quorums();
  Object.assign(ids, {
    agentQuorumId: quorums.agentQuorumId,
    mandateQuorumId: quorums.mandateQuorumId,
  });

  const rpc = createPublicClient({
    chain: monadTestnet,
    transport: http(process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined),
  });
  const fees = await rpc.estimateFeesPerGas().catch(async () => {
    const gasPrice = await rpc.getGasPrice();
    return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
  });
  console.log(`app ${privyConfig.appId}; env file ${envFile}`);
  console.log(`quorums: agent ${quorums.agentQuorumId}, mandate owner ${quorums.mandateQuorumId}`);
  console.log(
    `monad fees: maxFeePerGas=${fees.maxFeePerGas} maxPriorityFeePerGas=${fees.maxPriorityFeePerGas}`,
  );

  const now = Math.floor(Date.now() / 1000);
  const run = `sente-probe-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

  const txFor: TxFor = async (wallet, call, gas) => {
    const nonce = await rpc.getTransactionCount({ address: wallet, blockTag: 'pending' });
    return privyTransaction({
      to: call.to,
      data: call.data ?? '0x',
      ...(call.value && call.value > 0n ? { value: call.value } : {}),
      chainId: CHAIN_ID,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas!,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
    });
  };

  // ---- 0. encoding, on a wallet of its own ------------------------------------
  // The wallet starts on a rule that is valid whatever the answer (`to` only),
  // then every variant is PATCHed in by the owner key and signed against: a
  // variant Privy will not store shows up as a rejected PATCH, not an abort.
  console.log(
    '\n0. ENCODING — which forms does Privy take for chain_id eq / current_unix_timestamp lte?',
  );
  const target = getAddress(KURU_TESTNET_CONTRACTS.testnetTokenFaucet);
  const encodingRule = (conditions: PolicyCondition[]): PolicyRule => ({
    name: `${run} encoding`,
    method: 'eth_signTransaction',
    action: 'ALLOW',
    conditions: [...conditions, txToEq(target)],
  });
  const future = now + 3600;
  const past = now - 3600;
  const variants: { id: string; title: string; expected: Expected; rule: PolicyRule }[] = [
    {
      id: '0a',
      title: 'chain_id + expiry exactly as @sente/mandate emits them (future)',
      expected: 'signed',
      rule: encodingRule([txChainIdEq(CHAIN_ID), unixTimestampLte(future)]),
    },
    {
      id: '0b',
      title: 'the same with the expiry in the PAST — is the timestamp really compared?',
      expected: 'refused',
      rule: encodingRule([txChainIdEq(CHAIN_ID), unixTimestampLte(past)]),
    },
    {
      id: '0c',
      title: 'chain_id for the WRONG chain (1), as @sente/mandate emits it',
      expected: 'refused',
      rule: encodingRule([txChainIdEq(1), unixTimestampLte(future)]),
    },
    {
      id: '0d',
      title: 'chain_id as HEX "0x279f" (informational)',
      expected: 'observe',
      rule: encodingRule([
        raw('ethereum_transaction', 'chain_id', 'eq', hexUint(CHAIN_ID)),
        unixTimestampLte(future),
      ]),
    },
    {
      id: '0e',
      title: 'chain_id as DECIMAL "10143" (informational)',
      expected: 'observe',
      rule: encodingRule([
        raw('ethereum_transaction', 'chain_id', 'eq', String(CHAIN_ID)),
        unixTimestampLte(future),
      ]),
    },
    {
      id: '0f',
      title: 'expiry as HEX (informational)',
      expected: 'observe',
      rule: encodingRule([
        txChainIdEq(CHAIN_ID),
        raw('system', 'current_unix_timestamp', 'lte', hexUint(future)),
      ]),
    },
    {
      id: '0g',
      title: 'expiry as DECIMAL (informational)',
      expected: 'observe',
      rule: encodingRule([
        txChainIdEq(CHAIN_ID),
        raw('system', 'current_unix_timestamp', 'lte', String(future)),
      ]),
    },
  ];
  shapes['encodingVariants'] = variants.map((v) => ({ id: v.id, conditions: v.rule.conditions }));
  const encoding = await provider.provision({
    rules: [encodingRule([])],
    displayName: `${run}-encoding`,
  });
  record({
    PRIVY_PROBE_ENCODING_WALLET_ID: encoding.walletId,
    PRIVY_PROBE_ENCODING_POLICY_ID: encoding.policyId,
  });
  console.log(
    `encoding wallet ${encoding.walletId} ${encoding.address} policy ${encoding.policyId}`,
  );
  const plainTx = await txFor(encoding.address, { to: target }, 21_000n);
  await check(
    '0',
    'baseline: a `to`-only rule signs at all',
    'signed',
    () => provider.signTransaction(encoding.walletId, plainTx),
    verifySignedTx(plainTx, encoding.address),
  );
  for (const variant of variants) {
    const patched = await attempt(
      () => provider.updatePolicy(encoding.policyId, [variant.rule]),
      'ok',
    );
    if (patched.kind !== 'ok') {
      report(
        variant.id,
        variant.title,
        variant.expected,
        `policy PATCH rejected: ${describe(patched)}`,
        variant.expected === 'observe',
      );
      continue;
    }
    await sleep(SETTLE_MS);
    await check(variant.id, variant.title, variant.expected, () =>
      provider.signTransaction(encoding.walletId, plainTx),
    );
  }

  // ---- the mandate wallet ----------------------------------------------------
  console.log('\nMANDATE WALLET — one Kuru market, 10 USDC deposit cap, Perpl enrollment');
  const mandate = parseMandate({
    version: 1,
    chainId: CHAIN_ID,
    expiresAt: now + 7 * 24 * 3600,
    venues: ['kuru', 'perpl'],
    kuru: { markets: [MON_USDC.address], maxDepositAtoms: { [USDC.address]: String(usdc(10)) } },
    perpl: { maxCollateralAtoms: String(usdc(10)), maxLeverage: 2, markets: ['BTC-PERP'] },
    maxOrderNotional: '10',
    rollingCap: { windowSeconds: 3600, capAtoms: String(usdc(15)), token: USDC.address },
  });
  const rules = compileMandate(mandate);
  shapes['mandateRules'] = compact(rules);
  const provisioned = await attempt(
    () => provider.provision({ rules, displayName: `${run}-mandate` }),
    'ok',
  );
  report(
    'M',
    `compileMandate output (${rules.length} rules) accepted as a Privy policy`,
    'ok',
    describe(provisioned),
    provisioned.kind === 'ok',
  );
  if (provisioned.kind !== 'ok') return 1;
  const main = provisioned.value as ProvisionedAgentWallet;
  record({
    PRIVY_PROBE_WALLET_ID: main.walletId,
    PRIVY_PROBE_WALLET_ADDRESS: main.address,
    PRIVY_PROBE_POLICY_ID: main.policyId,
  });
  console.log(`wallet ${main.walletId} ${main.address} policy ${main.policyId}`);

  // Execution mode: record whatever Privy says about the wallet and the app.
  const walletView = await attempt(() => getAgentWallet(client, main.walletId), 'ok');
  shapes['walletView'] = walletView.kind === 'ok' ? walletView.value : describe(walletView);
  const appView = await attempt(
    () => client.get<Record<string, unknown>>(`/v1/apps/${privyConfig.appId}`),
    'ok',
  );
  // Key NAMES only — enough to see whether the app reports an execution mode.
  shapes['appKeys'] =
    appView.kind === 'ok' ? Object.keys(appView.value as object) : describe(appView);
  console.log(`app response keys: ${JSON.stringify(shapes['appKeys'])}`);
  console.log(`wallet view: ${JSON.stringify(shapes['walletView'])}`);

  const [approve5, deposit5] = depositCalls(ACCOUNT_CORE, USDC, usdc(5));
  const [, deposit11] = depositCalls(ACCOUNT_CORE, USDC, usdc(11));
  const depositTx = await txFor(main.address, deposit5!, KURU_MEASURED_GAS.firstDeposit);
  const approveTx = await txFor(main.address, approve5!, KURU_MEASURED_GAS.erc20Approve);

  console.log('');
  await check(
    '1',
    'Kuru deposit 5 USDC, under the 10 USDC cap',
    'signed',
    () => provider.signTransaction(main.walletId, depositTx),
    verifySignedTx(depositTx, main.address),
  );
  await check(
    '1b',
    'USDC approve 5 to AccountCore, under the cap',
    'signed',
    () => provider.signTransaction(main.walletId, approveTx),
    verifySignedTx(approveTx, main.address),
  );

  const overTx = await txFor(main.address, deposit11!, KURU_MEASURED_GAS.firstDeposit);
  await check('2', 'Kuru deposit 11 USDC, over the cap', 'refused', () =>
    provider.signTransaction(main.walletId, overTx),
  );

  const listedTx = await txFor(
    main.address,
    cancelOrderCall(MON_USDC.address, 1),
    KURU_MEASURED_GAS.cancelOne,
  );
  const unlistedTx = await txFor(
    main.address,
    cancelOrderCall(WETH_USDC.address, 1),
    KURU_MEASURED_GAS.cancelOne,
  );
  await check(
    '3a',
    'OrderBook.batch to the allowlisted market (MON-USDC) — both-overload ABI',
    'signed',
    () => provider.signTransaction(main.walletId, listedTx),
    verifySignedTx(listedTx, main.address),
  );
  await check('3', 'OrderBook.batch to a market NOT on the allowlist (WETH-USDC)', 'refused', () =>
    provider.signTransaction(main.walletId, unlistedTx),
  );

  await check('4', 'check 1 again with chain_id: 1', 'refused', () =>
    provider.signTransaction(main.walletId, { ...depositTx, chain_id: 1 }),
  );

  // ---- 6. Perpl enrollment typed data ------------------------------------------
  const typed = enrollment(main.address);
  shapes['typedDataSent'] = toPrivyTypedData(typed);
  await check(
    '6',
    'Perpl API-key enrollment typed data',
    'signed',
    () => provider.signTypedData(main.walletId, typed),
    verifySignedTyped(typed, main.address),
  );
  await check('6b', 'the same typed data with a different statement', 'refused', () =>
    provider.signTypedData(
      main.walletId,
      enrollment(main.address, 'I authorize something else entirely'),
    ),
  );

  await probeTypedData(provider, run, future, record);

  // ---- 7. who may change the policy --------------------------------------------
  await check('7a', 'PATCH the policy with NO signature', 'unauthorized', () =>
    client.patch(`/v1/policies/${main.policyId}`, { rules }),
  );
  await check('7', 'PATCH the policy signed by the AGENT key alone', 'unauthorized', () =>
    client.patch(
      `/v1/policies/${main.policyId}`,
      { rules },
      { approvals: [privyConfig.agentAuthKey] },
    ),
  );
  await check('7b', 'PATCH the policy signed by the MANDATE-OWNER key', 'ok', () =>
    provider.updatePolicy(main.policyId, rules),
  );

  // ---- 8. latency -----------------------------------------------------------------
  const timings: number[] = [];
  const latency = await attempt(async () => {
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      await provider.signTransaction(main.walletId, depositTx);
      timings.push(Math.round(performance.now() - started));
    }
  }, 'ok');
  const sorted = [...timings].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN;
  report(
    '8',
    'eth_signTransaction round trip, p50 over 10 serial calls',
    'observe',
    latency.kind === 'ok'
      ? `p50 ${p50} ms (min ${sorted[0]}, max ${sorted.at(-1)}) [${timings.join(', ')}]`
      : describe(latency),
    latency.kind === 'ok',
  );

  // ---- 7c. an owner's amendment takes effect — and how fast ------------------------
  // After 8, which needs the original cap. Lower the deposit cap to 1 USDC and
  // re-sign the 5 USDC deposit every 0.5 s until the enclave refuses it.
  const tightened = compileMandate({
    ...mandate,
    kuru: { ...mandate.kuru, maxDepositAtoms: { [USDC.address]: usdc(1) } },
  });
  const amended = await attempt(() => provider.updatePolicy(main.policyId, tightened), 'ok');
  if (amended.kind !== 'ok') {
    report(
      '7c',
      'owner lowers the deposit cap to 1 USDC',
      'refused',
      `PATCH failed: ${describe(amended)}`,
      false,
    );
  } else {
    const started = performance.now();
    const trail: string[] = [];
    let last: Outcome | undefined;
    while (performance.now() - started < 20_000) {
      last = await attempt(() => provider.signTransaction(main.walletId, depositTx), 'signed');
      trail.push(`${Math.round(performance.now() - started)}ms ${last.kind}`);
      if (last.kind === 'refused') break;
      await sleep(500);
    }
    report(
      '7c',
      'owner lowers the cap to 1 USDC: the same 5 USDC deposit is refused (time to take effect)',
      'refused',
      `${last ? describe(last) : 'no attempt'} [${trail.join(', ')}]`,
      last?.kind === 'refused',
    );
  }

  // ---- 5. aggregation: rolling sum, on wallets of their own ------------------------
  // Last, because it is the least certain and the slowest (it waits).
  console.log('\n5. AGGREGATION — rolling 1h sum of approve.amount, cap 15 USDC');
  await probeAggregation(client, provider, mandate, rules, run, record, txFor);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks as expected`);
  for (const r of failed) console.log(`  FAILED ${r.id}: ${r.title} — ${r.outcome}`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * 6c–6h: policy_violation never names the condition that failed, so each
 * condition of the enrollment rule gets its own PATCHed rule, one at a time.
 */
async function probeTypedData(
  provider: PrivyAgentWalletProvider,
  run: string,
  future: number,
  record: Record_,
): Promise<void> {
  console.log('\n6. TYPED DATA BISECTION — which condition of the enrollment rule decides?');
  const typedRule = (conditions: PolicyCondition[]): PolicyRule => ({
    name: 'sente-probe typed data',
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions,
  });
  const expiryOnly = [unixTimestampLte(future)];
  const provisioned = await attempt(
    () => provider.provision({ rules: [typedRule(expiryOnly)], displayName: `${run}-typed` }),
    'ok',
  );
  if (provisioned.kind !== 'ok') {
    report(
      '6c',
      'typed-data bisection wallet',
      'observe',
      `could not provision: ${describe(provisioned)}`,
      false,
    );
    return;
  }
  const wallet = provisioned.value as ProvisionedAgentWallet;
  record({
    PRIVY_PROBE_TYPED_WALLET_ID: wallet.walletId,
    PRIVY_PROBE_TYPED_POLICY_ID: wallet.policyId,
  });

  const typed = enrollment(wallet.address);
  const statement = typedDataMessageEq(
    PERPL_ENROLL_TYPED_DATA,
    'statement',
    PERPL_API_KEY_TYPED_DATA.statement,
  );
  const structOnly = {
    types: { PerplRegisterApiKey: PERPL_API_KEY_TYPED_DATA.types.PerplRegisterApiKey },
    primary_type: PERPL_API_KEY_TYPED_DATA.primaryType,
  };
  const variants: [string, string, PolicyCondition[]][] = [
    ['6c', 'only the expiry (decimal, as compiled)', expiryOnly],
    ['6d', 'only domain chainId (decimal, as compiled)', [typedDataChainIdEq(CHAIN_ID)]],
    [
      '6e',
      'only domain verifyingContract = the zero address',
      [typedDataVerifyingContractEq(PERPL_API_KEY_TYPED_DATA.domain.verifyingContract)],
    ],
    [
      '6f',
      'only message.statement, typed_data = the struct alone (the SEN-2 shape)',
      [{ ...statement, typed_data: structOnly } as PolicyCondition],
    ],
    ['6g', 'only message.statement, typed_data as @sente/mandate compiles it now', [statement]],
    [
      '6h',
      'only message.signer = this wallet (an address field)',
      [typedDataMessageEq(PERPL_ENROLL_TYPED_DATA, 'signer', wallet.address)],
    ],
  ];
  shapes['typedDataVariants'] = variants.map(([id, , conditions]) => ({ id, conditions }));
  for (const [index, [id, title, conditions]] of variants.entries()) {
    if (index > 0) {
      const patched = await attempt(
        () => provider.updatePolicy(wallet.policyId, [typedRule(conditions)]),
        'ok',
      );
      if (patched.kind !== 'ok') {
        report(id, title, 'observe', `policy PATCH rejected: ${describe(patched)}`, true);
        continue;
      }
      await sleep(SETTLE_MS);
    }
    await check(
      id,
      title,
      'observe',
      () => provider.signTypedData(wallet.walletId, typed),
      verifySignedTyped(typed, wallet.address),
    );
  }
}

/**
 * 5: a rolling sum of `approve.amount` with a rule that references it. Two
 * wallets — the cap spelled in hex (what `aggregationLte` emits) and in
 * decimal — each with its own aggregation, and a re-sign after 5 s and 30 s,
 * because Privy updates an aggregation only after the request is signed.
 */
async function probeAggregation(
  client: PrivyClient,
  provider: PrivyAgentWalletProvider,
  mandate: ReturnType<typeof parseMandate>,
  rules: readonly PolicyRule[],
  run: string,
  record: Record_,
  txFor: TxFor,
): Promise<void> {
  const draft = compileRollingCap(mandate)!;
  const { cap, ...draftBody } = draft;
  shapes['aggregationBody'] = compact(draftBody);
  const approveRule = rules.find((r) => r.name.startsWith('Kuru: approve USDC'))!;
  const [approve8] = depositCalls(ACCOUNT_CORE, USDC, usdc(8));

  const variants: [string, string, string, (aggregationId: string) => PolicyCondition][] = [
    ['5', 'hex cap, aggregationLte', '', (a) => aggregationLte(a, BigInt(cap))],
    [
      '5d',
      'decimal cap',
      '_DECIMAL',
      (a) => raw('reference', `aggregation.${a}`, 'lte', BigInt(cap).toString()),
    ],
  ];
  for (const [id, label, suffix, reference] of variants) {
    const created = await attempt(
      () =>
        client.post<{ id: string }>('/v1/aggregations', {
          ...draftBody,
          name: `sente-probe rolling ${id}`,
        }),
      'ok',
    );
    console.log(`  POST /v1/aggregations (${label}): ${describe(created)}`);
    if (created.kind !== 'ok') {
      report(
        id,
        `rolling cap (${label})`,
        'refused',
        `aggregation rejected: ${describe(created)}`,
        false,
      );
      continue;
    }
    const aggregationId = (created.value as { id: string }).id;
    shapes[`aggregationResponse_${id}`] = compact(created.value);

    const condition = reference(aggregationId);
    const rule: PolicyRule = {
      ...approveRule,
      name: `sente-probe rolling approve ${id}`,
      conditions: [...approveRule.conditions, condition],
    };
    const provisioned = await attempt(
      () => provider.provision({ rules: [rule], displayName: `${run}-rolling-${id}` }),
      'ok',
    );
    console.log(`  policy referencing it (${label}): ${describe(provisioned)}`);
    if (provisioned.kind !== 'ok') {
      report(
        id,
        `rolling cap (${label})`,
        'refused',
        `referencing policy rejected: ${describe(provisioned)}`,
        false,
      );
      continue;
    }
    shapes[`referenceCondition_${id}`] = condition;
    const wallet = provisioned.value as ProvisionedAgentWallet;
    record({
      [`PRIVY_PROBE_AGGREGATION_ID${suffix}`]: aggregationId,
      [`PRIVY_PROBE_ROLLING_WALLET_ID${suffix}`]: wallet.walletId,
      [`PRIVY_PROBE_ROLLING_POLICY_ID${suffix}`]: wallet.policyId,
    });

    const tx = await txFor(wallet.address, approve8!, KURU_MEASURED_GAS.erc20Approve);
    await check(`${id}a`, `rolling (${label}): 1st approve of 8 USDC (8 ≤ 15)`, 'signed', () =>
      provider.signTransaction(wallet.walletId, tx),
    );
    await check(id, `rolling (${label}): 2nd approve of 8, at once (16 > 15)`, 'refused', () =>
      provider.signTransaction(wallet.walletId, tx),
    );
    for (const seconds of [5, 30]) {
      await sleep(seconds * 1000);
      await check(
        `${id}+${seconds}s`,
        `rolling (${label}): another approve of 8 after ${seconds}s more`,
        'observe',
        () => provider.signTransaction(wallet.walletId, tx),
      );
    }
    const view = await attempt(() => client.get(`/v1/aggregations/${aggregationId}`), 'ok');
    shapes[`aggregationView_${id}`] = view.kind === 'ok' ? compact(view.value) : describe(view);
    console.log(
      `  GET /v1/aggregations/${aggregationId}: ${JSON.stringify(shapes[`aggregationView_${id}`])}`,
    );
  }
}

main().then(
  (code) => {
    writeReport();
    process.exitCode = code;
  },
  (error: unknown) => {
    // PrivyError carries Privy's response body, never our headers or keys.
    console.error(`probe aborted: ${(error as Error).message}`);
    writeReport();
    process.exitCode = 1;
  },
);
