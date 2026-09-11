/**
 * Privy policy shapes, and the only way this package builds a condition.
 *
 * Two rules every builder below applies, because both failures are silent at
 * Privy (turnstile learned each live on 2026-09-07, `docs/privy-mandate.md`
 * there):
 *
 *  1. **Every address goes through `getAddress()`.** Privy stores a condition's
 *     address EIP-55 checksummed and compares it against the request verbatim,
 *     so a lowercase value fails the match and lands in deny-by-default as a
 *     `policy_violation` that never says the two were the same address.
 *  2. **Every uint bound is a `0x` hex string.** A decimal string is refused
 *     outright by parts of Privy's API, a JS number cannot hold a wei-scale
 *     amount, and a `bigint` is not JSON. Hex is the one form that is exact,
 *     serializable, and was accepted for a calldata `lte` bound live.
 *
 * A rule's `action` is typed `'ALLOW' | 'DENY'` because a policy read back from
 * Privy may contain either; what this package *compiles* is {@link AllowRule}
 * only. Privy is deny-by-default and a DENY is a veto over rules an ALLOW
 * already matched, so a catch-all DENY would refuse everything.
 */
import { getAddress, type Abi } from 'viem';

export type PolicyMethod = 'eth_signTransaction' | 'eth_signTypedData_v4';

export type PolicyOperator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

/** A non-negative integer as Privy compares it: `0x`-prefixed, lowercase, no padding. */
export type HexUint = `0x${string}`;

/** Which typed-data struct a message condition reads, as Privy needs it spelled. */
export interface TypedDataDescriptor {
  readonly types: Readonly<
    Record<string, readonly { readonly name: string; readonly type: string }[]>
  >;
  readonly primary_type: string;
}

export type PolicyCondition =
  | {
      readonly field_source: 'ethereum_transaction';
      readonly field: 'to' | 'value' | 'chain_id';
      readonly operator: PolicyOperator;
      readonly value: string;
    }
  | {
      readonly field_source: 'ethereum_calldata';
      /** `function_name`, or `<function>.<param>` named as in {@link abi}. */
      readonly field: string;
      readonly abi: Abi;
      readonly operator: PolicyOperator;
      readonly value: string;
    }
  | {
      readonly field_source: 'ethereum_typed_data_domain';
      readonly field: 'chainId' | 'verifyingContract';
      readonly operator: PolicyOperator;
      readonly value: string;
    }
  | {
      readonly field_source: 'ethereum_typed_data_message';
      readonly field: string;
      readonly typed_data: TypedDataDescriptor;
      readonly operator: PolicyOperator;
      readonly value: string;
    }
  | {
      readonly field_source: 'system';
      readonly field: 'current_unix_timestamp';
      readonly operator: PolicyOperator;
      readonly value: string;
    };

export interface PolicyRule {
  readonly name: string;
  readonly method: PolicyMethod;
  readonly conditions: readonly PolicyCondition[];
  readonly action: 'ALLOW' | 'DENY';
}

/** The only kind of rule `compileMandate` emits. */
export type AllowRule = PolicyRule & { readonly action: 'ALLOW' };

/** A policy as Privy returns it from `GET /v1/policies/{id}`. */
export interface Policy {
  readonly id: string;
  readonly version: '1.0';
  readonly name: string;
  readonly chain_type: 'ethereum';
  readonly rules: readonly (PolicyRule & { readonly id: string })[];
  readonly owner_id: string | null;
}

/** A non-negative integer as a {@link HexUint}. Throws on anything else. */
export function hexUint(value: bigint | number): HexUint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`hexUint: ${value} is not a safe integer`);
  }
  const big = BigInt(value);
  if (big < 0n) throw new RangeError(`hexUint: ${value} is negative`);
  return `0x${big.toString(16)}`;
}

export function txToEq(address: string): PolicyCondition {
  return {
    field_source: 'ethereum_transaction',
    field: 'to',
    operator: 'eq',
    value: getAddress(address),
  };
}

export function txChainIdEq(chainId: number): PolicyCondition {
  return {
    field_source: 'ethereum_transaction',
    field: 'chain_id',
    operator: 'eq',
    value: hexUint(chainId),
  };
}

export function txValueLte(max: bigint): PolicyCondition {
  return {
    field_source: 'ethereum_transaction',
    field: 'value',
    operator: 'lte',
    value: hexUint(max),
  };
}

export function calldataFunctionEq(abi: Abi, functionName: string): PolicyCondition {
  return {
    field_source: 'ethereum_calldata',
    field: 'function_name',
    abi,
    operator: 'eq',
    value: functionName,
  };
}

export function calldataAddressEq(abi: Abi, field: string, address: string): PolicyCondition {
  return {
    field_source: 'ethereum_calldata',
    field,
    abi,
    operator: 'eq',
    value: getAddress(address),
  };
}

export function calldataUintLte(abi: Abi, field: string, max: bigint): PolicyCondition {
  return { field_source: 'ethereum_calldata', field, abi, operator: 'lte', value: hexUint(max) };
}

export function typedDataChainIdEq(chainId: number): PolicyCondition {
  return {
    field_source: 'ethereum_typed_data_domain',
    field: 'chainId',
    operator: 'eq',
    value: hexUint(chainId),
  };
}

export function typedDataVerifyingContractEq(address: string): PolicyCondition {
  return {
    field_source: 'ethereum_typed_data_domain',
    field: 'verifyingContract',
    operator: 'eq',
    value: getAddress(address),
  };
}

export function typedDataMessageEq(
  typedData: TypedDataDescriptor,
  field: string,
  value: string,
): PolicyCondition {
  return {
    field_source: 'ethereum_typed_data_message',
    field,
    typed_data: typedData,
    operator: 'eq',
    value,
  };
}

/** Valid until and including `unixSeconds`, by the enclave's own clock. */
export function unixTimestampLte(unixSeconds: number): PolicyCondition {
  return {
    field_source: 'system',
    field: 'current_unix_timestamp',
    operator: 'lte',
    value: hexUint(unixSeconds),
  };
}
