// Live probe (SEN-42): does the device-signed, server-forwarded, Privy-sponsored
// send actually work — end to end, through the code the API ships?
//
//   pnpm --filter @sente/api run probe:user-send [-- --env-file <path>]
//                                               [-- --out <file.json>] [-- --fresh]
//
// SEN-39 proved that a sponsored send lands when the probe composes the request
// by hand. This one proves the same thing through `wallet/send/sponsored-send.ts`
// and `agents/privy/user-wallet.ts` — the modules the API uses — with a
// THROWAWAY P-256 key standing in for the phone's device key, and it answers the
// three questions the SEN-39 rerun left open:
//
//   1. Is the returned `user_operation_hash` followable, and by whom? It asks
//      the chain (`UserOperationEvent`) AND our Pimlico bundler, because a
//      sponsored send is bundled by Privy's provider, not by ours.
//   2. How much spacing does a SECOND sponsored send need? It fires one
//      immediately (the known failure) and then backs off until one lands,
//      printing the gap that worked.
//   3. Does a DELEGATED wallet still produce an `ecrecover`-able typed-data
//      signature — gotcha 9, which decides whether Perpl enrollment survives?
//
// ## What it costs
//
// 1 USDC moved from the treasury to the probe wallet (once; re-runs reuse it),
// its ~0.008 MON of treasury gas, and then only Privy's gas credits: every send
// here is sponsored, and each one returns 0.05 USDC to the treasury. The probe
// wallet is left holding 0 MON on purpose — that is the property under test.
//
// Re-runnable: the device key and the wallet id are written back to the env file
// as `PRIVY_PROBE_SEND_*`. `--fresh` ignores them and makes a new wallet, which
// is the only way to observe the FIRST sponsored send delegating an account.

import { existsSync, writeFileSync } from 'node:fs';

import { canonicalize } from '@sente/mandate';
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
  recoverTypedDataAddress,
  type Address,
  type Hash,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { signTypedData } from '../src/agents/privy/agent-wallet.ts';
import {
  generateAuthorizationKey,
  loadAuthorizationKey,
  signAuthorizationPayload,
  type AuthorizationKey,
} from '../src/agents/privy/authorization-key.ts';
import { PrivyClient, type PrivyError } from '../src/agents/privy/privy.client.ts';
import { createUserWallet, getUserWallet } from '../src/agents/privy/user-wallet.ts';
import { awaitUserOperation } from '../src/wallet/confirmation/user-operation-logs.ts';
import {
  readSendResponse,
  SEND_CHAIN_ID,
  sponsoredSendBody,
  sponsoredTransferTransaction,
  walletRpcPath,
} from '../src/wallet/send/sponsored-send.ts';
import { envFileFromArgs, upsertEnv } from './env-file.ts';

const USDC = {
  symbol: 'USDC',
  address: getAddress(KURU_TESTNET_TOKENS.USDC.address),
  decimals: KURU_TESTNET_TOKENS.USDC.decimals,
};
/** Funded once, from the treasury. */
const FUNDING = 1_000_000n; // 1.000000 USDC
/** Each sponsored send returns this much to the treasury. */
const SEND_AMOUNT = 50_000n; // 0.050000 USDC
/** docs/monad-testnet-assets.md: an ERC-20 transfer to a zero-balance holder. */
const ERC20_TRANSFER_GAS = 82_000n;
/** How long to chase a user operation before calling it unlanded. */
const CONFIRM_TIMEOUT_MS = 30_000;
/** The gaps tried for the second send, in order. The first is the known failure. */
const SPACING_LADDER_MS = [0, 1_000, 2_000, 4_000, 8_000];

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
  console.log(`${badge}  ${id.padEnd(3)} ${title}`);
  console.log(`        ${outcome}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Privy bodies hold no secrets, but strip any long base64 run all the same. */
function redact(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, inner: unknown) =>
      typeof inner === 'string' ? inner.replace(/[A-Za-z0-9+/=]{200,}/g, '[redacted]') : inner,
    ),
  ) as unknown;
}

function writeReport(): void {
  const index = process.argv.indexOf('--out');
  const out = index >= 0 ? process.argv[index + 1] : undefined;
  if (!out) return;
  writeFileSync(
    out,
    `${JSON.stringify(
      { ranAt: new Date().toISOString(), chainId: SEND_CHAIN_ID, results, shapes },
      // A bigint is not JSON, and half the interesting numbers here are bigints
      // (gas, block numbers). Stringified rather than dropped.
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    )}\n`,
  );
  console.log(`report written to ${out}`);
}

/** Sign-only typed data. Ours, not Perpl's: gotcha 13 — see the SEN-39 probe. */
function typedDataPayload(verifyingContract: Address): TypedDataDefinition {
  return {
    domain: { name: 'Sente SEN-42 probe', version: '1', chainId: SEND_CHAIN_ID, verifyingContract },
    types: {
      Probe: [
        { name: 'purpose', type: 'string' },
        { name: 'issuedAt', type: 'uint256' },
      ],
    },
    primaryType: 'Probe',
    message: {
      purpose: 'device-signed send probe',
      issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    },
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
  const rpcUrl = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const rpc = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const record = (entries: Record<string, string>) =>
    upsertEnv(envFile, entries, { overwrite: true });
  const reused = (name: string): string | undefined =>
    fresh ? undefined : process.env[name]?.trim() || undefined;

  // ---- the phone, standing in -------------------------------------------
  // A P-256 key generated here plays the `device` key of SEN-38. Everything it
  // does is what `signPrivyAuthorization` does on the phone — SEN-38 pins the
  // two implementations equal over a fixture, so this is the same signature.
  const storedKey = reused('PRIVY_PROBE_SEND_DEVICE_KEY');
  const deviceKey: AuthorizationKey = storedKey
    ? loadAuthorizationKey(storedKey)
    : generateAuthorizationKey();
  if (!storedKey) record({ PRIVY_PROBE_SEND_DEVICE_KEY: deviceKey.privateKey });
  console.log(`app ${appId}; env file ${envFile}`);
  console.log(`device key: ${storedKey ? 'reused' : 'generated'}`);

  // ---- 1. the user's wallet, owned by that key ---------------------------
  const storedWalletId = reused('PRIVY_PROBE_SEND_WALLET_ID');
  let walletId: string;
  let address: Address;
  if (storedWalletId) {
    const wallet = await getUserWallet(client, storedWalletId);
    walletId = wallet.id;
    address = getAddress(wallet.address);
    report('1', 'user wallet owned by the device key (reused)', `${walletId} at ${address}`);
  } else {
    const created = await createUserWallet(client, {
      devicePublicKey: deviceKey.publicKey,
      displayName: `sen42-probe-${Date.now().toString(36)}`,
    });
    walletId = created.wallet.id;
    address = getAddress(created.wallet.address);
    record({ PRIVY_PROBE_SEND_WALLET_ID: walletId, PRIVY_PROBE_SEND_WALLET_ADDRESS: address });
    report(
      '1',
      'user wallet created through createUserWallet (owner = a 1-key device quorum)',
      `${walletId} at ${address}, owner quorum ${created.ownerQuorumId}`,
      true,
    );
  }
  shapes.wallet = { walletId, address };

  const codeBefore = (await rpc.getCode({ address })) ?? '0x';

  // ---- 2. fund it: 1 USDC, 0 MON ----------------------------------------
  const held = async () => {
    const [mon, usdc] = await Promise.all([
      rpc.getBalance({ address }),
      rpc.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
    ]);
    return { mon, usdc };
  };
  const treasuryRaw = process.env['TREASURY_PRIVATE_KEY']?.trim().replace(/^0x/i, '');
  const treasury = /^[0-9a-f]{64}$/i.test(treasuryRaw ?? '')
    ? privateKeyToAccount(`0x${treasuryRaw}` as Hex)
    : undefined;
  if (!treasury) {
    report('2', 'fund the wallet', 'TREASURY_PRIVATE_KEY missing or malformed', false);
    return 1;
  }
  let balances = await held();
  if (balances.usdc < SEND_AMOUNT * 3n) {
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
        args: [address, FUNDING],
      }),
      // Explicit: Monad charges the LIMIT, so an estimate with a multiplier on
      // top is money spent (gotcha 4).
      gas: ERC20_TRANSFER_GAS,
    });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    balances = await held();
    report(
      '2',
      'fund the wallet: 1 USDC from the treasury, 0 MON',
      `${receipt.status} ${hash} (block ${receipt.blockNumber})`,
      receipt.status === 'success',
    );
  } else {
    report('2', 'fund the wallet: 1 USDC from the treasury, 0 MON', 'already funded');
  }
  console.log(
    `        holds MON ${formatEther(balances.mon)}  USDC ${formatUnits(balances.usdc, USDC.decimals)}`,
  );

  // ---- the product path, in three steps ---------------------------------
  const recipient = treasury.address;
  /** PREPARE: exactly what `UserWalletService.prepareSend` composes. */
  const prepare = () => {
    const transaction = sponsoredTransferTransaction(USDC, recipient, SEND_AMOUNT);
    const body = sponsoredSendBody(transaction);
    const path = walletRpcPath(walletId);
    return { path, body, payload: client.authorizationPayload('POST', path, body) };
  };

  /**
   * VERIFY, the way the phone must: rebuild the request from the intent and
   * refuse anything that does not match
   * (`apps/mobile/src/wallet/send.ts#verifySendPayload`).
   *
   * ONE comparison, of the WHOLE payload, built only from the shipped composers.
   * A hand-written field-by-field check here would be a third set of rules, and
   * the way it fails is the worst one available: reporting "identical" for a
   * payload the app would refuse. Canonical JSON on both sides, because the
   * signature is over RFC 8785 bytes, where key order does not matter.
   */
  const verify = (payload: unknown): string | undefined => {
    const expected = {
      version: 1,
      method: 'POST',
      url: `https://api.privy.io${walletRpcPath(walletId)}`,
      body: sponsoredSendBody(sponsoredTransferTransaction(USDC, recipient, SEND_AMOUNT)),
      headers: { 'privy-app-id': appId },
    };
    const mine = canonicalize(expected);
    const theirs = canonicalize(payload);
    return mine === theirs ? undefined : `${theirs} is not ${mine}`;
  };

  /** EXECUTE: the phone's signature, forwarded verbatim and alone. */
  const execute = async (prepared: ReturnType<typeof prepare>) => {
    const signature = signAuthorizationPayload(deviceKey.privateKey, prepared.payload);
    const started = Date.now();
    const response = await client.request<unknown>('POST', prepared.path, prepared.body, {
      signatures: [signature],
    });
    const at = Date.now();
    return { response, at, elapsedMs: at - started, outcome: readSendResponse(response) };
  };

  /** Chase one user operation to its own receipt. `null` means it never landed. */
  const confirm = async (hash: Hash) => {
    const { outcome, elapsedMs } = await awaitUserOperation(rpc, hash, {
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
    return { outcome, confirmMs: elapsedMs };
  };

  // ---- 3. the phone's check ---------------------------------------------
  const first = prepare();
  const mismatch = verify(first.payload);
  shapes.payload = redact(first.payload);
  report(
    '3',
    'the payload rebuilt from the intent matches what the API composed',
    mismatch ?? 'identical, byte for byte: version, method, URL, headers, and the whole body',
    mismatch === undefined,
  );

  // ---- 4. a refusal the device key must produce -------------------------
  // Signed by an unrelated key: Privy must refuse, or the owner check is not a
  // check at all.
  const stranger = generateAuthorizationKey();
  try {
    await client.request('POST', first.path, first.body, {
      signatures: [signAuthorizationPayload(stranger.privateKey, first.payload)],
    });
    report(
      '4',
      'a send signed by an UNRELATED P-256 key',
      'accepted — the owner check failed',
      false,
    );
  } catch (error) {
    const privy = error as PrivyError;
    report(
      '4',
      'a send signed by an UNRELATED P-256 key',
      `refused: HTTP ${privy.status} ${privy.code ?? ''}`.trim(),
      privy.status === 401 || privy.status === 403,
    );
  }

  // ---- 5. the sponsored send -------------------------------------------
  const sent = await execute(prepare());
  shapes.sendResponse = redact(sent.response);
  report(
    '5',
    'the device-signed sponsored send',
    `${sent.elapsedMs} ms → ${JSON.stringify(redact(sent.response))}`,
    sent.outcome.userOpHash !== undefined,
  );
  const userOpHash = sent.outcome.userOpHash;
  if (!userOpHash) {
    report('5r', 'confirmation', 'no user-operation hash to follow', false);
    summarise();
    return 1;
  }

  // ---- 6. how much spacing does the second send need? -------------------
  // FIRST, before anything else is measured: "immediately" has to mean
  // immediately. Confirming the first send would take a second or two, and a
  // ladder that started after it could not see the failure at all.
  //
  // The number that matters is the gap since the ACCEPTED send, not since the
  // last attempt: a refused attempt still took time, and a ladder that ignored
  // that would report a floor lower than the one it measured.
  const spacing: { sinceAcceptedMs: number; ok: boolean; detail: string }[] = [];
  let enoughMs: number | undefined;
  let secondHash: Hash | undefined;
  for (const wait of SPACING_LADDER_MS) {
    if (wait > 0) await sleep(wait);
    const attempt = prepare();
    const sinceAcceptedMs = Date.now() - sent.at;
    try {
      const second = await execute(attempt);
      spacing.push({
        sinceAcceptedMs,
        ok: true,
        detail: `${second.elapsedMs} ms → userOp ${second.outcome.userOpHash ?? 'none'}`,
      });
      enoughMs = sinceAcceptedMs;
      secondHash = second.outcome.userOpHash;
      break;
    } catch (error) {
      const privy = error as PrivyError;
      spacing.push({
        sinceAcceptedMs,
        ok: false,
        detail: `HTTP ${privy.status} ${privy.code ?? ''} ${JSON.stringify(redact(privy.body))}`,
      });
    }
  }
  shapes.spacing = spacing;
  for (const attempt of spacing) {
    report(
      `6@${attempt.sinceAcceptedMs}ms`,
      `a SECOND sponsored send ${attempt.sinceAcceptedMs} ms after the accepted one`,
      attempt.detail,
      attempt.ok,
    );
  }
  report(
    '6',
    'spacing needed between two sponsored sends from one wallet',
    enoughMs === undefined
      ? `still refused ${spacing.at(-1)?.sinceAcceptedMs ?? 0} ms after the first send`
      : `${enoughMs} ms after the first send was enough; refused at ` +
          `${
            spacing
              .filter((attempt) => !attempt.ok)
              .map((attempt) => `${attempt.sinceAcceptedMs}ms`)
              .join(', ') || 'no gap'
          }`,
    enoughMs !== undefined,
  );

  // ---- 5r. the USER OPERATION receipt -----------------------------------
  // The SEN-39 probe waited for a TRANSACTION receipt using this hash and timed
  // out every time. What exists on chain is a `UserOperationEvent`, and its own
  // `success` flag is the answer (gotcha 8).
  const { outcome, confirmMs } = await confirm(userOpHash);
  shapes.userOperation = outcome
    ? {
        ...outcome,
        blockNumber: `${outcome.blockNumber}`,
        actualGasCost: `${outcome.actualGasCost}`,
        actualGasUsed: `${outcome.actualGasUsed}`,
        confirmMs,
      }
    : null;
  report(
    '5r',
    'the USER OPERATION receipt, read from UserOperationEvent on chain',
    outcome
      ? `success=${outcome.success} tx=${outcome.transactionHash} block=${outcome.blockNumber} ` +
          `paymaster=${outcome.paymaster} gasCost=${outcome.actualGasCost} after ${confirmMs} ms`
      : `no UserOperationEvent within ${CONFIRM_TIMEOUT_MS} ms`,
    outcome?.success === true,
  );

  // Does OUR bundler know about an operation PRIVY's provider bundled? This is
  // the question that decides whether `PollingOperationTracker` can follow a
  // sponsored send with the Pimlico endpoint alone.
  const bundlerUrl =
    process.env['WALLET_BUNDLER_URL']?.trim() ||
    process.env['PIMLICO_BUNDLER_URL']?.trim() ||
    'https://public.pimlico.io/v2/10143/rpc';
  const bundlerAnswer = await fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getUserOperationReceipt',
      params: [userOpHash],
    }),
  })
    .then((response) => response.text())
    .catch((error: unknown) => `request failed: ${(error as Error).message}`);
  const bundlerKnows = /"success"\s*:/.test(bundlerAnswer);
  shapes.bundlerReceipt = bundlerAnswer.slice(0, 600);
  report(
    '5b',
    'does OUR bundler answer eth_getUserOperationReceipt for it?',
    `${bundlerKnows ? 'yes' : 'no'} — ${bundlerAnswer.slice(0, 200)}`,
    undefined,
  );

  // And the SECOND send, if one was accepted: two sponsored sends from one
  // wallet both landing is the acceptance criterion for the demo's second act.
  if (secondHash) {
    const second = await confirm(secondHash);
    shapes.secondUserOperation = second.outcome
      ? { ...second.outcome, blockNumber: `${second.outcome.blockNumber}` }
      : null;
    report(
      '6r',
      'the second send’s USER OPERATION receipt',
      second.outcome
        ? `success=${second.outcome.success} tx=${second.outcome.transactionHash} ` +
            `block=${second.outcome.blockNumber} after ${second.confirmMs} ms`
        : `no UserOperationEvent within ${CONFIRM_TIMEOUT_MS} ms`,
      second.outcome?.success === true,
    );
  }

  // ---- 7. delegation, and gotcha 9 from a DELEGATED wallet --------------
  const codeAfter = (await rpc.getCode({ address })) ?? '0x';
  const after = await getUserWallet(client, walletId);
  shapes.code = { before: codeBefore, after: codeAfter };
  report(
    '7',
    'address and code after the sends (EIP-7702 delegation)',
    `address ${address} → ${after.address}; code ${codeBefore} → ${codeAfter}`,
    isAddressEqual(getAddress(after.address), address),
  );

  const typed = typedDataPayload(USDC.address);
  let recovered: Address | undefined;
  let typedError: string | undefined;
  try {
    const signature = await signTypedData(client, {
      walletId,
      typedData: typed,
      approvals: [deviceKey],
    });
    shapes.typedDataSignature = { signature, bytes: (signature.length - 2) / 2 };
    recovered = await recoverTypedDataAddress({ ...typed, signature });
  } catch (error) {
    typedError = (error as Error).message;
  }
  report(
    '8',
    'eth_signTypedData_v4 from the DELEGATED wallet, then ecrecover (gotcha 9: Perpl)',
    recovered
      ? `recovered ${recovered} (${isAddressEqual(recovered, address) ? 'the wallet' : 'NOT the wallet'})`
      : `failed: ${typedError ?? 'unknown'}`,
    recovered !== undefined && isAddressEqual(recovered, address),
  );

  const end = await held();
  console.log(
    `\n        wallet now holds MON ${formatEther(end.mon)}  ` +
      `USDC ${formatUnits(end.usdc, USDC.decimals)}`,
  );
  shapes.balancesAfter = { mon: formatEther(end.mon), usdc: formatUnits(end.usdc, USDC.decimals) };
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
