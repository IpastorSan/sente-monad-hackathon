/**
 * The mandate compiled to Privy policy rules — layer 2, the half that runs in
 * the enclave rather than on our server.
 *
 * Only ALLOW rules. Privy is deny-by-default (a policy with zero rules signs
 * nothing), and a DENY is a veto over requests an ALLOW already matched, so a
 * catch-all `{ method: '*', action: 'DENY' }` denies everything — turnstile
 * learned that live on 2026-09-07. There is deliberately none here.
 *
 * Every rule carries the chain: `ethereum_transaction.chain_id eq 10143` on
 * transaction rules, `ethereum_typed_data_domain.chainId eq 10143` on the
 * typed-data rule (a typed-data request has no transaction to read a chain id
 * from).
 *
 * Every rule that lets the agent TAKE risk also carries the expiry,
 * `system.current_unix_timestamp lte expiresAt`, so a mandate stops funding and
 * trading at its deadline by the enclave's own clock, whether or not anyone
 * remembers to revoke it.
 *
 * The two RECOVERY rules deliberately carry no expiry (SEN-15), because each
 * can only move money toward the owner:
 *
 * - **Kuru withdraw**: `AccountCore.withdraw(rootAccountId, token, amount,
 *   recipient)` with `withdraw.recipient` pinned to `mandate.returnTo` — the
 *   owner. Kuru's account-id AccountCore (SEN-185) pays whatever recipient the
 *   call names, so the pin is the whole guarantee; Set C's `withdraw(token,
 *   amount)` paid `msg.sender` and needed none. Without a `returnTo` there is
 *   no withdraw rule at all (fail closed). `transferBetweenAccounts` does not
 *   decode against the one-function ABI, so it is refused.
 * - **Return to owner**: ERC-20 `transfer` with `transfer.to` pinned to
 *   `mandate.returnTo`, one rule per token the wallet can hold.
 *
 * Were they to expire, an expired agent's collateral would be stranded until
 * the owner re-PATCHed the policy. Revocation does not stop them either, since
 * SEN-17: it replaces the policy with {@link compileRevocationRules}, which is
 * these two and nothing else, so a revoked agent can be emptied but can no
 * longer take any risk.
 *
 * Every transaction rule also pins `ethereum_transaction.value` (SEN-146):
 * `lte cap` on the native-MON deposit, where the value IS the money, and
 * `lte 0x0` — zero, for an unsigned field — on every other call. Without it
 * the enclave would sign an approve, a `batch` or a return transfer carrying
 * the wallet's MON along with it, to a contract the mandate never meant to pay.
 * The builders take the value bound as an argument so a new rule cannot forget
 * it.
 *
 * SENTE'S BUILDER FEE (SEN-184). Compiled with `kuruBuilder`, the Kuru block
 * gains two kinds of rule:
 *
 * - **approve the Sente fee**: `AccountCore.approveBuilder` with `builder`
 *   pinned to Sente's address, `maxFeePps lte` its rate and `expiry lte` the
 *   mandate's `expiresAt`, value 0. This is the one rule that decides who can
 *   be paid a builder fee from the agent's account, and how much.
 * - **trade with the Sente fee**, one per market: the two builder-config
 *   `batch` overloads, matched by function name only. Privy need not read the
 *   `builderConfig` tuple: AccountCore refuses any builder the account has not
 *   approved (`BuilderApprovalNotFound`) and any rate above the approval
 *   (`BuilderFeeTooHigh`), and the only approval the agent can sign is the one
 *   above.
 *
 * Without `kuruBuilder` neither is emitted and the policy is byte-identical to
 * what it was before SEN-184, so an agent whose live policy predates it simply
 * keeps trading through the plain overloads (`AgentRecord.kuruBuilder`).
 *
 * Raw `eth_signTransaction` only, never Privy's Transfer API: Transfer
 * policies are evaluated at the API level, outside the enclave
 * (docs/privy-policy-enforcement.md).
 */
import {
  ERC20_TRANSFER_ABI,
  KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ACCOUNT_CORE_WITHDRAW_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_ORDERBOOK_BUILDER_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  NATIVE_TOKEN,
} from '@sente/venues/kuru';
import {
  ERC20_APPROVE_ABI,
  PERPL_API_KEY_TYPED_DATA,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
} from '@sente/venues/perpl';
import { getAddress, getTypesForEIP712Domain, isAddressEqual, type Abi, type Address } from 'viem';

import type { Mandate } from './mandate.ts';
import {
  calldataAddressEq,
  calldataFunctionEq,
  calldataUintLte,
  hexUint,
  txChainIdEq,
  txToEq,
  txValueLte,
  typedDataChainIdEq,
  typedDataMessageEq,
  typedDataVerifyingContractEq,
  unixTimestampLte,
  type AllowRule,
  type HexUint,
  type PolicyCondition,
  type PolicyMethod,
  type PolicyRule,
  type TypedDataDescriptor,
} from './privy/policy-types.ts';

/**
 * Perpl's API-key struct, as a typed-data message condition names it.
 *
 * `EIP712Domain` is spelled out beside the struct, exactly as the Privy
 * client sends it (viem's `getTypesForEIP712Domain`, which for Perpl's domain
 * includes `salt`). SEN-3's live probe: with the struct alone the condition
 * never matched and every enrollment was refused; with the domain type added,
 * the same condition signed.
 */
export const PERPL_ENROLL_TYPED_DATA: TypedDataDescriptor = {
  types: {
    EIP712Domain: getTypesForEIP712Domain({ domain: PERPL_API_KEY_TYPED_DATA.domain }),
    PerplRegisterApiKey: PERPL_API_KEY_TYPED_DATA.types.PerplRegisterApiKey,
  },
  primary_type: PERPL_API_KEY_TYPED_DATA.primaryType,
};

function rule(name: string, method: PolicyMethod, conditions: PolicyCondition[]): AllowRule {
  return { name, method, conditions, action: 'ALLOW' };
}

/**
 * A transaction rule builder. `maxValue` is the most native MON the call may
 * carry; 0 unless the call is the native deposit itself (SEN-146).
 */
type TxRule = (name: string, conditions: PolicyCondition[], maxValue?: bigint) => AllowRule;

function kuruTokenSymbol(token: Address): string {
  return (
    Object.values(KURU_TESTNET_TOKENS).find((t) => isAddressEqual(t.address, token))?.symbol ??
    token
  );
}

function kuruMarketSymbol(market: Address): string {
  return KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, market))?.symbol ?? market;
}

/**
 * The builder an agent's orders may pay (SEN-184): Sente's, at most at
 * `maxFeePps` parts per ten million.
 */
export interface KuruBuilderGrant {
  readonly address: Address;
  readonly maxFeePps: number;
}

/** What `compileMandate` takes besides the mandate: server config, not the user's terms. */
export interface CompileOptions {
  /** Sente's builder fee; absent or `null`, no builder rule is compiled. */
  readonly kuruBuilder?: KuruBuilderGrant | null;
  /**
   * The agent wallet the policy will govern, when it already exists (an amend
   * or a revoke, never a hire: Privy creates the policy before the wallet).
   * With it, every Kuru deposit rule pins `deposit.rootOwner` to this address,
   * so the agent can only fund its OWN Kuru account. Without it the rule cannot
   * pin the owner and a deposit could credit any account — a widening over Set
   * C's `deposit(token, amount)`, which always credited the caller (SEN-185).
   * The pinning amend that follows every hire closes it (SEN-188).
   */
  readonly agentAddress?: Address | null;
}

/**
 * Whether `compileMandate` emits any Kuru deposit rule for this mandate — that
 * is, whether a policy compiled WITHOUT `agentAddress` (every hire) lets the
 * agent credit an arbitrary Kuru account until it is re-PATCHed with the pin
 * (SEN-188). `false` means there is nothing to pin: no Kuru, or no token the
 * mandate lets it deposit.
 */
export function compilesKuruDeposit(mandate: Mandate): boolean {
  return mandate.venues.includes('kuru') && Object.keys(mandate.kuru.maxDepositAtoms).length > 0;
}

/** The approve-the-fee rule's name, so `readBackCaps` and a reader can find it. */
export const KURU_APPROVE_BUILDER_RULE = 'Kuru: approve the Sente fee';

function kuruBuilderRules(mandate: Mandate, tx: TxRule, builder: KuruBuilderGrant): AllowRule[] {
  const abi = KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI;
  const rules = [
    tx(KURU_APPROVE_BUILDER_RULE, [
      txToEq(KURU_TESTNET_CONTRACTS.accountCore),
      calldataAddressEq(abi, 'approveBuilder.builder', builder.address),
      calldataUintLte(abi, 'approveBuilder.maxFeePps', BigInt(builder.maxFeePps)),
      // Never past the mandate: an approval cannot outlive the authority to trade.
      calldataUintLte(abi, 'approveBuilder.expiry', BigInt(mandate.expiresAt)),
    ]),
  ];
  for (const market of mandate.kuru.markets) {
    rules.push(
      tx(`Kuru: trade ${kuruMarketSymbol(market)} with the Sente fee`, [
        txToEq(market),
        calldataFunctionEq(KURU_ORDERBOOK_BUILDER_BATCH_ABI, 'batch'),
      ]),
    );
  }
  return rules;
}

function kuruRules(mandate: Mandate, tx: TxRule, agentAddress: Address | null): AllowRule[] {
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const rules: AllowRule[] = [];

  for (const [key, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    const token = getAddress(key);
    const symbol = kuruTokenSymbol(token);
    const deposit = [
      txToEq(accountCore),
      ...(agentAddress
        ? [calldataAddressEq(KURU_ACCOUNT_CORE_DEPOSIT_ABI, 'deposit.rootOwner', agentAddress)]
        : []),
      calldataAddressEq(KURU_ACCOUNT_CORE_DEPOSIT_ABI, 'deposit.token', token),
      calldataUintLte(KURU_ACCOUNT_CORE_DEPOSIT_ABI, 'deposit.amount', cap),
    ];
    if (isAddressEqual(token, NATIVE_TOKEN)) {
      // Native MON has no approval; the money is the transaction's value.
      rules.push(tx(`Kuru: deposit ${symbol}`, deposit, cap));
      continue;
    }
    rules.push(
      tx(`Kuru: approve ${symbol} to AccountCore`, [
        txToEq(token),
        calldataAddressEq(ERC20_APPROVE_ABI, 'approve.spender', accountCore),
        calldataUintLte(ERC20_APPROVE_ABI, 'approve.amount', cap),
      ]),
    );
    rules.push(tx(`Kuru: deposit ${symbol}`, deposit));
  }

  // One rule per market: `to` is the allowlist. Order size inside `batch` is
  // not capped here — see mandate.ts.
  for (const market of mandate.kuru.markets) {
    rules.push(
      tx(`Kuru: trade ${kuruMarketSymbol(market)}`, [
        txToEq(market),
        calldataFunctionEq(KURU_ORDERBOOK_BATCH_ABI, 'batch'),
      ]),
    );
  }
  return rules;
}

function perplRules(mandate: Mandate, tx: TxRule, expiry: PolicyCondition): AllowRule[] {
  const { exchange, collateral } = PERPL_TESTNET_CONTRACTS;
  const cap = mandate.perpl.maxCollateralAtoms;
  return [
    tx('Perpl: approve AUSD to Exchange', [
      txToEq(collateral),
      calldataAddressEq(ERC20_APPROVE_ABI, 'approve.spender', exchange),
      calldataUintLte(ERC20_APPROVE_ABI, 'approve.amount', cap),
    ]),
    tx('Perpl: open account', [
      txToEq(exchange),
      calldataUintLte(PERPL_EXCHANGE_ABI, 'createAccount.amountCNS', cap),
    ]),
    tx('Perpl: allow order forwarding', [
      txToEq(exchange),
      calldataFunctionEq(PERPL_EXCHANGE_ABI, 'allowOrderForwarding'),
    ]),
    // The domain names no contract (verifyingContract is the zero address), so
    // the message's fixed statement is what pins this to API-key enrollment.
    rule('Perpl: enroll an API key', 'eth_signTypedData_v4', [
      typedDataChainIdEq(mandate.chainId),
      expiry,
      typedDataVerifyingContractEq(PERPL_API_KEY_TYPED_DATA.domain.verifyingContract),
      typedDataMessageEq(PERPL_ENROLL_TYPED_DATA, 'statement', PERPL_API_KEY_TYPED_DATA.statement),
    ]),
  ];
}

/**
 * The recovery rule's name, so a reader can tell it from the risk-taking Kuru
 * rules. It was 'Kuru: withdraw to its own wallet' while AccountCore paid the
 * caller (Set C); a live policy still carrying that name predates SEN-185 and
 * names the retired AccountCore.
 */
export const KURU_WITHDRAW_RULE = 'Kuru: withdraw to the owner';

/**
 * Every ERC-20 an agent's wallet can come to hold on testnet: Kuru's tokens and
 * Perpl's AUSD.
 *
 * Exported because `POST /agents/:id/return` walks exactly this list (SEN-17).
 * A token the policy has no rule for is a transfer the enclave would refuse, so
 * the route and the rules must read from one place, not two.
 */
export function returnableTokens(): { symbol: string; address: Address }[] {
  const kuru = Object.values(KURU_TESTNET_TOKENS).filter(
    (t) => !isAddressEqual(t.address, NATIVE_TOKEN),
  );
  return [...kuru, { symbol: 'AUSD', address: PERPL_TESTNET_CONTRACTS.collateral }];
}

/**
 * One rule per token, whatever the venues: the point is getting everything
 * back, including what an earlier mandate let the agent hold. Native MON is not
 * covered — a value rule to `returnTo` would also let the agent call the
 * owner's account — so leftover gas stays with the agent.
 */
function returnRules(returnTo: Address, recovery: TxRule): AllowRule[] {
  return returnableTokens().map((token) =>
    recovery(`Return ${token.symbol} to the owner`, [
      txToEq(token.address),
      calldataAddressEq(ERC20_TRANSFER_ABI, 'transfer.to', returnTo),
    ]),
  );
}

/** `AccountCore.withdraw` and nothing else, paying `returnTo` and no one else. */
function kuruWithdrawRule(recovery: TxRule, returnTo: Address): AllowRule {
  return recovery(KURU_WITHDRAW_RULE, [
    txToEq(KURU_TESTNET_CONTRACTS.accountCore),
    calldataAddressEq(KURU_ACCOUNT_CORE_WITHDRAW_ABI, 'withdraw.recipient', returnTo),
  ]);
}

/** A rule builder with the chain pinned and no expiry — see the module comment. */
function recoveryRuleBuilder(mandate: Mandate): TxRule {
  const chain = txChainIdEq(mandate.chainId);
  return (name, conditions, maxValue = 0n) =>
    rule(name, 'eth_signTransaction', [chain, ...conditions, txValueLte(maxValue)]);
}

/**
 * The mandate as Privy rules. A venue not in `mandate.venues` contributes
 * nothing, so an empty `venues` and no `returnTo` compile to `[]` — a policy
 * that signs nothing.
 */
export function compileMandate(mandate: Mandate, options: CompileOptions = {}): AllowRule[] {
  const chain = txChainIdEq(mandate.chainId);
  const expiry = unixTimestampLte(mandate.expiresAt);
  const tx: TxRule = (name, conditions, maxValue = 0n) =>
    rule(name, 'eth_signTransaction', [chain, expiry, ...conditions, txValueLte(maxValue)]);
  const recovery = recoveryRuleBuilder(mandate);

  const rules: AllowRule[] = [];
  if (mandate.venues.includes('kuru')) {
    rules.push(...kuruRules(mandate, tx, options.agentAddress ?? null));
    if (options.kuruBuilder && mandate.kuru.markets.length > 0) {
      rules.push(...kuruBuilderRules(mandate, tx, options.kuruBuilder));
    }
    if (mandate.returnTo) rules.push(kuruWithdrawRule(recovery, mandate.returnTo));
  }
  if (mandate.venues.includes('perpl')) rules.push(...perplRules(mandate, tx, expiry));
  if (mandate.returnTo) rules.push(...returnRules(mandate.returnTo, recovery));
  return rules;
}

/**
 * THE POLICY A REVOKED AGENT IS LEFT WITH (SEN-17): the recovery rules of
 * {@link compileMandate} and nothing else — a subset of what the agent could
 * already sign, never a widening.
 *
 * Revocation used to replace the policy with `[]`, which stops the agent dead
 * and also strands whatever it is holding: an ERC-20 balance in a wallet whose
 * key may sign nothing cannot be moved by anyone, ever, and a revoked agent
 * cannot be amended to re-arm the rules. The owner's money would then depend on
 * somebody re-PATCHing the policy with the owner key, which in `device` mode is
 * a phone ceremony and in the worst case a lost key.
 *
 * So a revoke leaves the exit open. What survives can only move money toward
 * the owner — `AccountCore.withdraw` with its recipient pinned to `returnTo`, and an ERC-20
 * `transfer` pinned to `mandate.returnTo` — and every rule that lets the agent
 * take risk is gone, so a revoked agent still cannot approve, deposit, trade or
 * enroll anything. It is also why these rules carry no expiry: see the module
 * comment.
 *
 * A mandate with no `returnTo` and no Kuru venue compiles to `[]` here, exactly
 * as before. That is the fail-closed case, not the intended one: hire sets
 * `returnTo` from the owner's registered wallet, so an agent hired through the
 * product always has a way out.
 */
export function compileRevocationRules(mandate: Mandate): AllowRule[] {
  const recovery = recoveryRuleBuilder(mandate);
  const rules: AllowRule[] = [];
  if (mandate.returnTo) {
    if (mandate.venues.includes('kuru')) rules.push(kuruWithdrawRule(recovery, mandate.returnTo));
    rules.push(...returnRules(mandate.returnTo, recovery));
  }
  return rules;
}

/** The caps a policy actually enforces, read back off its rules. */
export interface PolicyCaps {
  /** Tightest per-transaction ceiling on moving each token into AccountCore, in atoms. */
  readonly kuruDepositAtoms: Readonly<Record<Address, bigint>>;
  /** OrderBooks a `batch` rule allows. */
  readonly kuruMarkets: readonly Address[];
  /** Tightest per-transaction ceiling on AUSD reaching the Exchange; `null` if no rule caps it. */
  readonly perplCollateralAtoms: bigint | null;
  /** Earliest expiry across the rules; `null` if none carries one. Recovery rules carry none. */
  readonly expiresAt: number | null;
  /** Whether a rule lets the wallet call `AccountCore.withdraw` (to the pinned recipient). */
  readonly kuruWithdraw: boolean;
  /** The one address an ERC-20 `transfer` may pay; `null` if no rule allows a transfer. */
  readonly returnTo: Address | null;
  /**
   * The builder an `approveBuilder` rule lets the wallet approve, and the most
   * it may charge (SEN-184); `null` when the policy has no such rule, i.e. it
   * predates SEN-184 or was compiled with the fee off.
   */
  readonly kuruBuilder: KuruBuilderGrant | null;
}

function minBig(a: bigint | null, b: bigint): bigint {
  return a === null || b < a ? b : a;
}

/**
 * Read the caps back out of a policy's rules — the policy is the authority,
 * not whatever mandate literal a caller is holding (turnstile's
 * `policySpendCapUsd`, generalised). Where two rules bound the same money (an
 * approve and its deposit), the tighter one wins, because that is what the
 * enclave will actually let through.
 *
 * Throws if a matched bound is not an integer, rather than guessing at a policy
 * this package did not write.
 */
export function readBackCaps(rules: readonly Pick<PolicyRule, 'conditions'>[]): PolicyCaps {
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const exchange = PERPL_TESTNET_CONTRACTS.exchange;
  const kuruDepositAtoms: Record<Address, bigint> = {};
  const kuruMarkets: Address[] = [];
  let perplCollateralAtoms: bigint | null = null;
  let expiresAt: number | null = null;
  let kuruWithdraw = false;
  let returnTo: Address | null = null;
  let kuruBuilder: KuruBuilderGrant | null = null;

  const lowerKuru = (token: string, cap: bigint): void => {
    const key = getAddress(token);
    kuruDepositAtoms[key] = minBig(kuruDepositAtoms[key] ?? null, cap);
  };

  for (const { conditions } of rules) {
    const find = (source: string, field: string, operator: string): string | undefined =>
      conditions.find(
        (c) => c.field_source === source && c.field === field && c.operator === operator,
      )?.value;
    const to = find('ethereum_transaction', 'to', 'eq');

    const timestamp = find('system', 'current_unix_timestamp', 'lte');
    if (timestamp !== undefined) {
      const seconds = Number(BigInt(timestamp));
      expiresAt = expiresAt === null ? seconds : Math.min(expiresAt, seconds);
    }
    if (to === undefined) continue;

    const depositCap = find('ethereum_calldata', 'deposit.amount', 'lte');
    const depositToken = find('ethereum_calldata', 'deposit.token', 'eq');
    if (depositCap && depositToken && isAddressEqual(to as Address, accountCore)) {
      lowerKuru(depositToken, BigInt(depositCap));
    }

    const approveCap = find('ethereum_calldata', 'approve.amount', 'lte');
    const spender = find('ethereum_calldata', 'approve.spender', 'eq');
    if (approveCap && spender) {
      if (isAddressEqual(spender as Address, accountCore)) lowerKuru(to, BigInt(approveCap));
      else if (isAddressEqual(spender as Address, exchange)) {
        perplCollateralAtoms = minBig(perplCollateralAtoms, BigInt(approveCap));
      }
    }

    const openCap = find('ethereum_calldata', 'createAccount.amountCNS', 'lte');
    if (openCap && isAddressEqual(to as Address, exchange)) {
      perplCollateralAtoms = minBig(perplCollateralAtoms, BigInt(openCap));
    }

    const fn = find('ethereum_calldata', 'function_name', 'eq');
    if (fn === 'batch') {
      const market = getAddress(to);
      if (!kuruMarkets.includes(market)) kuruMarkets.push(market);
    }
    const withdrawTo = find('ethereum_calldata', 'withdraw.recipient', 'eq');
    if (withdrawTo && isAddressEqual(to as Address, accountCore)) kuruWithdraw = true;

    const builder = find('ethereum_calldata', 'approveBuilder.builder', 'eq');
    const builderFee = find('ethereum_calldata', 'approveBuilder.maxFeePps', 'lte');
    if (builder && builderFee && isAddressEqual(to as Address, accountCore)) {
      kuruBuilder = { address: getAddress(builder), maxFeePps: Number(BigInt(builderFee)) };
    }

    const recipient = find('ethereum_calldata', 'transfer.to', 'eq');
    if (recipient) {
      if (returnTo !== null && !isAddressEqual(returnTo, recipient as Address)) {
        throw new Error(
          `readBackCaps: transfers pinned to two addresses, ${returnTo} and ${recipient}`,
        );
      }
      returnTo = getAddress(recipient);
    }
  }

  return {
    kuruDepositAtoms,
    kuruMarkets,
    perplCollateralAtoms,
    expiresAt,
    kuruWithdraw,
    returnTo,
    kuruBuilder,
  };
}

/**
 * The body of a Privy aggregation for `mandate.rollingCap`, plus the bound a
 * rule referencing it must apply.
 *
 * **Unverified.** The field names follow docs/privy-policy-enforcement.md
 * (`duration_seconds`, 3600–259200) and Privy's aggregation docs as read, but
 * no aggregation has been created against the live API yet. A rule can only
 * reference an aggregation by the id Privy assigns on creation, so wiring the
 * reference condition is left to the Privy client (MOV-278), which can prove
 * the shape live. `null` when the mandate has no rolling cap.
 *
 * SEN-3's live probe corrected the window key (`seconds`) and found the
 * reference shape: `aggregationLte(id, cap)` in privy/policy-types.ts. What it
 * proved end to end is in docs/privy-policy-enforcement.md.
 */
export interface RollingCapAggregationDraft {
  readonly name: string;
  readonly method: 'eth_signTransaction';
  readonly metric: {
    readonly field_source: 'ethereum_calldata';
    readonly field: 'approve.amount';
    readonly abi: Abi;
    readonly function: 'sum';
  };
  /**
   * `seconds`, not `duration_seconds`: Privy answers the latter with
   * `400 invalid_aggregation_format`, "Required at window.seconds; Unrecognized
   * key(s) in object: 'duration_seconds'" (SEN-3 live probe, 2026-09-11).
   */
  readonly window: { readonly type: 'rolling'; readonly seconds: number };
  readonly conditions: readonly PolicyCondition[];
  /** The `lte` bound on the aggregated sum. */
  readonly cap: HexUint;
}

export function compileRollingCap(mandate: Mandate): RollingCapAggregationDraft | null {
  const rolling = mandate.rollingCap;
  if (!rolling) return null;
  return {
    name: `Sente rolling cap, ${rolling.windowSeconds}s`,
    method: 'eth_signTransaction',
    metric: {
      field_source: 'ethereum_calldata',
      field: 'approve.amount',
      abi: ERC20_APPROVE_ABI,
      function: 'sum',
    },
    window: { type: 'rolling', seconds: rolling.windowSeconds },
    conditions: [txChainIdEq(mandate.chainId), txToEq(rolling.token)],
    cap: hexUint(rolling.capAtoms),
  };
}
