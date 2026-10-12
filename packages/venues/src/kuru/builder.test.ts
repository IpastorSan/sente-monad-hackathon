/**
 * Builder fees (SEN-184): the builder `batch` overloads, `approveBuilder`, the
 * approval check, and the fee read back off AccountCore's events. Plain node,
 * no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { KuruVenue, type KuruSubmitter } from './adapter.ts';
import { KURU_DEPLOYMENTS, KURU_TESTNET_CONTRACTS, KURU_TESTNET_MARKETS } from './constants.ts';
import {
  approveBuilderCall,
  baseValueInQuoteAtoms,
  builderApprovalCovers,
  builderFeeAtoms,
  builderFeeReport,
  builderFeesByAsset,
  builderFeeToken,
  decodeBuilderFees,
  encodeNativeOrder,
  KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_ORDERBOOK_BUILDER_BATCH_ABI,
  KuruOrderError,
  placeOrderCall,
  type KuruCall,
  type KuruLog,
  type KuruMarketParams,
} from './orders.ts';

const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const BUILDER: Address = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8';
const SENTE_FEE = { address: BUILDER, feePps: 10_000 } as const;

const PARAMS: KuruMarketParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 1_000_000n, // MON-USDC, as the chain answers it (SEN-185)
  tickSize: 1n,
  minQuoteNotional: 10_000_000n,
  maxQuoteNotional: 5_000_000_000_000n,
  takerFeePps: 7000n,
  makerFeePps: 4000n,
};

const ORDER = encodeNativeOrder({ side: 'buy', price: '0.02', size: '500' }, PARAMS, 6);
const CLIENT_ID = `0x${'ab'.repeat(32)}` as Hex;

test('the builder overloads are cut apart from the plain ones, two each', () => {
  const signatures = (abi: readonly unknown[]) =>
    abi.map((fn) => toFunctionSelector(fn as Parameters<typeof toFunctionSelector>[0])).sort();
  assert.deepEqual(signatures(KURU_ORDERBOOK_BATCH_ABI), ['0x0a7e0c6f', '0x6947f147']);
  assert.deepEqual(signatures(KURU_ORDERBOOK_BUILDER_BATCH_ABI), ['0x2975ed7e', '0xed7dc4d7']);
  assert.equal(
    toFunctionSelector(
      KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI[0] as Parameters<typeof toFunctionSelector>[0],
    ),
    toFunctionSelector('approveBuilder(address,uint32,uint64)'),
  );
});

test('without a builder the order keeps the plain overloads', () => {
  assert.equal(placeOrderCall(MON_USDC.address, ORDER).data!.slice(0, 10), '0x0a7e0c6f');
  assert.equal(placeOrderCall(MON_USDC.address, ORDER, CLIENT_ID).data!.slice(0, 10), '0x6947f147');
});

test('a builder selects the builderConfig overload and carries builder and rate', () => {
  const plain = placeOrderCall(MON_USDC.address, ORDER, undefined, SENTE_FEE);
  assert.equal(plain.data!.slice(0, 10), '0xed7dc4d7');
  const withId = placeOrderCall(MON_USDC.address, ORDER, CLIENT_ID, SENTE_FEE);
  assert.equal(withId.data!.slice(0, 10), '0x2975ed7e');

  const decoded = decodeFunctionData({ abi: KURU_ORDERBOOK_BUILDER_BATCH_ABI, data: withId.data! });
  const args = decoded.args as readonly unknown[];
  assert.equal(args[0], 0); // userId 0: the calling account
  assert.equal(args[3], CLIENT_ID);
  assert.deepEqual(args[4], { builder: BUILDER, feePps: 10_000 });
  assert.equal(withId.value, 0n);
});

test('approveBuilder: to AccountCore, the builder, the rate and the expiry, no value', () => {
  const call = approveBuilderCall(ACCOUNT_CORE, BUILDER, 10_000, 1_800_000_000n);
  assert.equal(call.to, ACCOUNT_CORE);
  assert.equal(call.value, 0n);
  const decoded = decodeFunctionData({
    abi: KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
    data: call.data!,
  });
  assert.deepEqual(decoded.args, [BUILDER, 10_000, 1_800_000_000n]);
});

test('approveBuilder refuses a rate outside Kuru’s range and a zero expiry', () => {
  assert.throws(() => approveBuilderCall(ACCOUNT_CORE, BUILDER, 0, 1n), KuruOrderError);
  assert.throws(() => approveBuilderCall(ACCOUNT_CORE, BUILDER, 100_001, 1n), KuruOrderError);
  assert.throws(() => approveBuilderCall(ACCOUNT_CORE, BUILDER, 10_000, 0n), KuruOrderError);
});

test('an approval covers an order only while active, at the rate, and not about to lapse', () => {
  const now = 1_000_000;
  const good = { active: true, maxFeePps: 10_000, expiry: BigInt(now + 7 * 86_400) };
  assert.equal(builderApprovalCovers(good, 10_000, now, 86_400), true);
  assert.equal(builderApprovalCovers({ ...good, active: false }, 10_000, now, 86_400), false);
  assert.equal(builderApprovalCovers({ ...good, maxFeePps: 9_999 }, 10_000, now, 86_400), false);
  assert.equal(
    builderApprovalCovers({ ...good, expiry: BigInt(now + 3600) }, 10_000, now, 86_400),
    false,
  );
});

test('builderFeeAtoms: 10 bps of 20 USDC is 0.02 USDC, a fractional atom rounds up', () => {
  assert.equal(builderFeeAtoms(20_000_000n, 10_000), 20_000n);
  assert.equal(builderFeeAtoms(1_001n, 10_000), 2n);
  assert.equal(builderFeeAtoms(0n, 10_000), 0n);
});

function feeLog(builder: Address, asset: Address, taker: bigint, amount: bigint): KuruLog {
  const topics = encodeEventTopics({
    abi: kuruAbi.accountCoreAbi,
    eventName: 'BuilderFeeAccrued',
    args: { builder, asset, takerAccountId: Number(taker) },
  }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint24' }, { type: 'uint256' }],
    [MON_USDC.address, 10_000, amount],
  );
  return { address: ACCOUNT_CORE, topics, data };
}

test('decodeBuilderFees: only this builder, this taker, and AccountCore’s own logs', () => {
  const usdc = MON_USDC.quote.address;
  const other: Address = '0x000000000000000000000000000000000000bEEF';
  const logs = [
    feeLog(BUILDER, usdc, 63n, 20_000n),
    feeLog(other, usdc, 63n, 999n),
    feeLog(BUILDER, usdc, 64n, 999n),
    { ...feeLog(BUILDER, usdc, 63n, 999n), address: other },
  ];
  assert.deepEqual(decodeBuilderFees(logs, ACCOUNT_CORE, BUILDER, 63n), [
    { asset: usdc, amount: 20_000n },
  ]);
});

/**
 * The one `BuilderFeeAccrued` of tx 0xca084e71…e8dbe8 (Kuru Set C,
 * 2026-10-12, block 0x43163b8, log 0x18), copied from its receipt: a taker
 * BUY of 0.00012505 cbBTC on cbBTC-USDC at Sente's 10,000 pps paid the
 * builder 13 atoms of cbBTC — the asset it received — and no USDC (SEN-195).
 */
const SET_C = KURU_DEPLOYMENTS['set-c'];
const CBBTC_USDC = SET_C.markets.find((m) => m.symbol === 'cbBTC-USDC')!;
const LIVE_BUY_FEE_LOG: KuruLog = {
  address: '0x6384e9b2bf3b65e1535403a0a543b5fda905ee22',
  topics: [
    '0x8d2fa5f5c7c31ed63bbcfffde6fe2127ffcd54f298ab243ed830977c884635a2',
    '0x00000000000000000000000093e6b8d57dca7b72fae80adaa5c9d7308f7e33b8',
    '0x000000000000000000000000ef2a20a161ac9ed1117d721336226b6399f15b4d',
    '0x0000000000000000000000000000000000000000000000000000000000000040',
  ],
  // orderBook (cbBTC-USDC), builderFeePps (uint24 10000), amount (13).
  data: ('0x0000000000000000000000005bdea6f9f9aba34f4ecb9b865646a792b835ef7f' +
    '0000000000000000000000000000000000000000000000000000000000002710' +
    '000000000000000000000000000000000000000000000000000000000000000d') as Hex,
};

test('the live buy’s BuilderFeeAccrued: 13 atoms of cbBTC, the base it bought, none of USDC', () => {
  assert.equal(SET_C.contracts.accountCore.toLowerCase(), LIVE_BUY_FEE_LOG.address);
  assert.equal(CBBTC_USDC.address.toLowerCase(), '0x5bdea6f9f9aba34f4ecb9b865646a792b835ef7f');
  const paid = builderFeesByAsset([LIVE_BUY_FEE_LOG], SET_C.contracts.accountCore, BUILDER, 64n);
  assert.deepEqual(paid, [{ asset: CBBTC_USDC.base.address, amount: 13n }]);
  assert.equal(CBBTC_USDC.base.symbol, 'cbBTC');
  // The taker was account 64, not 63; and only AccountCore's own log counts.
  assert.deepEqual(
    decodeBuilderFees([LIVE_BUY_FEE_LOG], SET_C.contracts.accountCore, BUILDER, 63n),
    [],
  );
  assert.deepEqual(decodeBuilderFees([LIVE_BUY_FEE_LOG], ACCOUNT_CORE, BUILDER, 64n), []);
  // 10 bps of the 12,505 atoms bought is 12.505, charged as 13: rounded up.
  assert.equal(builderFeeAtoms(12_505n, 10_000), 13n);

  const report = builderFeeReport(paid, 'buy', CBBTC_USDC, '110000');
  assert.deepEqual(report, { fee: '0.00000013', asset: 'cbBTC', quoteEstimate: '0.0143' });
});

test('builderFeesByAsset totals each asset separately, in first-seen order', () => {
  const usdc = MON_USDC.quote.address;
  const mon = MON_USDC.base.address;
  const logs = [
    feeLog(BUILDER, mon, 63n, 5n),
    feeLog(BUILDER, usdc, 63n, 7n),
    feeLog(BUILDER, mon, 63n, 6n),
    feeLog(BUILDER, usdc, 99n, 1_000n),
  ];
  assert.deepEqual(builderFeesByAsset(logs, ACCOUNT_CORE, BUILDER, 63n), [
    { asset: mon, amount: 11n },
    { asset: usdc, amount: 7n },
  ]);
});

test('the fee token is the one the taker receives: base on a buy, quote on a sell', () => {
  assert.equal(builderFeeToken('buy', CBBTC_USDC), CBBTC_USDC.base);
  assert.equal(builderFeeToken('sell', CBBTC_USDC), CBBTC_USDC.quote);
});

test('builderFeeReport: a sell’s fee is in USDC and is its own quote estimate', () => {
  const usdc = CBBTC_USDC.quote;
  const report = builderFeeReport([{ asset: usdc.address, amount: 13_750n }], 'sell', CBBTC_USDC);
  assert.deepEqual(report, { fee: '0.01375', asset: 'USDC', quoteEstimate: '0.01375' });
});

test('builderFeeReport: nothing taken reads 0 of the received token; a base fee without a price has no ≈', () => {
  assert.deepEqual(builderFeeReport([], 'buy', CBBTC_USDC), {
    fee: '0',
    asset: 'cbBTC',
    quoteEstimate: '0',
  });
  assert.deepEqual(builderFeeReport([], 'sell', CBBTC_USDC), {
    fee: '0',
    asset: 'USDC',
    quoteEstimate: '0',
  });
  assert.deepEqual(
    builderFeeReport([{ asset: CBBTC_USDC.base.address, amount: 13n }], 'buy', CBBTC_USDC),
    { fee: '0.00000013', asset: 'cbBTC' },
  );
});

test('builderFeeReport reads whichever pair token AccountCore named, not the one it expects', () => {
  const usdc = CBBTC_USDC.quote;
  assert.deepEqual(
    builderFeeReport([{ asset: usdc.address, amount: 20_000n }], 'buy', CBBTC_USDC),
    {
      fee: '0.02',
      asset: 'USDC',
      quoteEstimate: '0.02',
    },
  );
});

test('baseValueInQuoteAtoms values base atoms at a decimal price, rounded up', () => {
  // 13 cbBTC atoms (8 decimals) at 110,000.5 USDC: 0.01430065 -> 0.014301.
  assert.equal(baseValueInQuoteAtoms(13n, 8, '110000.5', 6), 14_301n);
  assert.equal(baseValueInQuoteAtoms(0n, 8, '110000', 6), 0n);
  assert.equal(baseValueInQuoteAtoms(10n ** 18n, 18, '0.02', 6), 20_000n);
});

function builderVenue(
  approval: { maxFeePps: number; expiry: bigint; active: boolean },
  submitter: KuruSubmitter,
  nowMs: number,
  reads: string[] = [],
): KuruVenue {
  const publicClient = {
    readContract: ({ functionName }: { functionName: string }) => {
      reads.push(functionName);
      if (functionName === 'getBuilderApproval') return Promise.resolve(approval);
      if (functionName === 'rootAccountIdOf') return Promise.resolve(63);
      if (functionName === 'getMarketParams') {
        return Promise.resolve([
          PARAMS.pricePrecision,
          PARAMS.sizePrecision,
          PARAMS.tickSize,
          PARAMS.minQuoteNotional,
          PARAMS.maxQuoteNotional,
          PARAMS.takerFeePps,
          PARAMS.makerFeePps,
        ]);
      }
      return Promise.reject(new Error(`unexpected read ${functionName}`));
    },
  } as unknown as PublicClient;
  return new KuruVenue({
    publicClient,
    submitter,
    now: () => nowMs,
    builder: { ...SENTE_FEE, approvalExpiry: { at: 1_900_000_000n } },
  });
}

function capturing(logs: readonly KuruLog[] = []): {
  submitter: KuruSubmitter;
  submitted: (readonly KuruCall[])[];
} {
  const submitted: (readonly KuruCall[])[] = [];
  return {
    submitted,
    submitter: {
      address: '0x000000000000000000000000000000000000c0DE',
      submit: (calls) => {
        submitted.push(calls);
        return Promise.resolve({
          hash: '0x01',
          transactionHash: '0x01',
          success: true,
          logs,
        });
      },
    },
  };
}

const NOW_MS = 1_800_000_000_000;
const LIMIT = { symbol: 'MON-USDC', side: 'buy', size: '500', price: '0.02' } as const;

test('placeLimit approves the builder first when the account never did', async () => {
  const { submitter, submitted } = capturing();
  const venue = builderVenue({ maxFeePps: 0, expiry: 0n, active: false }, submitter, NOW_MS);
  await venue.placeLimit(LIMIT);
  assert.equal(submitted.length, 1);
  const [approve, place] = submitted[0]!;
  assert.deepEqual(approve, approveBuilderCall(ACCOUNT_CORE, BUILDER, 10_000, 1_900_000_000n));
  assert.deepEqual(place, placeOrderCall(MON_USDC.address, ORDER, undefined, SENTE_FEE));
});

test('placeLimit skips the approval while it still covers the rate', async () => {
  const { submitter, submitted } = capturing();
  const covered = { maxFeePps: 10_000, expiry: BigInt(NOW_MS / 1000 + 30 * 86_400), active: true };
  const reads: string[] = [];
  const venue = builderVenue(covered, submitter, NOW_MS, reads);
  await venue.placeLimit(LIMIT);
  assert.deepEqual(submitted, [[placeOrderCall(MON_USDC.address, ORDER, undefined, SENTE_FEE)]]);
  // A covering approval is remembered: the next order does not read it again.
  await venue.placeLimit(LIMIT);
  assert.equal(reads.filter((r) => r === 'getBuilderApproval').length, 1);
});

test('a user venue approves for its ttl from now', async () => {
  const { submitter, submitted } = capturing();
  const publicClient = {
    readContract: ({ functionName }: { functionName: string }) =>
      functionName === 'getBuilderApproval'
        ? Promise.resolve({ maxFeePps: 0, expiry: 0n, active: false })
        : Promise.reject(new Error(functionName)),
  } as unknown as PublicClient;
  const venue = new KuruVenue({
    publicClient,
    submitter,
    now: () => NOW_MS,
    builder: { ...SENTE_FEE, approvalExpiry: { ttlSeconds: 3600 } },
  });
  assert.deepEqual(await venue.builderApprovalCalls(), [
    approveBuilderCall(ACCOUNT_CORE, BUILDER, 10_000, BigInt(NOW_MS / 1000 + 3600)),
  ]);
  assert.equal(submitted.length, 0);
});

test('a placed buy reports the builder fee AccountCore accrued in the base it bought', async () => {
  const mon = MON_USDC.base.address;
  const { submitter } = capturing([
    feeLog(BUILDER, mon, 63n, 5n * 10n ** 17n),
    feeLog(BUILDER, mon, 99n, 7n), // another taker in the same block: not ours
  ]);
  const covered = { maxFeePps: 10_000, expiry: BigInt(NOW_MS / 1000 + 30 * 86_400), active: true };
  const order = await builderVenue(covered, submitter, NOW_MS).placeLimit(LIMIT);
  assert.equal(order.builderFee, '0.5');
  assert.equal(order.builderFeeAsset, 'MON');
  // These logs carry no fill, so there is no price to value it at.
  assert.equal(order.builderFeeQuote, undefined);
});

test('a placed sell reports the builder fee in the USDC it received', async () => {
  const usdc = MON_USDC.quote.address;
  const { submitter } = capturing([feeLog(BUILDER, usdc, 63n, 20_000n)]);
  const covered = { maxFeePps: 10_000, expiry: BigInt(NOW_MS / 1000 + 30 * 86_400), active: true };
  const order = await builderVenue(covered, submitter, NOW_MS).placeLimit({
    ...LIMIT,
    side: 'sell',
  });
  assert.equal(order.builderFee, '0.02');
  assert.equal(order.builderFeeAsset, 'USDC');
  assert.equal(order.builderFeeQuote, '0.02');
});
