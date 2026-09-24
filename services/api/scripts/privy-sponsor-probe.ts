// Live probe (SEN-39): can a Privy server wallet **owned by a locally
// generated P-256 key** send a **Privy-sponsored** ERC-20 transfer on Monad
// testnet while holding 0 MON?
//
//   pnpm --filter @sente/api run probe:privy-sponsor [-- --env-file <path>] [-- --out <file.json>]
//                                                    [-- --no-fund] [-- --fresh]
//
// This is Phase 3's load-bearing assumption: the user's wallet is a Privy
// wallet whose owner key lives on the user's device, and gas is paid by the
// app. Everything downstream (SEN-40, SEN-42) is built on it, so it is measured
// here before any product code depends on it.
//
// ## What it does, and what it costs
//
// It creates two Privy wallets — one with a **raw** `owner: {public_key}`, one
// owned by a **1-key quorum** holding the same key — to record which forms
// Privy accepts, then funds the raw-owner wallet with **1 USDC** from the
// treasury and leaves it at **0 MON** on purpose. The only chain spend is the
// treasury's gas for that one ERC-20 transfer (~0.003 MON at the fixed 82,000
// limit; Monad charges the LIMIT, CLAUDE.md gotcha 4). Nothing else is
// broadcast: the non-sponsored comparison stops at a signature, because a
// 0-MON EOA cannot pay for its own transaction — which is the whole point.
//
// Re-runnable: the throwaway owner key and both wallet ids are written back to
// the env file as `PRIVY_PROBE_SPONSOR_*` and reused, so a second run (after
// the dashboard step) probes the same wallets and can see whether delegation
// changed their addresses. `--fresh` ignores them and creates new ones.
//
// ## The human step this probe cannot do
//
// Sponsorship must be switched on in the Privy dashboard ("App pays" + prepaid
// gas credits for Monad Testnet). Until it is, step 6 is expected to fail, and
// capturing **Privy's exact wording** for that refusal is a deliberate result
// of this probe, not an accident — see `docs/privy-sponsorship.md`.
//
// Secrets: the app secret is never printed. The probe's owner key is a
// throwaway generated here; its private half goes to the env file (0600) and
// never to stdout. What is printed is ids, addresses, Privy's own error bodies,
// and signatures from a testnet wallet holding 1 USDC.
//
// Checks:
//   1  create a wallet with a RAW `owner: {public_key}`            → observe
//   2  create a 1-key QUORUM and a wallet owned by it              → observe
//   3  fund the raw-owner wallet: 1 USDC, 0 MON                    → ok
//   4  the signed-request flow: no approval → 401, wrong key → 401,
//      the owner key → signed; ecrecover the raw tx = the wallet   → pass/fail
//   5  eth_signTypedData_v4 + recoverTypedDataAddress              → pass/fail
//   6  eth_sendTransaction `sponsor: true`, then its receipt        → observe
//   6b a SECOND sponsored send at once: repeatability, and whether
//      Monad's reserve rule (gotcha 12) bites a 0-MON delegated EOA → observe
//   7  the same send with `sponsor` omitted (0 MON)                → observe
//   8  code at the address before and after: did 7702 delegate?    → observe
//
// 6, 6b and their receipts are only reachable once the dashboard step is done;
// until then 6 records the refusal and the rest still run.

import { existsSync, writeFileSync } from 'node:fs';

import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
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
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import {
  getAgentWallet,
  privyTransaction,
  signTransaction,
  signTypedData,
  type AgentWallet,
  type PrivyTransactionRequest,
} from '../src/agents/privy/agent-wallet.ts';
import {
  generateAuthorizationKey,
  loadAuthorizationKey,
  type AuthorizationKey,
} from '../src/agents/privy/authorization-key.ts';
import { createKeyQuorum } from '../src/agents/privy/key-quorum.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';
import { awaitUserOperation } from '../src/wallet/confirmation/user-operation-logs.ts';
import { envFileFromArgs, upsertEnv } from './env-file.ts';

const CHAIN_ID = 10143;
const CAIP2 = `eip155:${CHAIN_ID}`;
const USDC = {
  address: getAddress(KURU_TESTNET_TOKENS.USDC.address),
  decimals: KURU_TESTNET_TOKENS.USDC.decimals,
};
/** The sponsored send moves exactly this much, and the treasury funds exactly this much. */
const AMOUNT = 1_000_000n; // 1.000000 USDC
/** docs/monad-testnet-assets.md: ERC-20 transfer to a zero-balance holder, 72,918 measured. */
const ERC20_TRANSFER_GAS = 82_000n;

interface CheckResult {
  id: string;
  title: string;
  outcome: string;
  /** `undefined` for an observation: something recorded, with nothing to pass. */
  pass: boolean | undefined;
  detail?: unknown;
}

const results: CheckResult[] = [];
const ids: Record<string, string> = {};
const shapes: Record<string, unknown> = {};

type Outcome =
  | { kind: 'ok'; value: unknown }
  | {
      kind: 'error';
      status: number;
      code?: string;
      body?: unknown;
      message: string;
      /** `PrivyError.isMissingApproval`: nobody asked, as opposed to a refusal. */
      missingApproval: boolean;
    };

/** Belt and braces: Privy bodies hold no secrets, but strip any long base64 run. */
function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, inner: unknown) =>
      typeof inner === 'string' ? inner.replace(/[A-Za-z0-9+/=]{200,}/g, '[redacted]') : inner,
    ),
  ) as unknown;
}

async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: 'ok', value: await fn() };
  } catch (error) {
    if (error instanceof PrivyError) {
      return {
        kind: 'error',
        status: error.status,
        ...(error.code === undefined ? {} : { code: error.code }),
        body: redact(error.body),
        message: error.message,
        missingApproval: error.isMissingApproval,
      };
    }
    return {
      kind: 'error',
      status: 0,
      message: `${(error as Error).name}: ${(error as Error).message}`,
      missingApproval: false,
    };
  }
}

function describe(outcome: Outcome): string {
  if (outcome.kind === 'ok') return 'ok';
  return `HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''} ${JSON.stringify(outcome.body ?? outcome.message)}`;
}

function report(id: string, title: string, outcome: string, pass?: boolean, detail?: unknown) {
  results.push({ id, title, outcome, pass, ...(detail === undefined ? {} : { detail }) });
  const badge = pass === undefined ? 'NOTE' : pass ? 'PASS' : 'FAIL';
  console.log(`${badge}  ${id.padEnd(3)} ${title}`);
  console.log(`        ${outcome}${detail === undefined ? '' : `  ${String(detail)}`}`);
}

function writeReport(): void {
  const index = process.argv.indexOf('--out');
  const out = index >= 0 ? process.argv[index + 1] : undefined;
  if (!out) return;
  writeFileSync(
    out,
    `${JSON.stringify({ ranAt: new Date().toISOString(), chainId: CHAIN_ID, ids, results, shapes }, null, 2)}\n`,
  );
  console.log(`report written to ${out}`);
}

/**
 * `AgentWallet` with its address narrowed, because everything here hands it
 * straight to viem. The extra field a raw-owner wallet might carry is
 * deliberately absent: Privy answers `owner: {public_key}` with an `owner_id`
 * and no `owner`, which is check 1b's whole finding.
 */
interface PrivyWallet extends AgentWallet {
  address: Address;
}

/**
 * Sign-only typed data. Deliberately ours, not Perpl's: gotcha 13 — a probe
 * that signs a stale constant proves nothing about Perpl's live shape, so the
 * claim here is only "the signature is an ecrecover-able EOA signature".
 */
function typedDataPayload(verifyingContract: Address): TypedDataDefinition {
  return {
    domain: { name: 'Sente SEN-39 probe', version: '1', chainId: CHAIN_ID, verifyingContract },
    types: {
      Probe: [
        { name: 'purpose', type: 'string' },
        { name: 'issuedAt', type: 'uint256' },
      ],
    },
    primaryType: 'Probe',
    message: { purpose: 'sponsored-send probe', issuedAt: BigInt(Math.floor(Date.now() / 1000)) },
  };
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const appId = process.env['PRIVY_APP_ID']?.trim();
  const appSecret = process.env['PRIVY_APP_SECRET']?.trim();
  if (!appId || !appSecret) {
    console.log('pending credentials: PRIVY_APP_ID/PRIVY_APP_SECRET not set');
    return 0;
  }
  const fresh = process.argv.includes('--fresh');
  const client = new PrivyClient({ appId, appSecret });
  const record = (entries: Record<string, string>) => {
    Object.assign(ids, entries);
    upsertEnv(envFile, entries, { overwrite: true });
  };
  /** What a previous run left in the env file, unless `--fresh` says start over. */
  const reused = (name: string): string | undefined =>
    fresh ? undefined : process.env[name]?.trim() || undefined;

  // The owner key. Generated here and kept in the env file so a second run
  // (after the dashboard step) can sign for the SAME wallets — without it the
  // wallets are unreachable and the delegation question cannot be answered.
  const stored = reused('PRIVY_PROBE_SPONSOR_OWNER_KEY');
  const ownerKey: AuthorizationKey = stored
    ? loadAuthorizationKey(stored)
    : generateAuthorizationKey();
  if (!stored) record({ PRIVY_PROBE_SPONSOR_OWNER_KEY: ownerKey.privateKey });
  // A second, unrelated key: the negative case in check 4.
  const strangerKey = generateAuthorizationKey();

  const rpcUrl = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const rpc = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const fees = await rpc.estimateFeesPerGas().catch(async () => {
    const gasPrice = await rpc.getGasPrice();
    return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
  });
  const run = `sente-sen39-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
  console.log(`app ${appId}; env file ${envFile}; run ${run}`);
  console.log(`owner key: ${stored ? 'reused from PRIVY_PROBE_SPONSOR_OWNER_KEY' : 'generated'}`);
  console.log(`monad fees: maxFeePerGas=${fees.maxFeePerGas} prio=${fees.maxPriorityFeePerGas}`);

  // ---- 1. a wallet owned by a RAW public key ------------------------------
  let rawWallet: PrivyWallet | undefined;
  const rawWalletId = reused('PRIVY_PROBE_SPONSOR_WALLET_ID');
  if (rawWalletId) {
    rawWallet = (await getAgentWallet(client, rawWalletId)) as PrivyWallet;
    report('1', 'wallet owned by a raw P-256 public key (reused)', `ok ${rawWallet.id}`);
  } else {
    const created = await attempt(() =>
      client.post<PrivyWallet>('/v1/wallets', {
        chain_type: 'ethereum',
        owner: { public_key: ownerKey.publicKey },
        display_name: `${run}-raw`.slice(0, 50),
      }),
    );
    shapes.rawOwnerWalletResponse =
      created.kind === 'ok' ? redact(created.value) : describe(created);
    if (created.kind === 'ok') {
      rawWallet = created.value as PrivyWallet;
      report(
        '1',
        'wallet owned by a raw `owner: {public_key}`',
        `accepted → ${rawWallet.id}`,
        true,
      );
      record({
        PRIVY_PROBE_SPONSOR_WALLET_ID: rawWallet.id,
        PRIVY_PROBE_SPONSOR_WALLET_ADDRESS: rawWallet.address,
      });
    } else {
      report(
        '1',
        'wallet owned by a raw `owner: {public_key}`',
        `refused: ${describe(created)}`,
        false,
      );
    }
  }

  // Privy answers a raw owner with an `owner_id`, never an `owner` — so is a
  // raw owner its own thing, or sugar for a quorum? Read the id back and see.
  if (rawWallet?.owner_id) {
    const owner = await attempt(() =>
      client.get<{ id: string; authorization_threshold?: number; authorization_keys?: unknown[] }>(
        `/v1/key_quorums/${rawWallet.owner_id}`,
      ),
    );
    shapes.rawOwnerQuorum = owner.kind === 'ok' ? redact(owner.value) : describe(owner);
    const keys =
      owner.kind === 'ok'
        ? ((owner.value as { authorization_keys?: { public_key?: string }[] }).authorization_keys ??
          [])
        : [];
    report(
      '1b',
      'read the raw owner back: is `owner: {public_key}` sugar for a 1-key quorum?',
      owner.kind === 'ok'
        ? `GET /v1/key_quorums/${rawWallet.owner_id} → threshold ` +
            `${(owner.value as { authorization_threshold?: number }).authorization_threshold}, ` +
            `${keys.length} key(s), ours ${keys.some((k) => k.public_key === ownerKey.publicKey) ? 'present' : 'ABSENT'}`
        : describe(owner),
      owner.kind === 'ok' && keys.some((k) => k.public_key === ownerKey.publicKey),
    );
  }

  // ---- 2. the same key as a 1-key quorum ----------------------------------
  const quorumId =
    reused('PRIVY_PROBE_SPONSOR_QUORUM_ID') ??
    (
      await createKeyQuorum(client, {
        displayName: `${run}-quorum`,
        threshold: 1,
        publicKeys: [ownerKey.publicKey],
      })
    ).id;
  const quorumWalletId = reused('PRIVY_PROBE_SPONSOR_QUORUM_WALLET_ID');
  const quorumWallet: PrivyWallet = quorumWalletId
    ? ((await getAgentWallet(client, quorumWalletId)) as PrivyWallet)
    : await client.post<PrivyWallet>('/v1/wallets', {
        chain_type: 'ethereum',
        owner_id: quorumId,
        display_name: `${run}-quorum-wallet`.slice(0, 50),
      });
  shapes.quorumWalletResponse = redact(quorumWallet);
  record({
    PRIVY_PROBE_SPONSOR_QUORUM_ID: quorumId,
    PRIVY_PROBE_SPONSOR_QUORUM_WALLET_ID: quorumWallet.id,
    PRIVY_PROBE_SPONSOR_QUORUM_WALLET_ADDRESS: quorumWallet.address,
  });
  report(
    '2',
    'wallet owned by a 1-key quorum holding the same key',
    `ok ${quorumWallet.id} ${quorumWallet.address}`,
    true,
  );

  // Everything below runs against the raw-owner wallet when Privy took it,
  // and against the quorum wallet otherwise — so the probe still answers the
  // sponsorship question either way.
  const wallet = rawWallet ?? quorumWallet;
  console.log(
    `\nprobing ${rawWallet ? 'the RAW-owner' : 'the QUORUM-owned'} wallet ` +
      `${wallet.id} at ${wallet.address}\n`,
  );

  const codeBefore = (await rpc.getCode({ address: wallet.address })) ?? '0x';
  shapes.codeBefore = codeBefore;

  // ---- 3. fund it: 1 USDC, and 0 MON on purpose ---------------------------
  const balances = async () => {
    const [mon, usdc] = await Promise.all([
      rpc.getBalance({ address: wallet.address }),
      rpc.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address],
      }),
    ]);
    return { mon, usdc };
  };
  let held = await balances();
  // Derived once, and only from a key that parses: every later use of the
  // treasury (funding, and the address the probe sends the USDC back to) reads
  // this one account, so a malformed key skips funding instead of throwing.
  const treasuryRaw = process.env['TREASURY_PRIVATE_KEY']?.trim().replace(/^0x/i, '');
  const treasury = /^[0-9a-f]{64}$/i.test(treasuryRaw ?? '')
    ? privateKeyToAccount(`0x${treasuryRaw}` as Hex)
    : undefined;
  const skipFunding = process.argv.includes('--no-fund');
  if (held.usdc < AMOUNT && !skipFunding && treasury) {
    const bank = createWalletClient({
      account: treasury,
      chain: monadTestnet,
      transport: http(rpcUrl),
    });
    const hash = await bank.sendTransaction({
      to: USDC.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [wallet.address, AMOUNT],
      }),
      gas: ERC20_TRANSFER_GAS,
    });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    ids.fundingTx = hash;
    held = await balances();
    report(
      '3',
      'fund the wallet: 1 USDC from the treasury, 0 MON',
      `${receipt.status} ${hash} (block ${receipt.blockNumber}, gas used ${receipt.gasUsed}/${ERC20_TRANSFER_GAS})`,
      receipt.status === 'success' && held.usdc >= AMOUNT,
    );
  } else {
    report('3', 'fund the wallet: 1 USDC from the treasury, 0 MON', 'already funded / skipped');
  }
  shapes.balances = {
    mon: formatEther(held.mon),
    usdc: formatUnits(held.usdc, USDC.decimals),
  };
  console.log(
    `        holds MON ${formatEther(held.mon)}  USDC ${formatUnits(held.usdc, USDC.decimals)}`,
  );

  // The send under test: the 1 USDC goes straight back to the treasury, so a
  // successful sponsored run costs nothing beyond the gas Privy paid.
  const transferData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [treasury?.address ?? wallet.address, AMOUNT],
  });

  // ---- 4. the signed-request flow ----------------------------------------
  const nonce = await rpc.getTransactionCount({ address: wallet.address, blockTag: 'pending' });
  const unsponsored: PrivyTransactionRequest = privyTransaction({
    to: USDC.address,
    data: transferData,
    chainId: CHAIN_ID,
    nonce,
    gas: ERC20_TRANSFER_GAS,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  // Through `agent-wallet.ts`'s own helpers, not a hand-rolled POST: the point
  // of check 4 is that the path production code takes works unchanged when the
  // owner is a user's key rather than our server's.
  const signRpc = (approvals: readonly AuthorizationKey[]) =>
    signTransaction(client, { walletId: wallet.id, transaction: unsponsored, approvals });

  const noApproval = await attempt(() => signRpc([]));
  report(
    '4a',
    'eth_signTransaction with NO authorization signature',
    describe(noApproval),
    noApproval.kind === 'error' && noApproval.missingApproval,
  );
  const wrongKey = await attempt(() => signRpc([strangerKey]));
  report(
    '4b',
    'eth_signTransaction signed by an UNRELATED P-256 key',
    describe(wrongKey),
    wrongKey.kind === 'error' && wrongKey.missingApproval,
  );
  const signed = await attempt(() => signRpc([ownerKey]));
  if (signed.kind === 'ok') {
    const raw = signed.value as TransactionSerialized;
    const parsed = parseTransaction(raw);
    const recovered = await recoverTransactionAddress({ serializedTransaction: raw });
    shapes.signedTransaction = {
      type: parsed.type,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      to: parsed.to,
      recovered,
    };
    report(
      '4c',
      'eth_signTransaction signed by the OWNER key; ecrecover the raw tx',
      `signed (type ${parsed.type}, chainId ${parsed.chainId}, nonce ${parsed.nonce}) → ${recovered}`,
      isAddressEqual(recovered, wallet.address),
      'NOT broadcast: the wallet holds 0 MON and could not pay for it — that is what sponsorship is for',
    );
  } else {
    report('4c', 'eth_signTransaction signed by the OWNER key', describe(signed), false);
  }

  // ---- 5. eth_signTypedData_v4 + ecrecover --------------------------------
  const typed = typedDataPayload(USDC.address);
  const typedOutcome = await attempt(() =>
    signTypedData(client, { walletId: wallet.id, typedData: typed, approvals: [ownerKey] }),
  );
  if (typedOutcome.kind === 'ok') {
    const signature = typedOutcome.value as Hex;
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    shapes.typedDataSignature = { signature, recovered };
    report(
      '5',
      'eth_signTypedData_v4, then recoverTypedDataAddress (gotcha 9: Perpl is ecrecover-only)',
      `signature ${signature.length === 132 ? '65 bytes (r‖s‖v)' : `${(signature.length - 2) / 2} bytes`} → ${recovered}`,
      isAddressEqual(recovered, wallet.address),
    );
  } else {
    report('5', 'eth_signTypedData_v4', describe(typedOutcome), false);
  }

  /**
   * What did a successful sponsored send actually return, and did it land?
   *
   * The response shape is the unknown this probe exists to record, so nothing is
   * assumed: every 32-byte hash in `data` is reported, and then the RIGHT kind of
   * receipt is read for the kind of hash that came back.
   *
   * **A user-operation hash is not a transaction hash** (CLAUDE.md gotcha 8).
   * Until SEN-42 this function waited for a TRANSACTION receipt whatever it was
   * handed, which for a sponsored send is a hash no transaction will ever have:
   * check 6r timed out on every run and read as "the send did not land" when the
   * send had landed. A user-operation hash is now followed to its
   * `UserOperationEvent` and judged on ITS `success` flag, which is the only
   * field that answers the question — the carrying transaction can succeed while
   * the operation inside it reverted.
   */
  async function settle(id: string, value: unknown): Promise<void> {
    const data = (value as { data?: Record<string, unknown> }).data ?? {};
    const hashes = Object.entries(data).filter(
      ([, v]) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v),
    ) as [string, Hex][];
    shapes[`settle_${id}_hashes`] = Object.fromEntries(hashes);
    const userOpHash = hashes.find(([k]) => /user_?op/i.test(k))?.[1];
    const txHash = hashes.find(([k]) => !/user_?op/i.test(k))?.[1];
    if (!userOpHash && !txHash) {
      report(`${id}r`, 'receipt for the sponsored send', 'no 32-byte hash in the response', false);
      return;
    }
    const started = Date.now();

    if (userOpHash) {
      // Sponsored: the operation's own receipt, off the EntryPoint's event.
      const { outcome } = await awaitUserOperation(rpc, userOpHash, { timeoutMs: 60_000 });
      const held = await balances();
      shapes[`settle_${id}_userOperation`] = outcome
        ? {
            success: outcome.success,
            transactionHash: outcome.transactionHash,
            blockNumber: `${outcome.blockNumber}`,
            paymaster: outcome.paymaster,
            actualGasCost: `${outcome.actualGasCost}`,
            elapsedMs: Date.now() - started,
            walletMonAfter: formatEther(held.mon),
            walletUsdcAfter: formatUnits(held.usdc, USDC.decimals),
          }
        : null;
      report(
        `${id}r`,
        `USER OPERATION receipt for ${userOpHash}`,
        outcome
          ? `success=${outcome.success} in block ${outcome.blockNumber} (tx ` +
              `${outcome.transactionHash}, paymaster ${outcome.paymaster}) after ` +
              `${Date.now() - started} ms; wallet now MON ${formatEther(held.mon)} ` +
              `USDC ${formatUnits(held.usdc, USDC.decimals)}`
          : `no UserOperationEvent within ${Date.now() - started} ms`,
        outcome?.success === true,
        'gotcha 8: judged on the OPERATION’s success flag, not the carrying transaction’s status',
      );
      return;
    }

    const receipt = await rpc
      .waitForTransactionReceipt({ hash: txHash!, timeout: 60_000 })
      .catch((error: unknown) => error as Error);
    if (receipt instanceof Error) {
      report(`${id}r`, `receipt for ${txHash}`, `not found: ${receipt.message}`, false);
      return;
    }
    const held = await balances();
    shapes[`settle_${id}_receipt`] = {
      status: receipt.status,
      blockNumber: `${receipt.blockNumber}`,
      from: receipt.from,
      gasUsed: `${receipt.gasUsed}`,
      effectiveGasPrice: `${receipt.effectiveGasPrice}`,
      elapsedMs: Date.now() - started,
      walletMonAfter: formatEther(held.mon),
      walletUsdcAfter: formatUnits(held.usdc, USDC.decimals),
    };
    report(
      `${id}r`,
      `receipt for ${txHash}`,
      `${receipt.status} in block ${receipt.blockNumber} after ${Date.now() - started} ms; ` +
        `submitted by ${receipt.from}; wallet now MON ${formatEther(held.mon)} ` +
        `USDC ${formatUnits(held.usdc, USDC.decimals)}`,
      receipt.status === 'success',
    );
  }

  // ---- 6. the sponsored send ----------------------------------------------
  // Two body shapes, because a refusal that is really a validation error would
  // otherwise read as "sponsorship is off". Both are recorded verbatim.
  const sponsoredBodies: [string, Record<string, unknown>][] = [
    [
      'with chain_id',
      {
        method: 'eth_sendTransaction',
        caip2: CAIP2,
        sponsor: true,
        params: { transaction: { to: USDC.address, data: transferData, chain_id: CHAIN_ID } },
      },
    ],
    [
      'minimal (caip2 only)',
      {
        method: 'eth_sendTransaction',
        caip2: CAIP2,
        sponsor: true,
        params: { transaction: { to: USDC.address, data: transferData } },
      },
    ],
  ];
  /** Send one body, time it, record the whole answer, and chase the receipt. */
  async function send(id: string, title: string, body: Record<string, unknown>): Promise<boolean> {
    const started = Date.now();
    const outcome = await attempt(() =>
      client.post<unknown>(`/v1/wallets/${wallet.id}/rpc`, body, { approvals: [ownerKey] }),
    );
    const elapsed = Date.now() - started;
    const answer = redact(outcome.kind === 'ok' ? outcome.value : outcome);
    shapes[`send_${id}`] = { request: body, elapsedMs: elapsed, response: answer };
    report(
      id,
      title,
      `${describe(outcome)} in ${elapsed} ms`,
      outcome.kind === 'ok' ? true : undefined,
      outcome.kind === 'ok' ? JSON.stringify(answer) : undefined,
    );
    if (outcome.kind !== 'ok') return false;
    await settle(id, outcome.value);
    return true;
  }

  let sponsoredOk = false;
  let sponsoredBody: Record<string, unknown> | undefined;
  for (const [label, body] of sponsoredBodies) {
    if (sponsoredOk) break;
    sponsoredOk = await send('6', `eth_sendTransaction sponsor:true, ${label}`, body);
    if (sponsoredOk) sponsoredBody = body;
  }

  // ---- 6b. repeatability, and Monad's reserve rule on a 0-MON EOA ---------
  // Only reachable once sponsorship is on. Gotcha 12 says a below-reserve EOA
  // may not send twice in quick succession — but this wallet's MON balance
  // never moves, and the external research says that is the exemption. Measure
  // it rather than trust it, right after the first send, which is the worst
  // case for that rule.
  if (sponsoredBody) {
    await send(
      '6b',
      'a SECOND sponsored send at once (repeatability + reserve balance, gotcha 12)',
      sponsoredBody,
    );
  }

  // ---- 7. the same send, unsponsored --------------------------------------
  const unsponsoredSend = await attempt(() =>
    client.post<unknown>(
      `/v1/wallets/${wallet.id}/rpc`,
      {
        method: 'eth_sendTransaction',
        caip2: CAIP2,
        params: { transaction: { to: USDC.address, data: transferData, chain_id: CHAIN_ID } },
      },
      { approvals: [ownerKey] },
    ),
  );
  shapes.unsponsoredSend =
    unsponsoredSend.kind === 'ok' ? redact(unsponsoredSend.value) : redact(unsponsoredSend);
  report(
    '7',
    'the same send with `sponsor` omitted (wallet holds 0 MON)',
    describe(unsponsoredSend),
  );

  // ---- 8. did anything delegate the address? ------------------------------
  const [after, code] = await Promise.all([
    getAgentWallet(client, wallet.id),
    rpc.getCode({ address: wallet.address }),
  ]);
  const codeAfter = code ?? '0x';
  shapes.codeAfter = codeAfter;
  shapes.walletAfter = redact(after);
  const sameAddress = isAddressEqual(after.address as Address, wallet.address);
  report(
    '8',
    'address and code after the send attempts (EIP-7702 delegation?)',
    `address ${wallet.address} → ${after.address} (${sameAddress ? 'unchanged' : 'CHANGED'}); ` +
      `code ${codeBefore} → ${codeAfter}`,
    sameAddress,
  );

  const failed = results.filter((r) => r.pass === false);
  console.log(
    `\n${results.length} checks; ${failed.length} failed; sponsored send ${sponsoredOk ? 'LANDED' : 'BLOCKED'}`,
  );
  if (!sponsoredOk) {
    console.log(
      'Sponsorship is not available to this app yet. Enable "App pays" gas sponsorship for\n' +
        'Monad Testnet with prepaid gas credits in the Privy dashboard, then re-run: the probe\n' +
        'reuses PRIVY_PROBE_SPONSOR_* and hits the same wallet.',
    );
  }
  return failed.length === 0 ? 0 : 1;
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
