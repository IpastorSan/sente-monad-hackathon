// Lands the Kuru onboarding batch as a REAL UserOperation on a Kernel account:
// faucet claim -> USDC approve -> AccountCore deposit -> resting GTC order, one
// ERC-7579 batch through the app's own `encodeKernelExecute`. Then, if the
// budget allows, cancels the order in a second UserOperation through
// `KuruVenue.cancel` — the adapter's real write path.
//
//   TREASURY_PRIVATE_KEY=0x... node scripts/kuru-kernel-userop.ts
//
// SELF-BUNDLED. The treasury EOA calls `EntryPoint.handleOps` itself. Each
// UserOperation bids `maxFeePerGas = 0`, so its required prefund is zero: the
// account needs no MON and nothing is left stranded as an EntryPoint deposit
// (CLAUDE.md gotcha 4). The treasury pays only the outer transaction, whose
// gas is the node's estimate for the signed `handleOps` call.
//
// SUCCESS comes from `UserOperationEvent.success`, never the transaction
// status — a reverted UserOperation still rides in a `status: 0x1` transaction
// (CLAUDE.md gotcha 8). Both are printed.
//
// THE ACCOUNT is 0xEC4b…A6F from `kernel.test.ts`, owned by Anvil default key
// #1. That key is public: anyone can drive this account. Only worthless test
// tokens ever go near it. Never fund an account derived from a default key.
//
// MON_CAP (default 0.128) stops the script before any send that would push the
// total fee above it.

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import {
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

// Script-only reach into the app: the account and encoder users really have.
import { encodeKernelExecute, isSameCallData } from '../../../apps/mobile/src/wallet/batch.ts';
import { toSenteKernelAccount } from '../../../apps/mobile/src/wallet/kernel.ts';
import {
  decodeOrderOutcome,
  faucetClaimCall,
  KURU_FAUCET,
  KuruVenue,
  type KuruCall,
  type KuruExecution,
  type KuruSubmitter,
} from '../src/kuru/index.ts';

const SYMBOL = 'MON-USDC';
/** Anvil default account #1 — PUBLIC. Owner of the kernel.test.ts vector account. */
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EXPECTED_KERNEL = getAddress('0xEC4b217240f0292c65Bf136b341e400e2D28cA6F');
/** Measured on Monad testnet for a deployed Kernel v0.3.1 (CLAUDE.md gotcha 4). */
const VERIFICATION_GAS_LIMIT = 220_000n;
/** We are the beneficiary, so this only has to satisfy the EntryPoint. */
const PRE_VERIFICATION_GAS = 21_000n;
const INTRINSIC_GAS = 21_000n;

const cap = parseEther(process.env['MON_CAP'] ?? '0.128');
const rawKey = process.env['TREASURY_PRIVATE_KEY']?.trim().replace(/^["']|["']$/g, '');
if (!rawKey) {
  console.error('set TREASURY_PRIVATE_KEY');
  process.exit(1);
}
const treasury = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex);
const rpc = process.env['MONAD_TESTNET_RPC_URL'] ?? 'https://testnet-rpc.monad.xyz';
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const wallet = createWalletClient({ account: treasury, chain: monadTestnet, transport: http(rpc) });

const kernel = await toSenteKernelAccount({
  client: publicClient,
  owner: privateKeyToAccount(ANVIL_KEY_1),
});
if (kernel.address !== EXPECTED_KERNEL) {
  throw new Error(`derived ${kernel.address}, expected ${EXPECTED_KERNEL}`);
}
if (!(await publicClient.getCode({ address: kernel.address }))) {
  throw new Error('Kernel account is not deployed; this script only covers the deployed case');
}

let spent = 0n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends from the treasury, retrying when a concurrent sender took the nonce. */
async function sendFromTreasury(data: Hex, gas: bigint): Promise<Hex> {
  for (let attempt = 1; ; attempt++) {
    try {
      const nonce = await publicClient.getTransactionCount({
        address: treasury.address,
        blockTag: 'pending',
      });
      return await wallet.sendTransaction({ to: entryPoint07Address, data, gas, nonce });
    } catch (error) {
      const message = String(error);
      if (attempt < 6 && /nonce too low|replacement|underpriced|already known/i.test(message)) {
        console.log(`    nonce contention (attempt ${attempt}), retrying`);
        await sleep(1500);
        continue;
      }
      throw error;
    }
  }
}

/**
 * A `KuruSubmitter` that lands a call list as one self-bundled UserOperation
 * and reports the UserOperation's own outcome.
 */
const submitter: KuruSubmitter = {
  address: kernel.address,
  async submit(calls: readonly KuruCall[]): Promise<KuruExecution> {
    const callData = encodeKernelExecute(calls);
    // The encoder under test must agree with what the Kernel library would sign.
    const libraryCallData = await kernel.encodeCalls(
      calls.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data ?? '0x' })),
    );
    if (!isSameCallData(callData, libraryCallData)) {
      throw new Error('encodeKernelExecute disagrees with permissionless; refusing to sign');
    }

    // Measured, not padded: the execution cost of this exact callData, called
    // from the EntryPoint as handleOps will, minus the intrinsic 21k that an
    // inner call does not pay.
    const executeGas = await publicClient.estimateGas({
      account: entryPoint07Address,
      to: kernel.address,
      data: callData,
    });
    const userOperation: UserOperation<'0.7'> = {
      sender: kernel.address,
      nonce: await kernel.getNonce(),
      callData,
      callGasLimit: executeGas - INTRINSIC_GAS,
      verificationGasLimit: VERIFICATION_GAS_LIMIT,
      preVerificationGas: PRE_VERIFICATION_GAS,
      maxFeePerGas: 0n, // zero prefund: the account pays nothing, nothing strands
      maxPriorityFeePerGas: 0n,
      signature: '0x',
    };
    userOperation.signature = await kernel.signUserOperation(userOperation);
    const userOpHash = getUserOperationHash({
      userOperation,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      chainId: monadTestnet.id,
    });

    const data = encodeFunctionData({
      abi: entryPoint07Abi,
      functionName: 'handleOps',
      args: [[toPackedUserOperation(userOperation)], treasury.address],
    });
    // Reverts here on any AA-level failure (bad signature, nonce, gas), before
    // a single wei is spent.
    await publicClient.call({ account: treasury, to: entryPoint07Address, data });
    const gas = await publicClient.estimateGas({
      account: treasury,
      to: entryPoint07Address,
      data,
    });
    const price = await publicClient.getGasPrice();
    const fee = gas * price;
    console.log(
      `    userOp ${userOpHash}\n    callGasLimit ${userOperation.callGasLimit}, handleOps gas ${gas}, fee ≤ ${formatEther(fee)} MON`,
    );
    if (spent + fee > cap) {
      throw new Error(
        `refusing: ${formatEther(spent + fee)} MON would exceed the ${formatEther(cap)} MON cap`,
      );
    }

    const transactionHash = await sendFromTreasury(data, gas);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    spent += receipt.gasUsed * receipt.effectiveGasPrice; // Monad reports gasUsed = limit

    // Find this UserOperation's own event; its success flag is the answer.
    let success: boolean | undefined;
    let eventIndex = -1;
    receipt.logs.forEach((log, index) => {
      if (log.address.toLowerCase() !== entryPoint07Address.toLowerCase()) return;
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        if (event.eventName === 'UserOperationEvent' && event.args.userOpHash === userOpHash) {
          success = event.args.success;
          eventIndex = index;
        }
        if (
          event.eventName === 'UserOperationRevertReason' &&
          event.args.userOpHash === userOpHash
        ) {
          console.log(`    UserOperationRevertReason ${event.args.revertReason}`);
        }
      } catch {
        // not an EntryPoint event
      }
    });
    if (success === undefined) {
      throw new Error(`no UserOperationEvent for ${userOpHash} in ${transactionHash}`);
    }
    console.log(`    bundle tx ${transactionHash}`);
    console.log(`    tx status            = ${receipt.status}`);
    console.log(`    UserOperation success = ${success}   <- the one that counts`);

    // One operation per bundle, so its logs are everything before its event.
    const logs: Log[] = receipt.logs.slice(0, eventIndex);
    return { hash: userOpHash, transactionHash, success, logs };
  },
};

const venue = new KuruVenue({ publicClient, submitter });

console.log(`treasury  ${treasury.address}`);
console.log(`kernel    ${kernel.address} (owner: Anvil default #1 — public key)`);
console.log(`cap       ${formatEther(cap)} MON`);

const nextClaimAt = await publicClient.readContract({
  address: KURU_FAUCET.address,
  abi: [
    {
      type: 'function',
      name: 'nextClaimAt',
      stateMutability: 'view',
      inputs: [{ type: 'address' }],
      outputs: [{ type: 'uint256' }],
    },
  ],
  functionName: 'nextClaimAt',
  args: [kernel.address],
});
if (nextClaimAt > BigInt(Math.floor(Date.now() / 1000))) {
  throw new Error(`the Kernel account's faucet cooldown runs until ${nextClaimAt}`);
}

console.log('\n== UserOperation 1: claim -> approve -> deposit -> resting GTC bid');
const onboard = await submitter.submit([
  faucetClaimCall(),
  ...venue.depositCalls('USDC', '20'),
  ...(await venue.limitOrderCalls({ symbol: SYMBOL, side: 'buy', size: '500', price: '0.02' })),
]);
if (!onboard.success) {
  console.error('\nUserOperation 1 reverted. Nothing landed; stopping.');
  process.exit(1);
}
const accountId = await venue.accountId();
const outcome = decodeOrderOutcome(onboard.logs, venue.market(SYMBOL).address, accountId);
console.log(
  `    AccountCore id ${accountId}; resting: ${JSON.stringify(outcome.rested, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
);
const rested = outcome.rested[0];
if (!rested) {
  console.error('    the order did not rest');
  process.exit(1);
}
const orderId = `${rested.slotIdx}:${rested.orderId}`;
console.log(
  `    balances ${JSON.stringify((await venue.getBalances()).find((b) => b.asset === 'USDC'))}`,
);

console.log('\n== UserOperation 2: KuruVenue.cancel through the same submitter');
try {
  const cancelled = await venue.cancel({ symbol: SYMBOL, orderId });
  console.log(`    order ${cancelled.id} -> ${cancelled.status}`);
} catch (error) {
  console.log(`    skipped: ${(error as Error).message}`);
}

console.log(`\nMON spent on gas: ${formatEther(spent)}`);
const address: Address = kernel.address;
console.log(`kernel MON after: ${formatEther(await publicClient.getBalance({ address }))}`);
