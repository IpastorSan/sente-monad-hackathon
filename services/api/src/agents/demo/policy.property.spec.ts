/**
 * The policy compiler against the fake enclave (SEN-134, test audit §3/§4 #11).
 *
 * Every other API suite compares `compileMandate(m)` with `compileMandate(m)`
 * — the compiler as its own oracle — which is why a Kuru deposit cap ×10 and
 * a Perpl `createAccount` cap ×10 survived every API suite in the audit. Here
 * the oracle is SEMANTIC: for a generated mandate and a generated call,
 * `allows(compileMandate(m), tx, now)` (the fake enclave's evaluator) must
 * equal {@link mandatePermits}, which reads the mandate the way a user does —
 * markets, per-token caps, venues, return address, expiry, chain — and never
 * touches a rule.
 *
 * Each `it` names the compiler mutation it was checked against (planted by
 * hand in packages/mandate/src/policy.ts, seen red, reverted).
 *
 * `value` is modelled on every call (SEN-146). SEN-134 first held it at 0 off
 * the native deposit, because the compiled rules pinned it only there — a
 * policy would have signed MON riding along an approve, a `batch` or a return
 * transfer. The oracle now says what a user would: MON moves only as a native
 * deposit, within its cap.
 */
import {
  compileMandate,
  compileRevocationRules,
  parseMandate,
  type Mandate,
  type PolicyRule,
} from '@sente/mandate';
import {
  ERC20_TRANSFER_ABI,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ACCOUNT_CORE_WITHDRAW_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  NATIVE_TOKEN,
} from '@sente/venues/kuru';
import {
  ERC20_APPROVE_ABI,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
} from '@sente/venues/perpl';
import fc from 'fast-check';
import { bytesToHex, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import { privyTransaction } from '../privy/agent-wallet';
import { allows } from './testing/fake-enclave';

// Why a fixed seed and a run count: a red CI run must reproduce locally from
// the same numbers, and the whole file stays well under a second or two.
const RUNS = { numRuns: 400, seed: 134 };

const CHAIN = 10143;
const ACCOUNT_CORE = getAddress(KURU_TESTNET_CONTRACTS.accountCore);
const EXCHANGE = getAddress(PERPL_TESTNET_CONTRACTS.exchange);
const AUSD = getAddress(PERPL_TESTNET_CONTRACTS.collateral);
const USDC = getAddress(KURU_TESTNET_TOKENS.USDC.address);
const KURU_TOKENS = Object.values(KURU_TESTNET_TOKENS).map((t) => getAddress(t.address));
const MARKETS = KURU_TESTNET_MARKETS.map((m) => getAddress(m.address));
/**
 * Spelled out here, not read from `returnableTokens()`: the oracle must not
 * borrow the compiler's own list. Every ERC-20 the wallet can hold; not MON.
 */
const RETURNABLE = [...KURU_TOKENS.filter((t) => t !== NATIVE_TOKEN), AUSD];

// ─── The semantic oracle ────────────────────────────────────────────────────

type Call =
  | { kind: 'approve'; token: Address; spender: Address; amount: bigint }
  | { kind: 'deposit'; target: Address; token: Address; amount: bigint }
  | { kind: 'batch'; target: Address }
  | { kind: 'withdraw'; target: Address; token: Address; amount: bigint }
  | { kind: 'transfer'; token: Address; to: Address; amount: bigint }
  | { kind: 'createAccount'; target: Address; amount: bigint }
  | { kind: 'depositCollateral'; target: Address; amount: bigint }
  | { kind: 'allowOrderForwarding'; target: Address };

interface Case {
  readonly mandate: Mandate;
  readonly call: Call;
  /** Native MON the transaction carries, whatever the call. */
  readonly value: bigint;
  readonly chainId: number;
  readonly now: number;
}

const isNativeDeposit = (call: Call): boolean =>
  call.kind === 'deposit' && call.token === NATIVE_TOKEN;

function kuruCap(m: Mandate, token: Address): bigint | undefined {
  const key = Object.keys(m.kuru.maxDepositAtoms).find((k) => getAddress(k) === token);
  return key === undefined ? undefined : m.kuru.maxDepositAtoms[key as Address];
}

/** May an agent holding `m` make `call`, as the mandate reads to its owner? */
function mandatePermits(
  m: Mandate,
  call: Call,
  value: bigint,
  chainId: number,
  now: number,
  revoked = false,
): boolean {
  if (chainId !== CHAIN) return false;
  // MON leaves the wallet only as a native deposit (SEN-146); on any other call
  // it is money the mandate never allowed to move.
  if (value > 0n && !isNativeDeposit(call)) return false;
  // Risk-taking needs a live, unrevoked mandate; recovery needs neither (SEN-15/17).
  const live = !revoked && now <= m.expiresAt;
  const kuru = m.venues.includes('kuru');
  const perpl = m.venues.includes('perpl');
  const perplCap = m.perpl.maxCollateralAtoms;
  switch (call.kind) {
    case 'approve': {
      const cap = kuruCap(m, call.token);
      const kuruFunding =
        kuru &&
        call.token !== NATIVE_TOKEN &&
        cap !== undefined &&
        call.spender === ACCOUNT_CORE &&
        call.amount <= cap;
      const perplFunding =
        perpl && call.token === AUSD && call.spender === EXCHANGE && call.amount <= perplCap;
      return live && (kuruFunding || perplFunding);
    }
    case 'deposit': {
      const cap = kuruCap(m, call.token);
      if (!live || !kuru || call.target !== ACCOUNT_CORE || cap === undefined) return false;
      // Native MON moves as `value`; the declared amount and the money both count.
      if (call.token === NATIVE_TOKEN) return call.amount <= cap && value <= cap;
      return call.amount <= cap;
    }
    case 'batch':
      return live && kuru && m.kuru.markets.some((a) => getAddress(a) === call.target);
    case 'withdraw':
      return kuru && call.target === ACCOUNT_CORE;
    case 'transfer':
      return (
        m.returnTo !== undefined &&
        getAddress(m.returnTo) === call.to &&
        RETURNABLE.includes(call.token)
      );
    case 'createAccount':
      return live && perpl && call.target === EXCHANGE && call.amount <= perplCap;
    case 'allowOrderForwarding':
      return live && perpl && call.target === EXCHANGE;
    case 'depositCollateral':
      // Not a mandate step: funding Perpl beyond `createAccount` is refused.
      return false;
  }
}

function encode(call: Call): { to: Address; data: Hex } {
  switch (call.kind) {
    case 'approve':
      return {
        to: call.token,
        data: encodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
          args: [call.spender, call.amount],
        }),
      };
    case 'deposit':
      return {
        to: call.target,
        data: encodeFunctionData({
          abi: KURU_ACCOUNT_CORE_DEPOSIT_ABI,
          functionName: 'deposit',
          args: [call.token, call.amount],
        }),
      };
    case 'batch':
      return {
        to: call.target,
        data: encodeFunctionData({
          abi: KURU_ORDERBOOK_BATCH_ABI,
          functionName: 'batch',
          args: [0, [], []],
        }),
      };
    case 'withdraw':
      return {
        to: call.target,
        data: encodeFunctionData({
          abi: KURU_ACCOUNT_CORE_WITHDRAW_ABI,
          functionName: 'withdraw',
          args: [call.token, call.amount],
        }),
      };
    case 'transfer':
      return {
        to: call.token,
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [call.to, call.amount],
        }),
      };
    case 'createAccount':
    case 'depositCollateral':
      return {
        to: call.target,
        data: encodeFunctionData({
          abi: PERPL_EXCHANGE_ABI,
          functionName: call.kind,
          args: [call.amount],
        }),
      };
    case 'allowOrderForwarding':
      return {
        to: call.target,
        data: encodeFunctionData({
          abi: PERPL_EXCHANGE_ABI,
          functionName: 'allowOrderForwarding',
          args: [true],
        }),
      };
  }
}

function enclaveAllows(rules: readonly PolicyRule[], c: Case): boolean {
  const { to, data } = encode(c.call);
  const tx = privyTransaction({
    to,
    data,
    value: c.value,
    chainId: c.chainId,
    nonce: 0,
    gas: 300_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  return allows(rules, tx, c.now);
}

// ─── Generators ─────────────────────────────────────────────────────────────

const randomAddress = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => getAddress(bytesToHex(bytes)));

/** 0, dust, and anything up to 10^30 atoms — past any real cap, well inside uint256. */
const capAtoms = fc.oneof(
  fc.constant(0n),
  fc.bigInt({ min: 1n, max: 1_000n }),
  fc.bigInt({ min: 0n, max: 10n ** 30n }),
);

/**
 * An amount around `cap`: equal, one atom either side, and the ×10 / ÷10
 * unit slips (6 vs 7 decimals, a stray zero) the audit saw survive.
 */
function near(cap: bigint | undefined): fc.Arbitrary<bigint> {
  const c = cap ?? 1_000_000n;
  const boundaries = [c, c + 1n, c * 10n, c / 10n, c * 10n - 1n, c - 1n].filter((a) => a >= 0n);
  return fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...boundaries) },
    { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: 10n ** 31n }) },
  );
}

/** A raw mandate as a client would send it, through the real parser. */
const mandateArb: fc.Arbitrary<Mandate> = fc
  .record({
    expiresAt: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
    venues: fc.shuffledSubarray(['kuru', 'perpl']),
    // Lower-case some addresses: the parser checksums, and `to` must still match.
    markets: fc
      .shuffledSubarray(MARKETS)
      .chain((ms) => fc.tuple(...ms.map((a) => fc.constantFrom(a, a.toLowerCase())))),
    deposits: fc
      .shuffledSubarray(KURU_TOKENS)
      .chain((ts) =>
        fc.tuple(...ts.map((t) => fc.tuple(fc.constantFrom(t, t.toLowerCase()), capAtoms))),
      ),
    perplCap: capAtoms,
    returnTo: fc.option(
      randomAddress.filter((a) => a !== NATIVE_TOKEN),
      { nil: undefined },
    ),
  })
  .map((r) =>
    parseMandate({
      version: 1,
      chainId: CHAIN,
      expiresAt: r.expiresAt,
      venues: r.venues,
      kuru: {
        markets: r.markets,
        maxDepositAtoms: Object.fromEntries(r.deposits.map(([t, cap]) => [t, cap.toString()])),
      },
      perpl: { maxCollateralAtoms: r.perplCap.toString(), maxLeverage: 5, markets: ['BTC-PERP'] },
      maxOrderNotional: '250',
      ...(r.returnTo ? { returnTo: r.returnTo } : {}),
    }),
  );

/** Mostly the right contract, sometimes a neighbouring one or a stranger. */
const target = (right: Address): fc.Arbitrary<Address> =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constant(right) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(ACCOUNT_CORE, EXCHANGE, AUSD, ...MARKETS, ...KURU_TOKENS),
    },
    { weight: 1, arbitrary: randomAddress },
  );

const anyToken = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...KURU_TOKENS, AUSD) },
  { weight: 1, arbitrary: randomAddress },
);

type Family = 'kuruFunding' | 'kuruTrade' | 'perpl' | 'recovery';

function callArb(m: Mandate, family: Family): fc.Arbitrary<Call> {
  switch (family) {
    case 'kuruFunding':
      return anyToken.chain((token) => {
        const cap = kuruCap(m, token);
        return fc.oneof(
          fc.record({
            kind: fc.constant('approve' as const),
            token: fc.constant(token),
            spender: target(ACCOUNT_CORE),
            amount: near(cap),
          }),
          fc.record({
            kind: fc.constant('deposit' as const),
            target: target(ACCOUNT_CORE),
            token: fc.constant(token),
            amount: near(cap),
          }),
        );
      });
    case 'kuruTrade':
      return fc.record({
        kind: fc.constant('batch' as const),
        target: fc.oneof(fc.constantFrom(...MARKETS), target(MARKETS[0]!)),
      });
    case 'perpl':
      return fc.oneof(
        fc.record({
          kind: fc.constant('approve' as const),
          token: target(AUSD),
          spender: target(EXCHANGE),
          amount: near(m.perpl.maxCollateralAtoms),
        }),
        fc.record({
          kind: fc.constantFrom('createAccount' as const, 'depositCollateral' as const),
          target: target(EXCHANGE),
          amount: near(m.perpl.maxCollateralAtoms),
        }),
        fc.record({
          kind: fc.constant('allowOrderForwarding' as const),
          target: target(EXCHANGE),
        }),
      );
    case 'recovery':
      return fc.oneof(
        fc.record({
          kind: fc.constant('withdraw' as const),
          target: target(ACCOUNT_CORE),
          token: anyToken,
          amount: fc.bigInt({ min: 0n, max: 10n ** 31n }),
        }),
        fc.record({
          kind: fc.constant('transfer' as const),
          token: anyToken,
          to: m.returnTo
            ? fc.oneof(
                fc.constant(getAddress(m.returnTo)),
                randomAddress,
                fc.constant(ACCOUNT_CORE),
              )
            : randomAddress,
          amount: fc.bigInt({ min: 0n, max: 10n ** 31n }),
        }),
      );
  }
}

/** Around the expiry second (inclusive), plus far either side. */
function nowArb(m: Mandate): fc.Arbitrary<number> {
  const e = m.expiresAt;
  return fc.oneof(
    fc.constantFrom(e - 1, e, e + 1),
    fc.integer({ min: e - 10_000_000, max: e + 10_000_000 }),
  );
}

const chainArb = fc.oneof(
  { weight: 8, arbitrary: fc.constant(CHAIN) },
  { weight: 1, arbitrary: fc.constantFrom(1, 10142, 10144, 143) },
);

/** Mostly none; sometimes one wei, sometimes a whole balance. */
const rideAlong = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0n) },
  { weight: 1, arbitrary: fc.constant(1n) },
  { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: 10n ** 30n }) },
);

/** A native deposit's value sits around its cap; any other call's is {@link rideAlong}. */
function valueArb(m: Mandate, call: Call): fc.Arbitrary<bigint> {
  return isNativeDeposit(call) ? near(kuruCap(m, NATIVE_TOKEN)) : rideAlong;
}

function caseArb(
  families: readonly Family[],
  value: (m: Mandate, call: Call) => fc.Arbitrary<bigint> = valueArb,
): fc.Arbitrary<Case> {
  return mandateArb.chain((mandate) =>
    fc
      .constantFrom(...families)
      .chain((f) => callArb(mandate, f))
      .chain((call) =>
        fc.record({
          mandate: fc.constant(mandate),
          call: fc.constant(call),
          value: value(mandate, call),
          chainId: chainArb,
          now: nowArb(mandate),
        }),
      ),
  );
}

function compiledAgreesWithMandate(families: readonly Family[]): void {
  fc.assert(
    fc.property(caseArb(families), (c) => {
      const expected = mandatePermits(c.mandate, c.call, c.value, c.chainId, c.now);
      expect(enclaveAllows(compileMandate(c.mandate), c)).toBe(expected);
    }),
    RUNS,
  );
}

// ─── Properties ─────────────────────────────────────────────────────────────

describe('compileMandate, as the fake enclave applies it (SEN-134)', () => {
  // Planted, each red here: `deposit.amount` cap × 10n; the Kuru `approve.amount`
  // cap × 10n; the native deposit without `txValueLte(cap)`.
  it('allows a Kuru approve/deposit iff the token is listed, the venue is on and the amount is within its cap', () => {
    compiledAgreesWithMandate(['kuruFunding']);
  });

  // Planted: kuruRules iterating KURU_TESTNET_MARKETS instead of mandate.kuru.markets.
  it('allows a Kuru batch iff the OrderBook is on the mandate allowlist', () => {
    compiledAgreesWithMandate(['kuruTrade']);
  });

  // Planted: `createAccount.amountCNS` cap × 10n; separately, compiling
  // perplRules without `venues.includes('perpl')`.
  it('allows Perpl approve/createAccount/forwarding iff Perpl is a venue and within the collateral cap', () => {
    compiledAgreesWithMandate(['perpl']);
  });

  // Planted: returnRules dropping the `transfer.to` condition.
  it('allows a withdraw or a return transfer iff it can only pay the agent or returnTo', () => {
    compiledAgreesWithMandate(['recovery']);
  });

  // Planted: `unixTimestampLte(mandate.expiresAt + 1)`; separately, the
  // recovery builder without `txChainIdEq`.
  it('refuses everything off-chain and every risk-taking call after expiresAt, over every call', () => {
    compiledAgreesWithMandate(['kuruFunding', 'kuruTrade', 'perpl', 'recovery']);
  });
});

describe('compileRevocationRules, as the fake enclave applies it (SEN-134)', () => {
  // Planted: compileRevocationRules returning compileMandate(mandate).
  it('allows exactly the recovery calls of the mandate, and nothing that takes risk, at any time', () => {
    fc.assert(
      fc.property(caseArb(['kuruFunding', 'kuruTrade', 'perpl', 'recovery']), (c) => {
        const expected = mandatePermits(c.mandate, c.call, c.value, c.chainId, c.now, true);
        expect(enclaveAllows(compileRevocationRules(c.mandate), c)).toBe(expected);
      }),
      RUNS,
    );
  });
});

describe('value off the native deposit (SEN-146)', () => {
  const ALL: readonly Family[] = ['kuruFunding', 'kuruTrade', 'perpl', 'recovery'];
  const positive = () => fc.bigInt({ min: 1n, max: 10n ** 30n });

  // Planted: compileMandate's `tx` builder without `txValueLte(maxValue)`;
  // separately, recoveryRuleBuilder without it. Each red here.
  it('refuses every non-native call carrying MON, live or revoked, even one the mandate allows at value 0', () => {
    fc.assert(
      fc.property(
        caseArb(ALL, positive).filter((c) => !isNativeDeposit(c.call)),
        (c) => {
          expect(enclaveAllows(compileMandate(c.mandate), c)).toBe(false);
          expect(enclaveAllows(compileRevocationRules(c.mandate), c)).toBe(false);
          // The same call at value 0 is judged by the mandate alone, so the
          // refusal above is the value's doing, not a coincidence.
          const atZero = { ...c, value: 0n };
          expect(enclaveAllows(compileMandate(c.mandate), atZero)).toBe(
            mandatePermits(c.mandate, c.call, 0n, c.chainId, c.now),
          );
        },
      ),
      RUNS,
    );
  });

  /** A live Kuru mandate with USDC and native MON caps, through the real parser. */
  const kuruOnly = (usdcCap: bigint, monCap: bigint): Mandate =>
    parseMandate({
      version: 1,
      chainId: CHAIN,
      expiresAt: 1_800_000_000,
      venues: ['kuru'],
      kuru: {
        markets: [],
        maxDepositAtoms: { [USDC]: usdcCap.toString(), [NATIVE_TOKEN]: monCap.toString() },
      },
      perpl: { maxCollateralAtoms: '0', maxLeverage: 5, markets: ['BTC-PERP'] },
      maxOrderNotional: '250',
    });
  const at = (mandate: Mandate, call: Call, value: bigint): Case => ({
    mandate,
    call,
    value,
    chainId: CHAIN,
    now: mandate.expiresAt,
  });

  it('refuses an in-cap USDC approve with one wei on it, which signs at value 0', () => {
    const m = kuruOnly(1_000n, 1_000n);
    const call: Call = { kind: 'approve', token: USDC, spender: ACCOUNT_CORE, amount: 1_000n };
    expect(enclaveAllows(compileMandate(m), at(m, call, 0n))).toBe(true);
    expect(enclaveAllows(compileMandate(m), at(m, call, 1n))).toBe(false);
  });

  it('keeps the native deposit as it was: value up to the cap signs, one wei over does not', () => {
    fc.assert(
      fc.property(capAtoms, (cap) => {
        const m = kuruOnly(0n, cap);
        const call: Call = {
          kind: 'deposit',
          target: ACCOUNT_CORE,
          token: NATIVE_TOKEN,
          amount: cap,
        };
        expect(enclaveAllows(compileMandate(m), at(m, call, cap))).toBe(true);
        expect(enclaveAllows(compileMandate(m), at(m, call, cap + 1n))).toBe(false);
      }),
      { ...RUNS, numRuns: 100 },
    );
  });
});
