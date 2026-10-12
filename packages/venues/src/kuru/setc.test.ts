/**
 * Set C, Kuru's previous testnet deployment (SEN-189), driven explicitly so it
 * runs whatever `KURU_DEPLOYMENT` this process has: the 0.0.4 address-keyed
 * custody calls, the market list from the pins with no catalog, the book from
 * the chain, no candles, no open-orders feed, and the builder fee against
 * Set C's AccountCore. Plain node, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeFunctionData, toFunctionSelector, type Address, type PublicClient } from 'viem';

import { KuruOpenOrdersUnavailableError, KuruVenue, type KuruSubmitter } from './adapter.ts';
import { KURU_DEPLOYMENTS, kuruCandleReference, NATIVE_TOKEN } from './constants.ts';
import {
  depositCalls,
  KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
  KURU_ACCOUNT_CORE_DEPOSIT_ABIS,
  KURU_ACCOUNT_CORE_WITHDRAW_ABIS,
  KuruOrderError,
  readKuruFreeAtoms,
  withdrawCall,
  type KuruCall,
  type KuruContractReader,
} from './orders.ts';

const SET_C = KURU_DEPLOYMENTS['set-c'];
const ACCOUNT_CORE = SET_C.contracts.accountCore;
const USDC = SET_C.tokens.USDC;
const OWNER: Address = '0x000000000000000000000000000000000000c0DE';
const CBBTC = SET_C.markets.find((m) => m.symbol === 'cbBTC-USDC')!;

/** `getMarketParams()` as Set C answers it for `symbol`'s pinned precisions. */
function params(address: Address): readonly bigint[] {
  const market = SET_C.markets.find((m) => m.address === address)!;
  return [
    market.pricePrecision,
    market.sizePrecision,
    1n,
    10_000_000n,
    5_000_000_000_000n,
    7000n,
    4000n,
  ];
}

type Read = { address: Address; functionName: string; args?: readonly unknown[] };

function setCVenue(
  reads: Read[],
  options: { submitter?: KuruSubmitter; fetch?: typeof globalThis.fetch; builder?: boolean } = {},
): KuruVenue {
  const publicClient = {
    readContract: (read: Read) => {
      reads.push(read);
      switch (read.functionName) {
        case 'getMarketParams':
          return Promise.resolve(params(read.address));
        case 'userRegistry':
          return Promise.resolve(62);
        case 'getL2Book':
          // cbBTC-USDC: two bids, one ask (price precision 100, size 10^8).
          return Promise.resolve([
            [11_000_000, 10_990_000],
            [5_000_000n, 1_000_000n],
            [11_010_000],
            [2_000_000n],
          ]);
        case 'getBalanceById':
          return Promise.resolve(25_000_000n);
        case 'getSpotReservedBalance':
          return Promise.resolve(5_000_000n);
        case 'getBuilderApproval':
          return Promise.resolve({ maxFeePps: 0, expiry: 0n, active: false });
        default:
          return Promise.reject(new Error(`unexpected read ${read.functionName}`));
      }
    },
  } as unknown as PublicClient;
  const noFetch = (() =>
    Promise.reject(new Error('Set C must not call Kuru’s APIs'))) as typeof fetch;
  return new KuruVenue({
    publicClient,
    deployment: SET_C,
    account: OWNER,
    submitter: options.submitter,
    api: { fetch: options.fetch ?? noFetch },
    now: () => 1_000_000_000,
    ...(options.builder
      ? {
          builder: {
            address: '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8' as Address,
            feePps: 10_000,
            approvalExpiry: { ttlSeconds: 365 * 86_400 },
          },
        }
      : {}),
  });
}

test('Set C custody ABIs are the 0.0.4 address-keyed shapes', () => {
  const selector = (abi: readonly unknown[]) =>
    toFunctionSelector(abi[0] as Parameters<typeof toFunctionSelector>[0]);
  assert.equal(
    selector(KURU_ACCOUNT_CORE_DEPOSIT_ABIS['address-keyed']),
    toFunctionSelector('deposit(address,uint256)'),
  );
  assert.equal(
    selector(KURU_ACCOUNT_CORE_WITHDRAW_ABIS['address-keyed']),
    toFunctionSelector('withdraw(address,uint256)'),
  );
  assert.equal(
    selector(KURU_ACCOUNT_CORE_DEPOSIT_ABIS['account-id']),
    toFunctionSelector('deposit(address,address,uint256)'),
  );
  assert.equal(
    selector(KURU_ACCOUNT_CORE_WITHDRAW_ABIS['account-id']),
    toFunctionSelector('withdraw(uint40,address,uint256,address)'),
  );
});

test('a Set C deposit is approve + deposit(token, amount): it cannot name another account', () => {
  const [approve, deposit] = depositCalls(ACCOUNT_CORE, USDC, 12_000_000n, OWNER, 'address-keyed');
  assert.equal(approve!.to, USDC.address);
  assert.equal(deposit!.to, ACCOUNT_CORE);
  const decoded = decodeFunctionData({
    abi: KURU_ACCOUNT_CORE_DEPOSIT_ABIS['address-keyed'],
    data: deposit!.data!,
  });
  assert.deepEqual(decoded.args, [USDC.address, 12_000_000n]);

  const [native] = depositCalls(ACCOUNT_CORE, SET_C.tokens.MON, 5n, OWNER, 'address-keyed');
  assert.equal(native!.value, 5n);
  assert.deepEqual(
    decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_DEPOSIT_ABIS['address-keyed'],
      data: native!.data!,
    }).args,
    [NATIVE_TOKEN, 5n],
  );
});

test('a Set C withdraw is withdraw(token, amount), paying the caller', () => {
  const call = withdrawCall(ACCOUNT_CORE, USDC, 7_000_000n, 62n, OWNER, 'address-keyed');
  assert.deepEqual(
    decodeFunctionData({ abi: KURU_ACCOUNT_CORE_WITHDRAW_ABIS['address-keyed'], data: call.data! })
      .args,
    [USDC.address, 7_000_000n],
  );
});

test('Set C balances read the id from userRegistry, then getBalanceById', async () => {
  const reads: Read[] = [];
  const reader = {
    readContract: (read: Read) => {
      reads.push(read);
      return Promise.resolve(read.functionName === 'userRegistry' ? 62 : 25_000_000n);
    },
  } as unknown as KuruContractReader;
  assert.equal(
    await readKuruFreeAtoms(reader, ACCOUNT_CORE, OWNER, USDC.address, 'address-keyed'),
    25_000_000n,
  );
  assert.deepEqual(
    reads.map((r) => [r.functionName, r.args]),
    [
      ['userRegistry', [OWNER]],
      ['getBalanceById', [62, USDC.address]],
    ],
  );
});

test('the market list is the pins, from their own params, with nothing missing and no API call', async () => {
  const reads: Read[] = [];
  const { markets, missing } = await setCVenue(reads).listedMarkets();
  assert.deepEqual(
    markets.map((m) => m.symbol),
    ['MON-USDC', 'WETH-USDC', 'cbBTC-USDC', 'XAUt-USDC'],
  );
  assert.deepEqual(missing, []);
  const cbBtc = markets.find((m) => m.symbol === 'cbBTC-USDC')!;
  assert.equal(cbBtc.minNotional, '10');
  assert.equal(cbBtc.tickSize, '0.01');
  assert.equal(cbBtc.stepSize, '0.00000001');
  assert.equal(cbBtc.takerFee, '0.0007');
  assert.equal(cbBtc.venueSymbol, 'CBBTCUSDC');
});

test('a pinned book whose units differ from the chain is left out, not mis-scaled', async () => {
  const publicClient = {
    readContract: (read: Read) =>
      read.functionName === 'getMarketParams' && read.address === CBBTC.address
        ? Promise.resolve([100n, 1n, 1n, 10_000_000n, 1n, 7000n, 4000n])
        : read.functionName === 'getMarketParams'
          ? Promise.resolve(params(read.address))
          : Promise.reject(new Error('no')),
  } as unknown as PublicClient;
  const skewed = new KuruVenue({ publicClient, deployment: SET_C });
  const { markets } = await skewed.listedMarkets();
  assert.ok(!markets.some((m) => m.symbol === 'cbBTC-USDC'));
  assert.equal(markets.length, 3);
});

test('depth comes from getL2Book; candles are honestly empty', async () => {
  const reads: Read[] = [];
  const venue = setCVenue(reads);
  const depth = await venue.getDepth({ symbol: 'cbBTC-USDC', limit: 1 });
  assert.deepEqual(depth.bids, [{ price: '110000', size: '0.05' }]);
  assert.deepEqual(depth.asks, [{ price: '110100', size: '0.02' }]);
  assert.ok(reads.some((r) => r.functionName === 'getL2Book' && r.address === CBBTC.address));
  assert.deepEqual(await venue.getKlines({ symbol: 'cbBTC-USDC', interval: '1h', limit: 24 }), []);
});

test('candle references: Set C maps each book to its Perpl perp, labelled; Set D has none', () => {
  const reason = 'Kuru set-c has no candle history';
  assert.deepEqual(kuruCandleReference('cbBTC-USDC', SET_C), {
    venue: 'perpl',
    symbol: 'BTC-PERP',
    reason,
  });
  assert.equal(kuruCandleReference('WETH-USDC', SET_C)?.symbol, 'ETH-PERP');
  assert.equal(kuruCandleReference('MON-USDC', SET_C)?.symbol, 'MON-PERP');
  // Perpl lists no gold perp.
  assert.equal(kuruCandleReference('XAUt-USDC', SET_C), null);
  // Every reference names a pinned Set C book.
  for (const symbol of Object.keys(SET_C.candleReferences ?? {})) {
    assert.ok(
      SET_C.markets.some((m) => m.symbol === symbol),
      symbol,
    );
  }
  // Kuru serves Set D's own candles, so nothing stands in for them.
  const SET_D = KURU_DEPLOYMENTS['set-d'];
  for (const m of SET_D.markets) assert.equal(kuruCandleReference(m.symbol, SET_D), null);
  assert.equal(setCVenue([]).candleReference('cbBTC-USDC')?.symbol, 'BTC-PERP');
  assert.throws(() => setCVenue([]).candleReference('NOPE-USDC'), KuruOrderError);
});

test('open orders: refused with a reason, not an empty list that reads as "none"', async () => {
  await assert.rejects(setCVenue([]).getOpenOrders(), KuruOpenOrdersUnavailableError);
});

test('balances: free by id, reserved by the owner address', async () => {
  const reads: Read[] = [];
  const balances = await setCVenue(reads).getBalances();
  const usdc = balances.find((b) => b.asset === 'USDC')!;
  assert.deepEqual(usdc, { asset: 'USDC', available: '25', locked: '5', total: '30' });
  const reserved = reads.find((r) => r.functionName === 'getSpotReservedBalance')!;
  assert.equal(reserved.args![0], OWNER);
});

test('withdrawCalls refuses a recipient other than the account: Set C pays only the caller', async () => {
  const venue = setCVenue([]);
  await assert.rejects(
    venue.withdrawCalls('USDC', '1', '0x000000000000000000000000000000000000bEEF'),
    KuruOrderError,
  );
  const [call] = await venue.withdrawCalls('USDC', '1');
  assert.deepEqual(
    decodeFunctionData({ abi: KURU_ACCOUNT_CORE_WITHDRAW_ABIS['address-keyed'], data: call!.data! })
      .args,
    [USDC.address, 1_000_000n],
  );
});

test('the builder fee approves Set C’s AccountCore before a builder order', async () => {
  const submitted: (readonly KuruCall[])[] = [];
  const submitter: KuruSubmitter = {
    address: OWNER,
    submit: (calls) => {
      submitted.push(calls);
      return Promise.resolve({ hash: '0x01', transactionHash: '0x01', success: true, logs: [] });
    },
  };
  const venue = setCVenue([], { submitter, builder: true });
  await venue.placeLimit({ symbol: 'cbBTC-USDC', side: 'buy', price: '100000', size: '0.0002' });
  const [approve, order] = submitted[0]!;
  assert.equal(approve!.to, ACCOUNT_CORE);
  assert.equal(
    decodeFunctionData({ abi: KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI, data: approve!.data! })
      .functionName,
    'approveBuilder',
  );
  assert.equal(order!.to, CBBTC.address);
  assert.equal(order!.data!.slice(0, 10), '0xed7dc4d7');
});
