/**
 * Phone Kuru market facts tests (SEN-90). Plain node, no device, no network.
 *
 * The acceptance is agreement with the adapter: every pure result is checked
 * against `kuruSlippageBound` / `quoteReserveAtoms` from `@sente/venues/kuru`
 * on a shared grid, so the phone's bounds are exactly the server's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeNativeOrder,
  fromUnits,
  KURU_ACCOUNT_CORE_BALANCE_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  kuruSlippageBound,
  precisionDecimals,
  quoteReserveAtoms,
  toUnits,
  type KuruMarketParams,
} from '@sente/venues/kuru';
// Why the SDK directly: the read fragments are pinned against its full ABI.
import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import type { Abi, AbiFunction, Address } from 'viem';

import {
  depositCapAtoms,
  KURU_BALANCE_READ_ABI,
  KURU_MARKET_READ_ABI,
  KuruMarketError,
  readKuruFree,
  readMarketFacts,
  worstPriceUnits,
  type KuruReadClient,
  type KuruReserveOrder,
} from './kuruMarket.ts';

const MON_USDC = KURU_TESTNET_MARKETS.find((market) => market.symbol === 'MON-USDC')!;
const WALLET: Address = '0x1111111111111111111111111111111111111111';

function paramsOf(
  market: (typeof KURU_TESTNET_MARKETS)[number],
  tickSize = market.tickSize,
): KuruMarketParams {
  return {
    pricePrecision: market.pricePrecision,
    sizePrecision: market.sizePrecision,
    tickSize,
    minQuoteNotional: 0n,
    maxQuoteNotional: 2n ** 96n - 1n,
    takerFeePps: 3_000n,
    makerFeePps: 400n,
  };
}

// ---------------------------------------------------------------------------
// worstPriceUnits

test('worstPriceUnits matches kuruSlippageBound on every market, tick, side and slippage', () => {
  let cases = 0;
  for (const market of KURU_TESTNET_MARKETS) {
    const pd = precisionDecimals(market.pricePrecision);
    for (const tick of [market.tickSize, 5n, 7n, 100n]) {
      const params = paramsOf(market, tick);
      for (const best of [1n, 99n, 3_456n, 1_000_003n, 4_294_967_294n]) {
        for (const bps of [0, 1, 7, 50, 333, 1_000, 9_999]) {
          for (const side of ['buy', 'sell'] as const) {
            const adapter = kuruSlippageBound(best, side, fromUnits(BigInt(bps), 4), params);
            assert.equal(
              worstPriceUnits(best, bps, tick, side),
              toUnits(adapter, pd),
              `${market.symbol} tick ${tick} best ${best} ${bps}bps ${side}`,
            );
            cases++;
          }
        }
      }
    }
  }
  assert.ok(cases > 1000);
});

test('worstPriceUnits rounds against the trader', () => {
  // Buy: 1003 * 1.005 = 1008.015 -> 1008 -> floored to tick 5 = 1005.
  assert.equal(worstPriceUnits(1003n, 50, 5n, 'buy'), 1005n);
  // Sell: 1003 * 0.995 = 997.985 -> 998 -> ceiled to tick 5 = 1000.
  assert.equal(worstPriceUnits(1003n, 50, 5n, 'sell'), 1000n);
  assert.equal(worstPriceUnits(1000n, 0, 1n, 'buy'), 1000n);
});

test('worstPriceUnits refuses what it cannot bound', () => {
  assert.throws(() => worstPriceUnits(1000n, 10_000, 1n, 'sell'), KuruMarketError);
  assert.throws(() => worstPriceUnits(1000n, -1, 1n, 'buy'), KuruMarketError);
  assert.throws(() => worstPriceUnits(1000n, 0.5, 1n, 'buy'), KuruMarketError);
  assert.throws(() => worstPriceUnits(0n, 50, 1n, 'buy'), KuruMarketError);
  assert.throws(() => worstPriceUnits(1000n, 50, 0n, 'buy'), KuruMarketError);
});

// ---------------------------------------------------------------------------
// depositCapAtoms

test('a buy cap matches quoteReserveAtoms at the maker fee for GTC and taker for IOC/FOK', () => {
  for (const market of KURU_TESTNET_MARKETS) {
    const params = paramsOf(market);
    const decimals = { quote: market.quote.decimals, base: market.base.decimals };
    for (const [price, size] of [
      ['0.03', '100'],
      ['3.21', '1.5'],
      ['1234.56', '0.01'],
    ] as const) {
      for (const tif of ['GTC', 'IOC', 'FOK'] as const) {
        const native = encodeNativeOrder(
          { side: 'buy', price, size, timeInForce: tif },
          params,
          market.quote.decimals,
        );
        const order: KuruReserveOrder = {
          side: 'buy',
          price: native.price,
          quantity: native.quantity,
          tif: tif === 'GTC' ? 'gtc' : tif === 'IOC' ? 'ioc' : 'fok',
        };
        const fee = tif === 'GTC' ? params.makerFeePps : params.takerFeePps;
        assert.equal(
          depositCapAtoms(order, params, decimals),
          quoteReserveAtoms(native, params, market.quote.decimals, fee),
          `${market.symbol} ${price} x ${size} ${tif}`,
        );
      }
    }
  }
});

test('a sell cap is its base quantity in base atoms, rounded up', () => {
  for (const market of KURU_TESTNET_MARKETS) {
    const params = paramsOf(market);
    const decimals = { quote: market.quote.decimals, base: market.base.decimals };
    const native = encodeNativeOrder(
      { side: 'sell', price: '1', size: '0.5' },
      params,
      market.quote.decimals,
    );
    assert.equal(
      depositCapAtoms({ ...native, side: 'sell', tif: 'ioc' }, params, decimals),
      toUnits('0.5', market.base.decimals),
      market.symbol,
    );
  }
  // A size unit finer than a base atom rounds the reserve up, never down.
  const fine = { ...paramsOf(MON_USDC), sizePrecision: 1_000_000n };
  assert.equal(
    depositCapAtoms({ side: 'sell', price: 1n, quantity: 1_234_567n, tif: 'gtc' }, fine, {
      quote: 6,
      base: 4,
    }),
    12_346n,
  );
});

test('depositCapAtoms refuses an empty order', () => {
  const params = paramsOf(MON_USDC);
  const decimals = { quote: 6, base: 18 };
  assert.throws(
    () => depositCapAtoms({ side: 'buy', price: 1n, quantity: 0n, tif: 'gtc' }, params, decimals),
    KuruMarketError,
  );
  assert.throws(
    () => depositCapAtoms({ side: 'buy', price: 0n, quantity: 1n, tif: 'gtc' }, params, decimals),
    KuruMarketError,
  );
});

// ---------------------------------------------------------------------------
// Chain reads

function sdkFragment(abi: Abi, name: string): unknown {
  const fn = abi.find(
    (item): item is AbiFunction => item.type === 'function' && item.name === name,
  );
  assert.ok(fn, name);
  const strip = (params: readonly { name?: string; type: string }[]) =>
    params.map(({ name: paramName, type }) => ({ name: paramName, type }));
  return {
    type: fn.type,
    name: fn.name,
    stateMutability: fn.stateMutability,
    inputs: strip(fn.inputs),
    outputs: strip(fn.outputs),
  };
}

test('the read fragments are exactly the SDK functions', () => {
  for (const fragment of KURU_MARKET_READ_ABI) {
    assert.deepEqual(fragment, sdkFragment(kuruAbi.orderBookAbi as Abi, fragment.name));
  }
  // SEN-185: the root id by owner, then the balance by id.
  assert.deepEqual(
    KURU_BALANCE_READ_ABI[0],
    sdkFragment(kuruAbi.accountCoreAbi as Abi, 'rootAccountIdOf'),
  );
  assert.deepEqual(
    KURU_BALANCE_READ_ABI[1],
    sdkFragment(kuruAbi.accountCoreAbi as Abi, 'getBalance'),
  );
  assert.deepEqual(
    KURU_BALANCE_READ_ABI[1],
    sdkFragment(KURU_ACCOUNT_CORE_BALANCE_ABI, 'getBalance'),
  );
});

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

function fakeClient(results: Record<string, unknown>, calls: Call[] = []): KuruReadClient {
  return {
    readContract: (async (request: Call) => {
      calls.push(request);
      return results[request.functionName];
    }) as KuruReadClient['readContract'],
  };
}

// MON-USDC's precisions as the chain answers them since SEN-185 (size 10^6).
const RAW_PARAMS = [1_000_000, 1_000_000n, 1, 1_000_000n, 10n ** 12n, 3_000n, 400n] as const;

test('readMarketFacts decodes params and best prices from the market itself', async () => {
  const calls: Call[] = [];
  const facts = await readMarketFacts(
    fakeClient({ getMarketParams: RAW_PARAMS, bestBidAsk: [49_000, 51_000] }, calls),
    MON_USDC,
  );
  assert.deepEqual(facts, {
    params: {
      pricePrecision: 1_000_000n,
      sizePrecision: 1_000_000n,
      tickSize: 1n,
      minQuoteNotional: 1_000_000n,
      maxQuoteNotional: 10n ** 12n,
      takerFeePps: 3_000n,
      makerFeePps: 400n,
    },
    bestBid: 49_000n,
    bestAsk: 51_000n,
  });
  assert.ok(calls.every((call) => call.address === MON_USDC.address));
});

test('readMarketFacts turns empty-side sentinels into null', async () => {
  const facts = await readMarketFacts(
    fakeClient({ getMarketParams: RAW_PARAMS, bestBidAsk: [2 ** 32 - 1, 0] }),
    MON_USDC,
  );
  assert.equal(facts.bestBid, null);
  assert.equal(facts.bestAsk, null);
});

test('readMarketFacts refuses a market whose units differ from config', async () => {
  const wrong = [100, ...RAW_PARAMS.slice(1)];
  await assert.rejects(
    readMarketFacts(fakeClient({ getMarketParams: wrong, bestBidAsk: [1, 2] }), MON_USDC),
    KuruMarketError,
  );
});

test('readKuruFree reads the root id, then getBalance(rootId, token), on AccountCore', async () => {
  const calls: Call[] = [];
  const token = MON_USDC.quote.address;
  const free = await readKuruFree(
    fakeClient({ rootAccountIdOf: 63, getBalance: 42n }, calls),
    WALLET,
    token,
  );
  assert.equal(free, 42n);
  assert.ok(calls.every((call) => call.address === KURU_TESTNET_CONTRACTS.accountCore));
  assert.deepEqual(
    calls.map((call) => [call.functionName, call.args]),
    [
      ['rootAccountIdOf', [WALLET]],
      ['getBalance', [63, token]],
    ],
  );
});

test('readKuruFree: a wallet that never deposited holds nothing, and its balance is not read', async () => {
  const calls: Call[] = [];
  const free = await readKuruFree(
    fakeClient({ rootAccountIdOf: 0, getBalance: 42n }, calls),
    WALLET,
    MON_USDC.quote.address,
  );
  assert.equal(free, 0n);
  assert.deepEqual(
    calls.map((call) => call.functionName),
    ['rootAccountIdOf'],
  );
});
