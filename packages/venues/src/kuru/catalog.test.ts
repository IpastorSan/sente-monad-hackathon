/**
 * The catalog against the pins (SEN-185). Kuru redeployed its testnet books;
 * the Data Source stopped listing every pinned address, and `getMarkets`
 * answered `[]` for two weeks as if Kuru simply listed nothing. A pin the
 * catalog does not list is now named, and none listed at all is an error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PublicClient } from 'viem';

import { KuruCatalogError, KuruVenue } from './adapter.ts';
import type { ApiMarket } from './api.ts';
import { KURU_RETIRED_DEPLOYMENT, KURU_TESTNET_MARKETS } from './constants.ts';

function apiMarket(address: string, symbol: string): ApiMarket {
  return {
    marketAddress: address.toLowerCase(),
    symbol,
    baseToken: {
      tokenAddress: '0x0000000000000000000000000000000000000000',
      symbol: 'X',
      decimals: 18,
    },
    quoteToken: {
      tokenAddress: '0x0000000000000000000000000000000000000001',
      symbol: 'USDC',
      decimals: 6,
    },
    status: 'active',
    pricePrecision: '100',
    sizePrecision: '1000000',
    tickSize: '1',
    minQuoteNotionalX18: '10000000000000000000',
    takerFeePps: 7000,
    makerFeePps: 4000,
  };
}

function venueListing(listed: readonly ApiMarket[]): KuruVenue {
  const fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: listed }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return new KuruVenue({ publicClient: {} as PublicClient, api: { fetch } });
}

const current = (symbol: string) => KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol)!;

test('every pin listed: all markets, nothing missing', async () => {
  const venue = venueListing(KURU_TESTNET_MARKETS.map((m) => apiMarket(m.address, m.venueSymbol)));
  const { markets, missing } = await venue.listedMarkets();
  assert.deepEqual(
    markets.map((m) => m.symbol),
    KURU_TESTNET_MARKETS.map((m) => m.symbol),
  );
  assert.deepEqual(missing, []);
});

test('a pin the catalog dropped is named, and the rest still served', async () => {
  const mon = current('MON-USDC');
  const venue = venueListing([apiMarket(mon.address, mon.venueSymbol)]);
  const { markets, missing } = await venue.listedMarkets();
  assert.deepEqual(
    markets.map((m) => m.symbol),
    ['MON-USDC'],
  );
  assert.deepEqual(
    missing,
    KURU_TESTNET_MARKETS.filter((m) => m.symbol !== 'MON-USDC').map((m) => m.symbol),
  );
  assert.deepEqual(
    (await venue.getMarkets()).map((m) => m.symbol),
    ['MON-USDC'],
  );
});

test('a catalog listing none of the pins (a redeploy) is an error, not an empty venue', async () => {
  // What Kuru served before this fix landed: only books the pins do not name.
  const venue = venueListing(
    KURU_RETIRED_DEPLOYMENT.markets.map((m) => apiMarket(m.address, m.symbol)),
  );
  await assert.rejects(venue.getMarkets(), (error: unknown) => {
    assert.ok(error instanceof KuruCatalogError);
    assert.match(error.message, /^MON-USDC, WETH-USDC, .* not in Kuru catalog$/);
    return true;
  });
});
