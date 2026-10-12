// Seeds empty Kuru Set C books with a small resting ladder from the treasury,
// so an agent hired on them has something to trade against (found while
// recording the demo, 2026-10-12: MON-USDC and WETH-USDC had no orders at all).
//
//   node --conditions=source --env-file=../../.env scripts/kuru-seed-books.ts \
//     --mid MON-USDC=0.026 --mid WETH-USDC=2555 [--levels 3] [--usdc 100] [--apply]
//
// Without --apply it only reads: balances, what each side needs, the plan.
// With it, it deposits what the plan needs into AccountCore and places GTC
// post-only-priced bids below and asks above the mid you give (take it from
// Perpl's mark so Kuru and Perpl agree). The key is TREASURY_PRIVATE_KEY,
// read from the environment and never logged — only its address.
//
// Every level is `--usdc` of notional, at mid × (1 ∓ step × i), step 0.5%.
// Re-running places another ladder; cancel by the ids it prints.

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import {
  KURU_DEPLOYMENTS,
  KuruVenue,
  type KuruExecution,
  type KuruSubmitter,
} from '../src/kuru/index.ts';

const STEP = 0.005;
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const levels = Number(opt('--levels', '3'));
const usdcPerLevel = Number(opt('--usdc', '100'));
const mids = new Map<string, number>();
argv.forEach((a, i) => {
  if (a === '--mid') {
    const [symbol, price] = (argv[i + 1] ?? '').split('=');
    if (!symbol || !Number(price)) throw new Error(`--mid wants SYMBOL=PRICE, got ${argv[i + 1]}`);
    mids.set(symbol, Number(price));
  }
});
if (mids.size === 0) throw new Error('give at least one --mid SYMBOL=PRICE');

const key = process.env['TREASURY_PRIVATE_KEY']?.trim();
if (!key) throw new Error('TREASURY_PRIVATE_KEY is not set');
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
const rpc = process.env['MONAD_TESTNET_RPC_URL'] ?? 'https://testnet-rpc.monad.xyz';
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
const deployment = KURU_DEPLOYMENTS['set-c'];

const submitter: KuruSubmitter = {
  address: account.address,
  async submit(calls): Promise<KuruExecution> {
    let hash: Hex = '0x';
    const logs = [];
    for (const call of calls) {
      const gas = await publicClient.estimateGas({
        account,
        to: call.to,
        data: call.data,
        value: call.value,
      });
      hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value, gas });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`    tx ${hash} ${receipt.status}`);
      if (receipt.status !== 'success')
        return { hash, transactionHash: hash, success: false, logs };
      logs.push(...receipt.logs);
    }
    return { hash, transactionHash: hash, success: true, logs };
  },
};
const venue = new KuruVenue({ publicClient, submitter, deployment });

const walletBalance = async (symbol: string): Promise<number> => {
  const token = deployment.tokens[symbol]!;
  if (symbol === 'MON')
    return Number(formatUnits(await publicClient.getBalance({ address: account.address }), 18));
  const raw = await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  return Number(formatUnits(raw, token.decimals));
};
const custody = new Map((await venue.getBalances()).map((b) => [b.asset, Number(b.total)]));

console.log(`treasury ${account.address}, Kuru ${deployment.id}, ${apply ? 'APPLY' : 'plan only'}`);
type Plan = { symbol: string; base: string; side: 'buy' | 'sell'; price: string; size: string };
const plan: Plan[] = [];
const need = new Map<string, number>();
for (const [symbol, mid] of mids) {
  const market = deployment.markets.find((m) => m.symbol === symbol);
  if (!market) throw new Error(`${symbol} is not a Set C market`);
  const base = market.base.symbol;
  const book = await venue.bookSnapshot(symbol);
  console.log(
    `${symbol}: ${book.bids.length} bid / ${book.asks.length} ask levels on the book now`,
  );
  for (let i = 1; i <= levels; i++) {
    for (const side of ['buy', 'sell'] as const) {
      const price = mid * (side === 'buy' ? 1 - STEP * i : 1 + STEP * i);
      const size = usdcPerLevel / price;
      const p = price.toPrecision(5);
      const s = size.toPrecision(4);
      plan.push({ symbol, base, side, price: p, size: s });
      const asset = side === 'buy' ? 'USDC' : base;
      need.set(asset, (need.get(asset) ?? 0) + (side === 'buy' ? usdcPerLevel : Number(s)));
    }
  }
}
let short = false;
for (const [asset, amount] of need) {
  const held = await walletBalance(asset);
  const inKuru = custody.get(asset) ?? 0;
  const gasReserve = asset === 'MON' ? 1 : 0;
  const ok = held + inKuru - gasReserve >= amount;
  if (!ok) short = true;
  console.log(
    `  ${asset}: need ${amount.toFixed(4)}, wallet ${held.toFixed(4)}, in Kuru ${inKuru.toFixed(4)} ${ok ? 'ok' : 'SHORT'}`,
  );
}
for (const p of plan) console.log(`  ${p.symbol} ${p.side} ${p.size} @ ${p.price}`);
if (!apply) process.exit(short ? 1 : 0);
if (short) throw new Error('not enough to fund the plan; nothing sent');

for (const [asset, amount] of need) {
  const inKuru = custody.get(asset) ?? 0;
  const top = amount - inKuru;
  if (top <= 0) continue;
  const amountStr = (top * 1.001).toFixed(asset === 'USDC' ? 2 : 6);
  console.log(`deposit ${amountStr} ${asset}`);
  await venue.deposit(asset, amountStr);
}
for (const p of plan) {
  const order = await venue.placeLimit({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    price: p.price,
    timeInForce: 'GTC',
    clientOrderId: `sente-seed-${Date.now()}`,
  });
  console.log(
    `placed ${p.symbol} ${p.side} ${p.size} @ ${p.price}: id ${order.id} tx ${order.txHash}`,
  );
}
