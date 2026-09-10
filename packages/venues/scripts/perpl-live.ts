// Live end-to-end check of the Perpl adapter against Monad testnet.
//
//   PERPL_OWNER_PRIVATE_KEY=0x... node scripts/perpl-live.ts [--onboard]
//
// Without PERPL_OWNER_PRIVATE_KEY it falls back to PERPL_DEV_PRIVATE_KEY, the
// team's already-onboarded dev account (see .env.example).
//
// The key is the EOA that OWNS (or will own) the Perpl account — never a smart
// account: Perpl enrolls API keys by ecrecover only (see src/perpl/enroll.ts).
// It is read from the environment and never logged; only the derived address
// is printed. Every step below goes through the library, not through
// hand-rolled requests, so a green run is evidence for the code that ships.
//
// Costs: `--onboard` spends the venue minimum (100 AUSD on testnet) plus three
// transactions of MON. Trading costs no MON — orders are forwarded, and the
// exchange pays their gas — and a few cents of AUSD in fees.

import { createPublicClient, createWalletClient, formatUnits, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import {
  PERPL_EXCHANGE_ABI,
  PERPL_NETWORKS,
  PerplVenue,
  enrollApiKey,
  onboardingParams,
  perplOnboardingCalls,
  type PerplContext,
} from '../src/perpl/index.ts';

// `getPositionV2(perpId, accountId)` from PerplFoundation's IExchange — the
// contract's own view of a position, used to cross-check the socket's.
const POSITION_V2_ABI = [
  {
    type: 'function',
    name: 'getPositionV2',
    stateMutability: 'view',
    inputs: [
      { name: 'perpId', type: 'uint256' },
      { name: 'accountId', type: 'uint256' },
    ],
    outputs: [
      {
        name: 'positionInfo',
        type: 'tuple',
        components: [
          { name: 'accountId', type: 'uint256' },
          { name: 'nextNodeId', type: 'uint256' },
          { name: 'prevNodeId', type: 'uint256' },
          { name: 'positionType', type: 'uint8' },
          { name: 'depositCNS', type: 'uint256' },
          { name: 'pricePNS', type: 'uint256' },
          { name: 'lotLNS', type: 'uint256' },
          { name: 'entryBlock', type: 'uint256' },
          { name: 'pnlCNS', type: 'int256' },
          { name: 'deltaPnlCNS', type: 'int256' },
          { name: 'premiumPnlCNS', type: 'int256' },
          { name: 'priceResiduePNSQ16', type: 'uint256' },
        ],
      },
      { name: 'markPricePNS', type: 'uint256' },
      { name: 'markPriceValid', type: 'bool' },
    ],
  },
] as const;

// PERPL_DEV_PRIVATE_KEY (from .env) is the team's already-onboarded dev account.
const key = (
  process.env['PERPL_OWNER_PRIVATE_KEY'] ?? process.env['PERPL_DEV_PRIVATE_KEY']
)?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('set PERPL_OWNER_PRIVATE_KEY (or PERPL_DEV_PRIVATE_KEY) to the owning EOA key');
  process.exit(1);
}
const owner = privateKeyToAccount(key as Hex);
const network = PERPL_NETWORKS.testnet;
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const SYMBOL = 'BTC-PERP';
const BTC_PERP_ID = 16n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (label: string, value: unknown) =>
  console.log(`${label.padEnd(20)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const context = (await (await fetch(`${network.restUrl}/v1/pub/context`)).json()) as PerplContext;
const params = onboardingParams(context);
show('owner EOA', owner.address);

// --- 1. On-chain account (and onboarding, when asked) ----------------------
async function onChainAccount() {
  try {
    return await pub.readContract({
      address: params.exchange,
      abi: PERPL_EXCHANGE_ABI,
      functionName: 'getAccountByAddr',
      args: [owner.address],
    });
  } catch {
    return null; // reverts when the address has no account
  }
}
let account = await onChainAccount();
if (!account && process.argv.includes('--onboard')) {
  const wallet = createWalletClient({ account: owner, chain: monadTestnet, transport: http() });
  for (const call of perplOnboardingCalls(params)) {
    // Monad charges the gas LIMIT: use the node's measurement, never a multiple of it.
    const gas = await pub.estimateGas({ account: owner.address, to: call.to, data: call.data });
    const hash = await wallet.sendTransaction({ to: call.to, data: call.data, gas });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    show(`onboard ${call.data.slice(0, 10)}`, `${receipt.status} gas=${receipt.gasUsed} ${hash}`);
    if (receipt.status !== 'success') process.exit(1);
  }
  account = await onChainAccount();
}
if (!account) {
  console.error('no Perpl account for this address; rerun with --onboard');
  process.exit(1);
}
const accountId = account.accountId;
show(
  'on-chain account',
  `id=${accountId} balance=${formatUnits(account.balanceCNS, params.collateralDecimals)} AUSD`,
);

// --- 2. Enroll an API key through the library ------------------------------
const { credentials, info } = await enrollApiKey({
  restUrl: network.restUrl,
  chainId: network.chainId,
  signer: owner,
  label: `sente-live-${Date.now()}`,
});
show('enrolled key', { address: info.address, scope: info.scope_mask, origin: info.origin });

const venue = new PerplVenue({ credentials, network, defaultLeverage: 1 });
try {
  // --- 3. Signed REST: 200 proves the canonical string is byte-exact -------
  const history = await venue.rest.history<{ et: number }>('account-history', 5);
  show(
    'signed REST',
    `200, ${history.d.length} account events, clock offset ${Math.round(venue.rest.clock.offset)}ms`,
  );

  // --- 4. Reads (the trading socket signs in on first use) -----------------
  show('balances', await venue.getBalances());
  const state = venue.trading.accountState();
  show('WS signed in', `account ${state?.id} fw=${state?.fw} lfr=${state?.lfr}`);
  const markets = await venue.getMarkets();
  show('markets', `${markets.length}: ${markets.map((m) => m.symbol).join(' ')}`);
  show(
    'BTC market',
    markets.find((m) => m.symbol === SYMBOL),
  );
  const depth = await venue.getDepth({ symbol: SYMBOL, limit: 2 });
  show('depth (2 levels)', { bids: depth.bids, asks: depth.asks, sequence: depth.sequence });
  show('quote buy 0.001', await venue.quote({ symbol: SYMBOL, side: 'buy', size: '0.001' }));
  show('klines 1m x2', await venue.getKlines({ symbol: SYMBOL, interval: '1m', limit: 2 }));

  // --- 5. Resting order + cancel -------------------------------------------
  const bestBid = Number(depth.bids[0]?.price ?? '0');
  const restingPrice = (Math.floor(bestBid * 9) / 10).toFixed(1); // ~10% under the book
  const resting = await venue.placeLimit({
    symbol: SYMBOL,
    side: 'buy',
    size: '0.001',
    price: restingPrice,
    timeInForce: 'POST_ONLY',
  });
  show('limit placed', {
    id: resting.id,
    status: resting.status,
    price: resting.price,
    tx: resting.txHash,
  });
  show(
    'open orders',
    (await venue.getOpenOrders(SYMBOL)).map((o) => `${o.id}:${o.status}`),
  );
  const cancelled = await venue.cancel({ symbol: SYMBOL, orderId: resting.id });
  show('cancelled', { id: cancelled.id, status: cancelled.status, tx: cancelled.txHash });

  // --- 6. Open a small position, read it, close it -------------------------
  await venue.setLeverage({ symbol: SYMBOL, leverage: 5 });
  const opened = await venue.placeMarket({
    symbol: SYMBOL,
    side: 'buy',
    size: '0.001',
    maxSlippage: '0.005',
  });
  show('market buy', {
    status: opened.status,
    filled: opened.filledSize,
    avg: opened.averageFillPrice,
    tx: opened.txHash,
  });

  let [position] = await venue.getPositions(SYMBOL);
  for (let i = 0; !position && i < 20; i++) {
    await sleep(500);
    [position] = await venue.getPositions(SYMBOL);
  }
  if (!position) throw new Error('filled, but no position arrived on the socket');
  show('position', position);

  // Cross-check against the contract's own view of the same position.
  const raw = venue.trading.openPositions().find((p) => BigInt(p.mkt) === BTC_PERP_ID);
  const [onChain, markPNS] = await pub.readContract({
    address: params.exchange,
    abi: POSITION_V2_ABI,
    functionName: 'getPositionV2',
    args: [BTC_PERP_ID, accountId],
  });
  show('on-chain position', {
    depositCNS: onChain.depositCNS.toString(),
    pricePNS: onChain.pricePNS.toString(),
    lotLNS: onChain.lotLNS.toString(),
    pnlCNS: onChain.pnlCNS.toString(),
    deltaPnlCNS: onChain.deltaPnlCNS.toString(),
    premiumPnlCNS: onChain.premiumPnlCNS.toString(),
    markPricePNS: markPNS.toString(),
    socketMatchesChain:
      raw !== undefined &&
      BigInt(raw.c) === onChain.depositCNS &&
      BigInt(raw.ep) === onChain.pricePNS &&
      BigInt(raw.s) === onChain.lotLNS,
  });
  show('balances (open)', await venue.getBalances());

  const closed = await venue.closePosition({ symbol: SYMBOL });
  show('close', {
    status: closed.status,
    filled: closed.filledSize,
    avg: closed.averageFillPrice,
    tx: closed.txHash,
  });
  let remaining = await venue.getPositions(SYMBOL);
  for (let i = 0; remaining.length > 0 && i < 20; i++) {
    await sleep(500);
    remaining = await venue.getPositions(SYMBOL);
  }
  show('positions after', remaining.length);
  show('balances (closed)', await venue.getBalances());
} finally {
  venue.close();
}
