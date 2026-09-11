/**
 * The mandate compiled to Privy policy rules — layer 2, the half that runs in
 * the enclave rather than on our server.
 *
 * Only ALLOW rules. Privy is deny-by-default (a policy with zero rules signs
 * nothing), and a DENY is a veto over requests an ALLOW already matched, so a
 * catch-all `{ method: '*', action: 'DENY' }` denies everything — turnstile
 * learned that live on 2026-09-07. There is deliberately none here.
 *
 * Every rule carries two conditions besides its own:
 *
 * - the chain: `ethereum_transaction.chain_id eq 10143` on transaction rules,
 *   `ethereum_typed_data_domain.chainId eq 10143` on the typed-data rule (a
 *   typed-data request has no transaction to read a chain id from);
 * - the expiry: `system.current_unix_timestamp lte expiresAt`, so a mandate
 *   stops signing at its deadline by the enclave's own clock, whether or not
 *   anyone remembers to revoke it.
 *
 * Raw `eth_signTransaction` only, never Privy's Transfer API: Transfer
 * policies are evaluated at the API level, outside the enclave
 * (docs/privy-policy-enforcement.md).
 */
import {
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
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
import { getAddress, isAddressEqual, type Abi, type Address } from 'viem';

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

/** Perpl's API-key struct, as a typed-data message condition names it. */
export const PERPL_ENROLL_TYPED_DATA: TypedDataDescriptor = {
  types: { PerplRegisterApiKey: PERPL_API_KEY_TYPED_DATA.types.PerplRegisterApiKey },
  primary_type: PERPL_API_KEY_TYPED_DATA.primaryType,
};

function rule(name: string, method: PolicyMethod, conditions: PolicyCondition[]): AllowRule {
  return { name, method, conditions, action: 'ALLOW' };
}

type TxRule = (name: string, conditions: PolicyCondition[]) => AllowRule;

function kuruTokenSymbol(token: Address): string {
  return (
    Object.values(KURU_TESTNET_TOKENS).find((t) => isAddressEqual(t.address, token))?.symbol ??
    token
  );
}

function kuruMarketSymbol(market: Address): string {
  return KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, market))?.symbol ?? market;
}

function kuruRules(mandate: Mandate, tx: TxRule): AllowRule[] {
  const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
  const rules: AllowRule[] = [];

  for (const [key, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    const token = getAddress(key);
    const symbol = kuruTokenSymbol(token);
    const deposit = [
      txToEq(accountCore),
      calldataAddressEq(KURU_ACCOUNT_CORE_DEPOSIT_ABI, 'deposit.token', token),
      calldataUintLte(KURU_ACCOUNT_CORE_DEPOSIT_ABI, 'deposit.amount', cap),
    ];
    if (isAddressEqual(token, NATIVE_TOKEN)) {
      // Native MON has no approval; the money is the transaction's value.
      rules.push(tx(`Kuru: deposit ${symbol}`, [...deposit, txValueLte(cap)]));
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
 * The mandate as Privy rules. A venue not in `mandate.venues` contributes
 * nothing, so an empty `venues` compiles to `[]` — a policy that signs nothing.
 */
export function compileMandate(mandate: Mandate): AllowRule[] {
  const expiry = unixTimestampLte(mandate.expiresAt);
  const tx: TxRule = (name, conditions) =>
    rule(name, 'eth_signTransaction', [txChainIdEq(mandate.chainId), expiry, ...conditions]);

  const rules: AllowRule[] = [];
  if (mandate.venues.includes('kuru')) rules.push(...kuruRules(mandate, tx));
  if (mandate.venues.includes('perpl')) rules.push(...perplRules(mandate, tx, expiry));
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
  /** Earliest expiry across the rules; `null` if none carries one. */
  readonly expiresAt: number | null;
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

    if (find('ethereum_calldata', 'function_name', 'eq') === 'batch') {
      const market = getAddress(to);
      if (!kuruMarkets.includes(market)) kuruMarkets.push(market);
    }
  }

  return { kuruDepositAtoms, kuruMarkets, perplCollateralAtoms, expiresAt };
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
  readonly window: { readonly type: 'rolling'; readonly duration_seconds: number };
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
    window: { type: 'rolling', duration_seconds: rolling.windowSeconds },
    conditions: [txChainIdEq(mandate.chainId), txToEq(rolling.token)],
    cap: hexUint(rolling.capAtoms),
  };
}
