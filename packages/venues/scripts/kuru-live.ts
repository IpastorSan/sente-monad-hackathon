// Live check of the Kuru adapter on Monad testnet: every Venue method, real
// transactions, real hashes.
//
//   KURU_TEST_PRIVATE_KEY=0x... node scripts/kuru-live.ts
//
// The key is read from the environment and never logged — only its address.
// It needs a little MON for gas and Kuru test USDC (the faucet pays 10,000 per
// address every 12 h; see src/kuru/constants.ts).
//
// WHICH ACCOUNT: this drives the adapter from a plain EOA, one transaction per
// call, because a Kernel account needs a bundler and a funded prefund on top.
// So the multi-call deposit here is NOT atomic, unlike the app's Kernel batch.
// The last step proves the Kernel half without spending anything: it wraps the
// adapter's own deposit+place call list in `encodeKernelExecute` and simulates
// it on a deployed Kernel v0.3.1 account, called from the EntryPoint.
//
// Optional: FIXTURE_OUT=/path.json writes the receipts' OrderBook logs, which
// is where `src/kuru/receipts.fixture.ts` came from.

import { writeFileSync } from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

// Script-only reach into the app: the encoder the Kernel account really uses.
import { encodeKernelExecute } from '../../../apps/mobile/src/wallet/batch.ts';
import {
  faucetClaimCall,
  KURU_FAUCET,
  KuruVenue,
  type KuruExecution,
  type KuruSubmitter,
} from '../src/kuru/index.ts';

const SYMBOL = 'MON-USDC';
const DEPOSIT_USDC = '30';
const ENTRY_POINT = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
/** Kernel v0.3.1 account deployed on testnet during MOV-253 (`kernel.test.ts`). */
const DEPLOYED_KERNEL = getAddress('0xEC4b217240f0292c65Bf136b341e400e2D28cA6F');

const key = process.env['KURU_TEST_PRIVATE_KEY']?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('set KURU_TEST_PRIVATE_KEY to a 0x-prefixed 32-byte hex key');
  process.exit(1);
}
const account = privateKeyToAccount(key as Hex);
const rpc = process.env['MONAD_TESTNET_RPC_URL'] ?? 'https://testnet-rpc.monad.xyz';
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });

let spent = 0n;
const fixtures: Record<string, { hash: Hex; logs: readonly Log[] }> = {};

/**
 * One transaction per call, gas set to the node's estimate as-is (Monad pads
 * its estimates already; see CLAUDE.md gotcha 4). An EOA has no inner
 * operation, so here the transaction receipt IS the answer.
 */
const submitter: KuruSubmitter = {
  address: account.address,
  async submit(calls): Promise<KuruExecution> {
    const logs: Log[] = [];
    let hash: Hex = '0x';
    for (const call of calls) {
      const gas = await publicClient.estimateGas({
        account,
        to: call.to,
        data: call.data,
        value: call.value,
      });
      hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value, gas });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      spent += receipt.gasUsed * receipt.effectiveGasPrice; // Monad reports gasUsed = gas limit
      console.log(`    tx ${hash}  ${receipt.status}  gas ${gas}`);
      if (receipt.status !== 'success') {
        return { hash, transactionHash: hash, success: false, logs };
      }
      logs.push(...receipt.logs);
    }
    return { hash, transactionHash: hash, success: true, logs };
  },
};

const venue = new KuruVenue({ publicClient, submitter });
const show = (label: string, value: unknown) =>
  console.log(
    label,
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the Gateway's projected open orders until `done` holds. */
async function waitForOpenOrders(done: (ids: string[]) => boolean): Promise<string[]> {
  for (let i = 0; i < 30; i++) {
    const ids = (await venue.getOpenOrders(SYMBOL)).map((order) => order.id);
    if (done(ids)) return ids;
    await sleep(1000);
  }
  throw new Error('Gateway never reflected the change within 30 s');
}

console.log(`account   ${account.address}`);
console.log(
  `MON       ${formatEther(await publicClient.getBalance({ address: account.address }))}`,
);

console.log('\n== reads');
const markets = await venue.getMarkets();
show(
  'getMarkets',
  markets.map(
    (m) => `${m.symbol} tick=${m.tickSize} step=${m.stepSize} minNotional=${m.minNotional}`,
  ),
);
const depth = await venue.getDepth({ symbol: SYMBOL, limit: 3 });
show('getDepth', depth);
const klines = await venue.getKlines({ symbol: SYMBOL, interval: '4h', limit: 2 });
show('getKlines 4h', klines);
show('getBalances before', await venue.getBalances());

console.log('\n== faucet');
const next = await publicClient.readContract({
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
  args: [account.address],
});
const now = BigInt(Math.floor(Date.now() / 1000));
if (next > now) {
  console.log(`  cooling down for another ${next - now}s — using USDC already held`);
} else {
  const claim = await submitter.submit([faucetClaimCall()]);
  console.log(`  claimed: ${claim.success}`);
}

console.log(`\n== deposit ${DEPOSIT_USDC} USDC into AccountCore (approve + deposit)`);
await venue.deposit('USDC', DEPOSIT_USDC);
console.log(`  accountId ${await venue.accountId()}`);
show(
  'getBalances after deposit',
  (await venue.getBalances()).filter((b) => b.asset === 'USDC' || b.asset === 'MON'),
);

console.log('\n== placeLimit: 500 MON bid at 0.02 — far below the book, so it must rest');
const limitOrder = await venue.placeLimit({
  symbol: SYMBOL,
  side: 'buy',
  size: '500',
  price: '0.02',
  timeInForce: 'GTC',
  clientOrderId: `sente-mov-254-${Date.now()}`,
});
show('  order', limitOrder);
fixtures['placeLimit'] = { hash: limitOrder.txHash as Hex, logs: [] };
const openIds = await waitForOpenOrders((ids) => ids.includes(limitOrder.id));
console.log(`  getOpenOrders sees it: ${JSON.stringify(openIds)}`);
show(
  '  locked after placing',
  (await venue.getBalances()).find((b) => b.asset === 'USDC'),
);

console.log('\n== cancel');
const cancelled = await venue.cancel({ symbol: SYMBOL, orderId: limitOrder.id });
show('  order', cancelled);
fixtures['cancel'] = { hash: cancelled.txHash as Hex, logs: [] };
await waitForOpenOrders((ids) => !ids.includes(limitOrder.id));
console.log('  getOpenOrders no longer lists it');

console.log('\n== cancel again: must be a no-op, not a second transaction');
show(
  '  order',
  await venue.cancel({ symbol: SYMBOL, orderId: limitOrder.id }).catch((e: Error) => e.message),
);

console.log('\n== quote + placeMarket: buy ~12 USDC of MON as IOC, 2% slippage bound');
const bestAsk = Number((await venue.getDepth({ symbol: SYMBOL, limit: 1 })).asks[0]?.price);
const size = String(Math.ceil(12 / bestAsk));
show('  quote', await venue.quote({ symbol: SYMBOL, side: 'buy', size }));
const marketOrder = await venue.placeMarket({
  symbol: SYMBOL,
  side: 'buy',
  size,
  maxSlippage: '0.02',
});
show('  order', marketOrder);
fixtures['placeMarket'] = { hash: marketOrder.txHash as Hex, logs: [] };
show(
  'getBalances after fill',
  (await venue.getBalances()).filter((b) => b.asset === 'USDC' || b.asset === 'MON'),
);

console.log('\n== Kernel: adapter calls inside encodeKernelExecute, simulated from the EntryPoint');
const kernelCalls = [
  faucetClaimCall(),
  ...venue.depositCalls('USDC', '20'),
  ...(await venue.limitOrderCalls({ symbol: SYMBOL, side: 'buy', size: '500', price: '0.02' })),
];
const kernelCallData = encodeKernelExecute(kernelCalls);
await publicClient.call({ account: ENTRY_POINT, to: DEPLOYED_KERNEL, data: kernelCallData });
const kernelGas = await publicClient.estimateGas({
  account: ENTRY_POINT,
  to: DEPLOYED_KERNEL,
  data: kernelCallData,
});
console.log(
  `  ${kernelCalls.length} legs (claim, approve, deposit, place) on ${DEPLOYED_KERNEL}: OK, ~${kernelGas} gas`,
);

if (process.env['FIXTURE_OUT']) {
  for (const [name, entry] of Object.entries(fixtures)) {
    const receipt = await publicClient.getTransactionReceipt({ hash: entry.hash });
    fixtures[name] = { hash: entry.hash, logs: receipt.logs };
  }
  writeFileSync(
    process.env['FIXTURE_OUT'],
    JSON.stringify(
      { accountId: String(await venue.accountId()), fixtures },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
}

console.log(`\nMON spent on gas: ${formatEther(spent)}`);
console.log(
  `MON left:         ${formatEther(await publicClient.getBalance({ address: account.address }))}`,
);
