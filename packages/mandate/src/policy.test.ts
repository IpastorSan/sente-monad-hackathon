// The compiled Privy policy, offline. Ports the policy-shape tests from
// turnstile's `buyer/mandate/mandate.test.ts` (checksummed addresses, no DENY,
// hex caps, cap read-back) and adds Sente's: chain id and expiry on every rule,
// one rule per market, venue gating, and that every ABI handed to Privy decodes
// the calldata the venue adapters actually produce.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cancelOrderCall,
  depositCalls,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_TOKENS,
  placeOrderCall,
} from '@sente/venues/kuru';
import {
  ERC20_APPROVE_ABI,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
} from '@sente/venues/perpl';
import { decodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';

import { compileMandate, compileRollingCap, readBackCaps } from './policy.ts';
import { canonicalize } from './privy/canonicalize.ts';
import type { PolicyCondition, PolicyRule } from './privy/policy-types.ts';
import {
  CBBTC_USDC,
  demoMandate,
  EXPIRES_AT,
  MON,
  MON_USDC,
  USDC,
  WETH,
  WETH_USDC,
} from './mandate.fixture.ts';

const HEX_UINT = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const conditionsOf = (rules: readonly PolicyRule[]) => rules.flatMap((r) => r.conditions);
const find = (rule: PolicyRule, source: string, field: string) =>
  rule.conditions.find((c) => c.field_source === source && c.field === field);
const toOf = (rule: PolicyRule) => find(rule, 'ethereum_transaction', 'to')?.value;

test('the policy has no DENY rule — on Privy a DENY is a veto that would deny everything', () => {
  // Verified live by turnstile, 2026-09-07: a catch-all { method: '*', action:
  // 'DENY' } denied requests an earlier ALLOW matched. Privy is deny-by-default.
  const rules = compileMandate(demoMandate());
  assert.ok(rules.length > 0);
  assert.equal(
    rules.some((r) => (r.action as string) === 'DENY'),
    false,
  );
  assert.equal(
    rules.some((r) => (r.method as string) === '*'),
    false,
  );
  for (const r of rules)
    assert.ok(['eth_signTransaction', 'eth_signTypedData_v4'].includes(r.method));
});

test('every address is EIP-55 checksummed, even from a lowercase mandate', () => {
  // Build the mandate by hand, bypassing parseMandate's checksumming, so the
  // compiler's own getAddress() is what is being tested.
  const lower = (a: string) => a.toLowerCase() as Address;
  const rules = compileMandate(
    demoMandate({
      kuru: { markets: [lower(MON_USDC)], maxDepositAtoms: { [lower(USDC)]: 1n } },
    }),
  );
  const addresses = conditionsOf(rules)
    .map((c) => c.value)
    .filter((v) => ADDRESS.test(v));
  assert.ok(addresses.length >= 5);
  for (const value of addresses)
    assert.equal(value, getAddress(value), `${value} is not checksummed`);
  assert.ok(rules.some((r) => toOf(r) === MON_USDC));
  assert.ok(rules.some((r) => toOf(r) === USDC));
});

test('every uint bound is a 0x hex string, and the caps are the right numbers', () => {
  const rules = compileMandate(demoMandate());
  const numeric = conditionsOf(rules).filter(
    (c) =>
      ['lt', 'lte', 'gt', 'gte'].includes(c.operator) ||
      c.field === 'chain_id' ||
      c.field === 'chainId',
  );
  assert.ok(numeric.length > 10);
  for (const c of numeric) assert.match(c.value, HEX_UINT, `${c.field} = ${c.value}`);

  const usdcApprove = rules.find((r) => r.name === 'Kuru: approve USDC to AccountCore')!;
  assert.equal(find(usdcApprove, 'ethereum_calldata', 'approve.amount')?.value, '0x3b9aca00'); // 1e9
  const perplOpen = rules.find((r) => r.name === 'Perpl: open account')!;
  assert.equal(
    find(perplOpen, 'ethereum_calldata', 'createAccount.amountCNS')?.value,
    '0x1dcd6500',
  ); // 5e8
});

test('every rule carries the chain id and the expiry', () => {
  const rules = compileMandate(demoMandate());
  for (const r of rules) {
    const chain =
      r.method === 'eth_signTransaction'
        ? find(r, 'ethereum_transaction', 'chain_id')
        : find(r, 'ethereum_typed_data_domain', 'chainId');
    assert.equal(chain?.operator, 'eq', r.name);
    assert.equal(chain?.value, '0x279f', r.name); // 10143
    const expiry = find(r, 'system', 'current_unix_timestamp');
    assert.equal(expiry?.operator, 'lte', r.name);
    assert.equal(expiry?.value, `0x${EXPIRES_AT.toString(16)}`, r.name);
  }
});

test('one batch rule per allowlisted market, addressed to that market', () => {
  const markets = [MON_USDC, WETH_USDC, CBBTC_USDC];
  const rules = compileMandate(demoMandate({ kuru: { markets, maxDepositAtoms: {} } }));
  const batch = rules.filter(
    (r) => find(r, 'ethereum_calldata', 'function_name')?.value === 'batch',
  );
  assert.equal(batch.length, markets.length);
  assert.deepEqual(batch.map(toOf), markets);
});

test('an empty venues list compiles to no rules at all', () => {
  assert.deepEqual(compileMandate(demoMandate({ venues: [] })), []);
});

test('a venue not in the mandate contributes no rule', () => {
  const exchange = PERPL_TESTNET_CONTRACTS.exchange;
  const kuruOnly = compileMandate(demoMandate({ venues: ['kuru'] }));
  assert.ok(kuruOnly.every((r) => r.name.startsWith('Kuru')));
  assert.ok(!kuruOnly.some((r) => toOf(r) === exchange));

  const perplOnly = compileMandate(demoMandate({ venues: ['perpl'] }));
  assert.ok(perplOnly.every((r) => r.name.startsWith('Perpl')));
  assert.equal(perplOnly.length, 4);
});

test('an empty Kuru allowlist allows nothing on Kuru', () => {
  const rules = compileMandate(
    demoMandate({ venues: ['kuru'], kuru: { markets: [], maxDepositAtoms: {} } }),
  );
  assert.deepEqual(rules, []);
});

test('Kuru funding: approve AccountCore and deposit, both capped; native MON by value', () => {
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const rules = compileMandate(demoMandate({ venues: ['kuru'] }));

  const approve = rules.find((r) => r.name === 'Kuru: approve USDC to AccountCore')!;
  assert.equal(toOf(approve), USDC);
  assert.equal(find(approve, 'ethereum_calldata', 'approve.spender')?.value, accountCore);

  const deposit = rules.find((r) => r.name === 'Kuru: deposit USDC')!;
  assert.equal(toOf(deposit), accountCore);
  assert.equal(find(deposit, 'ethereum_calldata', 'deposit.token')?.value, USDC);
  assert.equal(find(deposit, 'ethereum_calldata', 'deposit.amount')?.operator, 'lte');

  // MON is native: no approval exists to cap, so the deposit caps `value` too.
  assert.ok(!rules.some((r) => toOf(r) === MON));
  const mon = rules.find((r) => r.name === 'Kuru: deposit MON')!;
  assert.equal(find(mon, 'ethereum_transaction', 'value')?.value, '0x4563918244f40000'); // 5e18
});

test('Perpl: AUSD approve to the Exchange, createAccount and forwarding, plus API-key enrollment', () => {
  const { exchange, collateral } = PERPL_TESTNET_CONTRACTS;
  const rules = compileMandate(demoMandate({ venues: ['perpl'] }));
  const byName = (name: string) => rules.find((r) => r.name === name)!;

  const approve = byName('Perpl: approve AUSD to Exchange');
  assert.equal(toOf(approve), collateral);
  assert.equal(find(approve, 'ethereum_calldata', 'approve.spender')?.value, exchange);
  assert.equal(find(approve, 'ethereum_calldata', 'approve.amount')?.value, '0x1dcd6500');

  assert.equal(toOf(byName('Perpl: open account')), exchange);
  const forwarding = byName('Perpl: allow order forwarding');
  assert.equal(
    find(forwarding, 'ethereum_calldata', 'function_name')?.value,
    'allowOrderForwarding',
  );

  const enroll = byName('Perpl: enroll an API key');
  assert.equal(enroll.method, 'eth_signTypedData_v4');
  const statement = find(enroll, 'ethereum_typed_data_message', 'statement');
  assert.ok(statement && 'typed_data' in statement);
  assert.equal(statement.typed_data.primary_type, 'PerplRegisterApiKey');
});

test('the rules are plain JSON Privy can take: canonicalizable, and they survive a round trip', () => {
  const rules = compileMandate(demoMandate());
  assert.doesNotThrow(() => canonicalize(rules)); // no bigint, no float anywhere
  assert.deepEqual(JSON.parse(JSON.stringify(rules)), rules);
});

test('every calldata field names a function and parameter in the ABI shipped with it', () => {
  const calldata = conditionsOf(compileMandate(demoMandate())).filter(
    (c): c is Extract<PolicyCondition, { field_source: 'ethereum_calldata' }> =>
      c.field_source === 'ethereum_calldata',
  );
  for (const c of calldata) {
    const [fn, param] = c.field === 'function_name' ? [c.value, undefined] : c.field.split('.');
    const entries = c.abi.filter((e) => e.type === 'function' && e.name === fn);
    assert.ok(entries.length > 0, `${c.field}: no function ${fn} in its ABI`);
    if (param !== undefined) {
      assert.ok(
        entries.some((e) => e.type === 'function' && e.inputs.some((i) => i.name === param)),
        `${c.field}: ${fn} has no parameter ${param}`,
      );
    }
  }
});

function decode(abi: Abi, data: Hex | undefined) {
  return decodeFunctionData({ abi, data: data! });
}

test("the ABIs handed to Privy decode the Kuru adapter's own calldata", () => {
  const order = {
    side: 'buy',
    quantity: 1n,
    price: 1n,
    tif: 'gtc',
    executionInstruction: 'none',
    minSizeAfterBlock: 0n,
  } as const;
  const plain = placeOrderCall(MON_USDC, order);
  const tagged = placeOrderCall(MON_USDC, order, `0x${'ab'.repeat(32)}`);
  const cancel = cancelOrderCall(MON_USDC, 3);
  for (const call of [plain, tagged, cancel]) {
    assert.equal(decode(KURU_ORDERBOOK_BATCH_ABI, call.data).functionName, 'batch');
  }

  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const [approve, deposit] = depositCalls(accountCore, KURU_TESTNET_TOKENS.USDC, 5n);
  assert.deepEqual(decode(ERC20_APPROVE_ABI, approve!.data).args, [accountCore, 5n]);
  assert.deepEqual(decode(KURU_ACCOUNT_CORE_DEPOSIT_ABI, deposit!.data).args, [USDC, 5n]);
});

test("the ABIs handed to Privy decode Perpl's onboarding calldata", () => {
  const { exchange, collateral } = PERPL_TESTNET_CONTRACTS;
  const [approve, open, forward] = perplOnboardingCalls({
    exchange,
    collateral,
    collateralDecimals: 6,
    minAccountOpenAmount: 100_000_000n,
    minDepositAmount: 10_000_000n,
  });
  assert.deepEqual(decode(ERC20_APPROVE_ABI, approve.data).args, [exchange, 100_000_000n]);
  const opened = decode(PERPL_EXCHANGE_ABI, open.data);
  assert.equal(opened.functionName, 'createAccount');
  assert.deepEqual(opened.args, [100_000_000n]);
  assert.equal(decode(PERPL_EXCHANGE_ABI, forward.data).functionName, 'allowOrderForwarding');
});

test('the caps read back out of the rules — the policy is the authority, not a literal', () => {
  const mandate = demoMandate();
  const caps = readBackCaps(compileMandate(mandate));
  assert.deepEqual(caps.kuruDepositAtoms, mandate.kuru.maxDepositAtoms);
  assert.deepEqual(caps.kuruMarkets, mandate.kuru.markets);
  assert.equal(caps.perplCollateralAtoms, mandate.perpl.maxCollateralAtoms);
  assert.equal(caps.expiresAt, EXPIRES_AT);

  assert.deepEqual(readBackCaps([]), {
    kuruDepositAtoms: {},
    kuruMarkets: [],
    perplCollateralAtoms: null,
    expiresAt: null,
  });
});

test('read-back reports the tighter cap when an approve and its deposit disagree', () => {
  const rules = compileMandate(demoMandate({ venues: ['kuru'] }));
  const tightened = rules.map((r) =>
    r.name === 'Kuru: approve USDC to AccountCore'
      ? {
          ...r,
          conditions: r.conditions.map((c) =>
            c.field === 'approve.amount' ? { ...c, value: '0x64' } : c,
          ),
        }
      : r,
  );
  assert.equal(readBackCaps(tightened).kuruDepositAtoms[USDC], 100n);
  assert.equal(readBackCaps(tightened).kuruDepositAtoms[WETH], undefined);
});

test('the rolling cap compiles to a hex-bounded aggregation over one token, or to nothing', () => {
  assert.equal(compileRollingCap(demoMandate()), null);
  const draft = compileRollingCap(
    demoMandate({ rollingCap: { windowSeconds: 86_400, capAtoms: 2_000_000_000n, token: USDC } }),
  )!;
  assert.equal(draft.cap, '0x77359400');
  assert.equal(draft.window.duration_seconds, 86_400);
  assert.equal(draft.metric.field, 'approve.amount');
  assert.ok(draft.conditions.some((c) => c.field === 'to' && c.value === USDC));
  assert.doesNotThrow(() => canonicalize(draft));
});
