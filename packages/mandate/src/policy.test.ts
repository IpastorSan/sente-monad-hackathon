// The compiled Privy policy, offline. Ports the policy-shape tests from
// turnstile's `buyer/mandate/mandate.test.ts` (checksummed addresses, no DENY,
// hex caps, cap read-back) and adds Sente's: chain id and expiry on every rule,
// one rule per market, venue gating, and that every ABI handed to Privy decodes
// the calldata the venue adapters actually produce.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  approveBuilderCall,
  cancelOrderCall,
  depositCalls,
  ERC20_TRANSFER_ABI,
  erc20TransferCall,
  KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ACCOUNT_CORE_WITHDRAW_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_ORDERBOOK_BUILDER_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_TOKENS,
  placeOrderCall,
  withdrawCall,
} from '@sente/venues/kuru';
import {
  ERC20_APPROVE_ABI,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
} from '@sente/venues/perpl';
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import {
  compileMandate,
  compileRevocationRules,
  compileRollingCap,
  compilesKuruDeposit,
  KURU_APPROVE_BUILDER_RULE,
  KURU_WITHDRAW_RULE,
  readBackCaps,
} from './policy.ts';
import { canonicalize } from './privy/canonicalize.ts';
import type { PolicyCondition, PolicyRule } from './privy/policy-types.ts';
import {
  WBTC_USDC,
  demoMandate,
  EXPIRES_AT,
  MON,
  MON_USDC,
  USDC,
  WETH,
  WETH_USDC,
} from './mandate.fixture.ts';

/** The owner's return address in these tests (the dev treasury on testnet). */
const OWNER = getAddress('0x93e6b8d57dca7b72fae80adaa5c9d7308f7e33b8');
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

test('every uint bound is a 0x hex string except the expiry, and the caps are the right numbers', () => {
  const rules = compileMandate(demoMandate());
  const conditions = conditionsOf(rules);
  // Privy refuses hex for these two (SEN-3 live probe): decimal only.
  const decimalOnly = (c: { field_source: string; field: string }) =>
    c.field === 'current_unix_timestamp' ||
    (c.field_source === 'ethereum_typed_data_domain' && c.field === 'chainId');
  const numeric = conditions.filter(
    (c) =>
      !decimalOnly(c) &&
      (['lt', 'lte', 'gt', 'gte'].includes(c.operator) || c.field === 'chain_id'),
  );
  assert.ok(numeric.length > 10);
  for (const c of numeric) assert.match(c.value, HEX_UINT, `${c.field} = ${c.value}`);
  const decimals = conditions.filter(decimalOnly);
  // An expiry on every rule (no returnTo, so no recovery rule) + the typed-data chainId.
  assert.equal(decimals.length, rules.length + 1);
  for (const c of decimals) assert.match(c.value, /^(0|[1-9][0-9]*)$/, `${c.field} = ${c.value}`);

  const usdcApprove = rules.find((r) => r.name === 'Kuru: approve USDC to AccountCore')!;
  assert.equal(find(usdcApprove, 'ethereum_calldata', 'approve.amount')?.value, '0x3b9aca00'); // 1e9
  const perplOpen = rules.find((r) => r.name === 'Perpl: open account')!;
  assert.equal(
    find(perplOpen, 'ethereum_calldata', 'createAccount.amountCNS')?.value,
    '0x1dcd6500',
  ); // 5e8
});

const isRecovery = (r: PolicyRule) => r.name === KURU_WITHDRAW_RULE || r.name.startsWith('Return ');

test('every rule carries the chain id; every risk-taking rule carries the expiry', () => {
  const rules = compileMandate(demoMandate({ returnTo: OWNER }));
  assert.equal(rules.filter(isRecovery).length, 7); // withdraw + 6 tokens (5 Kuru, AUSD)
  for (const r of rules) {
    const chain =
      r.method === 'eth_signTransaction'
        ? find(r, 'ethereum_transaction', 'chain_id')
        : find(r, 'ethereum_typed_data_domain', 'chainId');
    assert.equal(chain?.operator, 'eq', r.name);
    // 10143: hex on the transaction, decimal in the typed-data domain (Privy refuses hex there).
    assert.equal(chain?.value, r.method === 'eth_signTransaction' ? '0x279f' : '10143', r.name);
    const expiry = find(r, 'system', 'current_unix_timestamp');
    if (isRecovery(r)) {
      // Withdraw-to-owner and return-to-owner survive expiry on purpose (SEN-15).
      assert.equal(expiry, undefined, r.name);
      continue;
    }
    assert.equal(expiry?.operator, 'lte', r.name);
    assert.equal(expiry?.value, String(EXPIRES_AT), r.name);
  }
});

test('Kuru withdraw: AccountCore.withdraw only, with its recipient pinned to the owner', () => {
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const rules = compileMandate(demoMandate({ venues: ['kuru'], returnTo: OWNER }));
  const withdraw = rules.find((r) => r.name === KURU_WITHDRAW_RULE)!;
  assert.equal(toOf(withdraw), accountCore);
  // The account-id AccountCore pays the recipient the call NAMES (SEN-185), so
  // the pin is the whole guarantee.
  const recipient = find(withdraw, 'ethereum_calldata', 'withdraw.recipient');
  assert.equal(recipient?.operator, 'eq');
  assert.equal(recipient?.value, OWNER);
  assert.ok(recipient && 'abi' in recipient);
  // One fragment: transferBetweenAccounts does not decode against it.
  assert.deepEqual(
    recipient.abi.map((e) => (e.type === 'function' ? e.name : e.type)),
    ['withdraw'],
  );
  assert.equal(withdraw.conditions.length, 4); // chain, to, recipient, value 0 (SEN-146) — nothing else

  const home = withdrawCall(accountCore, KURU_TESTNET_TOKENS.USDC, 14_000_000n, 7n, OWNER);
  assert.deepEqual(decode(KURU_ACCOUNT_CORE_WITHDRAW_ABI, home.data).args, [
    7,
    USDC,
    14_000_000n,
    OWNER,
  ]);
  // AccountCore's other way to move a balance, as its ABI spells it.
  const others = parseAbi([
    'function transferBetweenAccounts(uint40 fromAccountId, uint40 toAccountId, address token, uint256 amount)',
  ]);
  const elsewhere = encodeFunctionData({
    abi: others,
    functionName: 'transferBetweenAccounts',
    args: [7, 8, USDC, 1n],
  });
  assert.throws(() => decode(KURU_ACCOUNT_CORE_WITHDRAW_ABI, elsewhere));

  // No returnTo: nowhere it may pay, so no withdraw rule at all (fail closed).
  assert.ok(!compileMandate(demoMandate({ venues: ['kuru'] })).some(isRecovery));
  // Perpl-only: no Kuru withdraw rule.
  const perplOnly = compileMandate(demoMandate({ venues: ['perpl'], returnTo: OWNER }));
  assert.ok(!perplOnly.some((r) => r.name === KURU_WITHDRAW_RULE));
});

test('Kuru deposit: rootOwner is pinned to the agent once its address is known (SEN-185)', () => {
  const AGENT = getAddress('0x3333333333333333333333333333333333333333');
  const deposits = (rules: readonly PolicyRule[]) =>
    rules.filter((r) => r.name.startsWith('Kuru: deposit '));

  const hired = deposits(compileMandate(demoMandate({ venues: ['kuru'] })));
  assert.equal(hired.length, 2);
  for (const rule of hired)
    assert.equal(find(rule, 'ethereum_calldata', 'deposit.rootOwner'), undefined);

  const amended = deposits(
    compileMandate(demoMandate({ venues: ['kuru'] }), { agentAddress: AGENT }),
  );
  assert.equal(amended.length, 2);
  for (const rule of amended) {
    const owner = find(rule, 'ethereum_calldata', 'deposit.rootOwner');
    assert.equal(owner?.operator, 'eq', rule.name);
    assert.equal(owner?.value, AGENT, rule.name);
  }
  // The caps read back the same either way.
  assert.deepEqual(
    readBackCaps(compileMandate(demoMandate(), { agentAddress: AGENT })).kuruDepositAtoms,
    readBackCaps(compileMandate(demoMandate())).kuruDepositAtoms,
  );
});

test('compilesKuruDeposit: true exactly when a hire leaves an unpinned deposit rule (SEN-188)', () => {
  const AGENT = getAddress('0x3333333333333333333333333333333333333333');
  const unpinned = (rules: readonly PolicyRule[]) =>
    rules.filter(
      (r) =>
        r.name.startsWith('Kuru: deposit ') &&
        find(r, 'ethereum_calldata', 'deposit.rootOwner') === undefined,
    ).length;
  const cases = [
    demoMandate(),
    demoMandate({ venues: ['kuru'] }),
    demoMandate({ venues: ['perpl'] }),
    demoMandate({ venues: [] }),
    demoMandate({ kuru: { ...demoMandate().kuru, maxDepositAtoms: {} } }),
  ];
  for (const mandate of cases) {
    const atHire = unpinned(compileMandate(mandate));
    assert.equal(compilesKuruDeposit(mandate), atHire > 0, JSON.stringify(mandate.venues));
    // The pinning amend leaves none, whatever the mandate.
    assert.equal(unpinned(compileMandate(mandate, { agentAddress: AGENT })), 0);
  }
  assert.equal(compilesKuruDeposit(demoMandate({ venues: ['perpl'] })), false);
  assert.equal(compilesKuruDeposit(demoMandate()), true);
});

test('return to owner: one transfer rule per token, transfer.to pinned to returnTo', () => {
  assert.ok(!compileMandate(demoMandate()).some((r) => r.name.startsWith('Return ')));

  const rules = compileMandate(demoMandate({ returnTo: OWNER })).filter((r) =>
    r.name.startsWith('Return '),
  );
  const tokens = [
    ...Object.values(KURU_TESTNET_TOKENS)
      .map((t) => t.address)
      .filter((a) => a !== MON),
    PERPL_TESTNET_CONTRACTS.collateral,
  ];
  assert.deepEqual(rules.map(toOf), tokens);
  for (const r of rules) {
    assert.equal(find(r, 'ethereum_calldata', 'transfer.to')?.value, OWNER, r.name);
    assert.equal(find(r, 'ethereum_calldata', 'transfer.to')?.operator, 'eq', r.name);
    assert.equal(r.conditions.length, 4, r.name); // chain, to (the token), transfer.to, value 0 (SEN-146)
  }

  const call = erc20TransferCall(USDC, OWNER, 14_000_000n);
  assert.equal(call.to, USDC);
  assert.deepEqual(decode(ERC20_TRANSFER_ABI, call.data).args, [OWNER, 14_000_000n]);

  // Independent of venues: an agent with no venue left can still hand funds back.
  const none = compileMandate(demoMandate({ venues: [], returnTo: OWNER }));
  assert.equal(none.length, tokens.length);
  assert.ok(none.every((r) => r.name.startsWith('Return ')));
});

test('revocation keeps the exit: the recovery rules, and nothing that takes risk', () => {
  const mandate = demoMandate({ venues: ['kuru', 'perpl'], returnTo: OWNER });
  const revoked = compileRevocationRules(mandate);
  const full = compileMandate(mandate);

  // Every surviving rule is one the live policy already had, verbatim.
  for (const rule of revoked) {
    assert.ok(
      full.some((r) => canonicalize(r) === canonicalize(rule)),
      `${rule.name} is not a rule the live mandate compiled to`,
    );
  }
  // Exactly the recovery rules: the Kuru withdraw plus one return per token.
  assert.deepEqual(
    revoked.map((r) => r.name),
    full
      .filter((r) => r.name === KURU_WITHDRAW_RULE || r.name.startsWith('Return '))
      .map((r) => r.name),
  );
  // None of them expires, and none of them can move money outward.
  for (const rule of revoked) {
    assert.equal(find(rule, 'system', 'current_unix_timestamp'), undefined, rule.name);
  }
  assert.ok(!revoked.some((r) => find(r, 'ethereum_calldata', 'approve.spender')));
  assert.ok(!revoked.some((r) => find(r, 'ethereum_calldata', 'deposit.amount')));
  assert.ok(!revoked.some((r) => find(r, 'ethereum_calldata', 'function_name')?.value === 'batch'));
  assert.ok(!revoked.some((r) => r.method === 'eth_signTypedData_v4'));

  const caps = readBackCaps(revoked);
  assert.equal(caps.kuruWithdraw, true);
  assert.equal(caps.returnTo, OWNER);
  assert.deepEqual(caps.kuruMarkets, []);
  assert.deepEqual(caps.kuruDepositAtoms, {});
  assert.equal(caps.perplCollateralAtoms, null);
  assert.equal(caps.expiresAt, null);
});

test('revocation of a mandate with no way out empties the policy, as it always did', () => {
  assert.deepEqual(compileRevocationRules(demoMandate({ venues: [] })), []);
  // No returnTo: since SEN-185 a Kuru withdraw must name its recipient, and
  // with no owner address to pin there is no withdraw rule either.
  assert.deepEqual(compileRevocationRules(demoMandate()), []);
});

test('one batch rule per allowlisted market, addressed to that market', () => {
  const markets = [MON_USDC, WETH_USDC, WBTC_USDC];
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

test('an empty Kuru allowlist allows nothing on Kuru but sending its collateral home', () => {
  const rules = compileMandate(
    demoMandate({ venues: ['kuru'], kuru: { markets: [], maxDepositAtoms: {} }, returnTo: OWNER }),
  );
  assert.deepEqual(
    rules.filter((r) => r.name.startsWith('Kuru')).map((r) => r.name),
    [KURU_WITHDRAW_RULE],
  );
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

// SEN-146: before this, only the native deposit named `value`, so an approve,
// a `batch` or a return transfer carrying the wallet's MON was signed too.
test('every transaction rule pins value: the native deposit to its cap, everything else to 0', () => {
  const mandate = demoMandate({ returnTo: OWNER });
  for (const rules of [compileMandate(mandate), compileRevocationRules(mandate)]) {
    const txRules = rules.filter((r) => r.method === 'eth_signTransaction');
    assert.ok(txRules.length > 0);
    for (const r of txRules) {
      const values = r.conditions.filter(
        (c) => c.field_source === 'ethereum_transaction' && c.field === 'value',
      );
      assert.equal(values.length, 1, `${r.name} pins value exactly once`);
      const expected = r.name === 'Kuru: deposit MON' ? '0x4563918244f40000' : '0x0';
      assert.deepEqual(
        { operator: values[0]!.operator, value: values[0]!.value },
        { operator: 'lte', value: expected },
        r.name,
      );
    }
  }
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
  // Privy matched the message condition only with EIP712Domain spelled out, as
  // the request carries it — Perpl's domain includes `salt` (SEN-3 live probe).
  assert.deepEqual(
    statement.typed_data.types['EIP712Domain']?.map((f) => f.name),
    ['name', 'version', 'chainId', 'verifyingContract', 'salt'],
  );
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
  const [approve, deposit] = depositCalls(accountCore, KURU_TESTNET_TOKENS.USDC, 5n, OWNER);
  assert.deepEqual(decode(ERC20_APPROVE_ABI, approve!.data).args, [accountCore, 5n]);
  assert.deepEqual(decode(KURU_ACCOUNT_CORE_DEPOSIT_ABI, deposit!.data).args, [OWNER, USDC, 5n]);
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
  // No returnTo: nowhere a Kuru withdraw may pay (SEN-185), so no rule for one.
  assert.equal(caps.kuruWithdraw, false);
  assert.equal(caps.returnTo, null);
  const home = readBackCaps(compileMandate(demoMandate({ returnTo: OWNER })));
  assert.equal(home.returnTo, OWNER);
  assert.equal(home.kuruWithdraw, true);

  assert.deepEqual(readBackCaps([]), {
    kuruDepositAtoms: {},
    kuruMarkets: [],
    perplCollateralAtoms: null,
    expiresAt: null,
    kuruWithdraw: false,
    returnTo: null,
    kuruBuilder: null,
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
  assert.equal(draft.window.seconds, 86_400); // Privy refuses `duration_seconds` (SEN-3)
  assert.equal(draft.metric.field, 'approve.amount');
  assert.ok(draft.conditions.some((c) => c.field === 'to' && c.value === USDC));
  assert.doesNotThrow(() => canonicalize(draft));
});

// ---------------------------------------------------------------------------
// Sente's builder fee (SEN-184)

const SENTE_GRANT = { address: OWNER, maxFeePps: 10_000 };

test('without the builder option the policy is exactly what it was before SEN-184', () => {
  const mandate = demoMandate({ returnTo: OWNER });
  assert.deepEqual(compileMandate(mandate, {}), compileMandate(mandate));
  assert.deepEqual(compileMandate(mandate, { kuruBuilder: null }), compileMandate(mandate));
  assert.equal(readBackCaps(compileMandate(mandate)).kuruBuilder, null);
});

test('with it: one approve-the-fee rule pinned to Sente, the rate and the expiry', () => {
  const mandate = demoMandate();
  const rules = compileMandate(mandate, { kuruBuilder: SENTE_GRANT });
  const approve = rules.filter((r) => r.name === KURU_APPROVE_BUILDER_RULE);
  assert.equal(approve.length, 1);
  const rule = approve[0]!;
  assert.equal(toOf(rule), KURU_TESTNET_CONTRACTS.accountCore);
  assert.equal(find(rule, 'ethereum_calldata', 'approveBuilder.builder')?.value, OWNER);
  assert.equal(find(rule, 'ethereum_calldata', 'approveBuilder.builder')?.operator, 'eq');
  assert.equal(find(rule, 'ethereum_calldata', 'approveBuilder.maxFeePps')?.value, '0x2710');
  assert.equal(find(rule, 'ethereum_calldata', 'approveBuilder.maxFeePps')?.operator, 'lte');
  assert.equal(
    find(rule, 'ethereum_calldata', 'approveBuilder.expiry')?.value,
    `0x${EXPIRES_AT.toString(16)}`,
  );
  assert.equal(find(rule, 'ethereum_transaction', 'value')?.value, '0x0');
  assert.equal(find(rule, 'system', 'current_unix_timestamp')?.value, String(EXPIRES_AT));
  assert.deepEqual(readBackCaps(rules).kuruBuilder, SENTE_GRANT);
});

test('with it: one builder-overload trade rule per market, and the plain ones untouched', () => {
  const mandate = demoMandate();
  const plain = compileMandate(mandate);
  const rules = compileMandate(mandate, { kuruBuilder: SENTE_GRANT });
  // Every rule the old policy had is still there, byte for byte.
  for (const rule of plain)
    assert.ok(rules.some((r) => JSON.stringify(r) === JSON.stringify(rule)));
  const builderTrades = rules.filter((r) => r.name.endsWith('with the Sente fee'));
  assert.deepEqual(
    builderTrades.map(toOf),
    mandate.kuru.markets.map((m) => getAddress(m)),
  );
  for (const rule of builderTrades) {
    const fn = find(rule, 'ethereum_calldata', 'function_name')!;
    assert.equal(fn.value, 'batch');
    assert.deepEqual('abi' in fn ? fn.abi : undefined, KURU_ORDERBOOK_BUILDER_BATCH_ABI);
  }
  assert.equal(rules.length, plain.length + 1 + mandate.kuru.markets.length);
  // Market list read-back is unchanged: the builder rules name the same books.
  assert.deepEqual(readBackCaps(rules).kuruMarkets, readBackCaps(plain).kuruMarkets);
});

test('no Kuru venue or no market: no builder rule', () => {
  const perplOnly = compileMandate(demoMandate({ venues: ['perpl'] }), {
    kuruBuilder: SENTE_GRANT,
  });
  assert.equal(readBackCaps(perplOnly).kuruBuilder, null);
  const noMarkets = compileMandate(
    demoMandate({ kuru: { markets: [], maxDepositAtoms: { [USDC]: 1n } } }),
    { kuruBuilder: SENTE_GRANT },
  );
  assert.equal(
    noMarkets.some((r) => r.name === KURU_APPROVE_BUILDER_RULE),
    false,
  );
});

test('the builder ABIs decode what the venue adapter emits, field names included', () => {
  const approve = approveBuilderCall(KURU_TESTNET_CONTRACTS.accountCore, OWNER, 10_000, 1n);
  const decoded = decodeFunctionData({
    abi: KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
    data: approve.data!,
  });
  assert.equal(decoded.functionName, 'approveBuilder');
  const fn = KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI[0] as unknown as { inputs: { name: string }[] };
  assert.deepEqual(
    fn.inputs.map((i) => i.name),
    ['builder', 'maxFeePps', 'expiry'],
  );
  const order = {
    side: 'buy',
    quantity: 1n,
    price: 1n,
    tif: 'ioc',
    executionInstruction: 'none',
    minSizeAfterBlock: 0n,
  } as const;
  for (const clientOrderId of [undefined, `0x${'11'.repeat(32)}` as Hex]) {
    const place = placeOrderCall(MON_USDC, order, clientOrderId, {
      address: OWNER,
      feePps: 10_000,
    });
    assert.equal(
      decodeFunctionData({ abi: KURU_ORDERBOOK_BUILDER_BATCH_ABI, data: place.data! }).functionName,
      'batch',
    );
    // ...and the plain rule's ABI does NOT decode it: old policies refuse a builder order.
    assert.throws(() => decodeFunctionData({ abi: KURU_ORDERBOOK_BATCH_ABI, data: place.data! }));
  }
});

test('a revoked agent keeps no builder rule', () => {
  const revoked = compileRevocationRules(demoMandate({ returnTo: OWNER }));
  assert.equal(readBackCaps(revoked).kuruBuilder, null);
});
