/**
 * The policy compiler and the retired-deployment helpers with Set C active
 * (SEN-189). The compiler reads the active deployment at load, so these run
 * in the `test:set-c` pass (`KURU_DEPLOYMENT=set-c`) and skip otherwise; the
 * Set-D shapes are `policy.test.ts` and `retired.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  depositCalls,
  KURU_ACCOUNT_CORE_DEPOSIT_ABIS,
  KURU_ACCOUNT_CORE_WITHDRAW_ABIS,
  KURU_DEPLOYMENT,
  KURU_DEPLOYMENTS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_TOKENS,
  withdrawCall,
} from '@sente/venues/kuru';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import { checkIntent } from './enforce.ts';
import { demoMandate, MON, NOW } from './mandate.fixture.ts';
import { parseMandate } from './mandate.ts';
import {
  compileMandate,
  compileRevocationRules,
  compilesKuruDeposit,
  KURU_WITHDRAW_TO_WALLET_RULE,
  readBackCaps,
} from './policy.ts';
import type { PolicyRule } from './privy/policy-types.ts';
import { retiredKuruMessage, retiredKuruReferences, withCurrentKuru } from './retired.ts';

const SET_C = { skip: KURU_DEPLOYMENT.id !== 'set-c' };
const OWNER = getAddress('0x93e6b8d57dca7b72fae80adaa5c9d7308f7e33b8');
const AGENT = getAddress('0x3333333333333333333333333333333333333333');
const find = (rule: PolicyRule, source: string, field: string) =>
  rule.conditions.find((c) => c.field_source === source && c.field === field);

const setD = KURU_DEPLOYMENTS['set-d'];
const setDMarket = (symbol: string): Address =>
  setD.markets.find((m) => m.symbol === symbol)!.address;

test('Set C is the active deployment in this pass', SET_C, () => {
  assert.equal(KURU_TESTNET_CONTRACTS.accountCore, '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22');
  assert.equal(KURU_TESTNET_TOKENS.USDC.address, '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E');
});

test(
  'deposit rules name no account: Set C credits the caller, so there is nothing to pin',
  SET_C,
  () => {
    for (const options of [{}, { agentAddress: AGENT }]) {
      const deposits = compileMandate(demoMandate({ venues: ['kuru'] }), options).filter((r) =>
        r.name.startsWith('Kuru: deposit '),
      );
      assert.equal(deposits.length, 2);
      for (const rule of deposits) {
        assert.equal(find(rule, 'ethereum_calldata', 'deposit.rootOwner'), undefined, rule.name);
        assert.ok(find(rule, 'ethereum_calldata', 'deposit.token'), rule.name);
        assert.ok(find(rule, 'ethereum_calldata', 'deposit.amount'), rule.name);
      }
    }
    // So a hire is pinned from the start (SEN-188's amend has nothing to do).
    assert.equal(compilesKuruDeposit(demoMandate()), false);
  },
);

test(
  'the deposit rule decodes the address-keyed deposit(token, amount) the adapter sends',
  SET_C,
  () => {
    const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
    const [, deposit] = depositCalls(accountCore, KURU_TESTNET_TOKENS.USDC, 5n, AGENT);
    const rule = compileMandate(demoMandate({ venues: ['kuru'] })).find(
      (r) => r.name === 'Kuru: deposit USDC',
    )!;
    const amount = find(rule, 'ethereum_calldata', 'deposit.amount')!;
    assert.ok('abi' in amount);
    assert.deepEqual(amount.abi, KURU_ACCOUNT_CORE_DEPOSIT_ABIS['address-keyed']);
    assert.deepEqual(decodeFunctionData({ abi: amount.abi, data: deposit!.data as Hex }).args, [
      KURU_TESTNET_TOKENS.USDC.address,
      5n,
    ]);
  },
);

test(
  'withdraw: withdraw(token, amount) by name, paying only the agent, kept on revoke',
  SET_C,
  () => {
    const mandate = demoMandate({ venues: ['kuru'], returnTo: OWNER });
    const withdraw = compileMandate(mandate).find((r) => r.name === KURU_WITHDRAW_TO_WALLET_RULE)!;
    assert.equal(
      find(withdraw, 'ethereum_transaction', 'to')?.value,
      KURU_TESTNET_CONTRACTS.accountCore,
    );
    const fn = find(withdraw, 'ethereum_calldata', 'function_name')!;
    assert.equal(fn.value, 'withdraw');
    assert.ok('abi' in fn);
    assert.deepEqual(fn.abi, KURU_ACCOUNT_CORE_WITHDRAW_ABIS['address-keyed']);
    assert.equal(find(withdraw, 'system', 'current_unix_timestamp'), undefined);

    const call = withdrawCall(
      KURU_TESTNET_CONTRACTS.accountCore,
      KURU_TESTNET_TOKENS.USDC,
      9n,
      62n,
      OWNER,
    );
    assert.deepEqual(decodeFunctionData({ abi: fn.abi, data: call.data as Hex }).args, [
      KURU_TESTNET_TOKENS.USDC.address,
      9n,
    ]);

    const revoked = compileRevocationRules(mandate);
    assert.ok(revoked.some((r) => r.name === KURU_WITHDRAW_TO_WALLET_RULE));
    assert.equal(readBackCaps(revoked).kuruWithdraw, true);
    assert.equal(readBackCaps(revoked).returnTo, OWNER);
  },
);

test('a mandate naming Set D books is retired: moved to Set C, USDT-USDC dropped', SET_C, () => {
  const mandate = {
    ...demoMandate(),
    kuru: {
      markets: [setDMarket('WBTC-USDC'), setDMarket('USDT-USDC')],
      maxDepositAtoms: { [setD.tokens.USDC.address]: 1_000_000n, [MON]: 5n },
    },
    rollingCap: { windowSeconds: 86_400, capAtoms: 9n, token: setD.tokens.USDC.address },
  };
  const refs = retiredKuruReferences(mandate);
  assert.deepEqual(
    refs.map((r) => [r.fromSymbol, r.toSymbol]),
    [
      ['WBTC-USDC', 'cbBTC-USDC'],
      ['USDT-USDC', null],
      ['USDC', 'USDC'],
    ],
  );
  const message = retiredKuruMessage(refs);
  assert.match(message, /Sente does not trade now/);
  assert.match(message, /WBTC-USDC → cbBTC-USDC, USDT-USDC dropped/);

  const moved = withCurrentKuru(mandate);
  const cbBtc = KURU_DEPLOYMENTS['set-c'].markets.find((m) => m.symbol === 'cbBTC-USDC')!;
  assert.deepEqual(moved.kuru.markets, [cbBtc.address]);
  assert.deepEqual(
    Object.keys(moved.kuru.maxDepositAtoms).sort(),
    [MON, KURU_TESTNET_TOKENS.USDC.address].sort(),
  );
  assert.equal(moved.rollingCap?.token, KURU_TESTNET_TOKENS.USDC.address);
  assert.deepEqual(retiredKuruReferences(moved), []);

  const order = { venue: 'kuru', kind: 'order', market: cbBtc.address, notional: '1' } as const;
  assert.equal(checkIntent(mandate, order, NOW)?.code, 'kuru_market_retired');
});

test('parseMandate refuses a Set D book by name, pointing at its Set C counterpart', SET_C, () => {
  const input = (markets: string[]) => ({
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru'],
    kuru: { markets, maxDepositAtoms: {} },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '1',
  });
  assert.throws(() => parseMandate(input([setDMarket('WBTC-USDC')])), /name cbBTC-USDC/);
  assert.throws(() => parseMandate(input([setDMarket('USDT-USDC')])), /no counterpart on set-c/);
});
