/**
 * The mandate's fingerprint (SEN-194): a hash anyone can recompute from the
 * mandate an agent publishes, and compare with the one Sente anchors on chain
 * through the agent's ERC-8004 identity.
 *
 * `mandateHash` is keccak256 over the UTF-8 bytes of {@link canonicalMandateJson}:
 * RFC 8785 canonical JSON ({@link canonicalize}, sorted keys, no whitespace) of
 * the mandate with every representation choice taken away —
 *
 * - addresses EIP-55 checksummed, whatever case they arrived in;
 * - atoms as decimal strings (a bigint is not JSON), decimals without trailing
 *   zeros (`"250.50"` and `"250.5"` are one cap);
 * - sets sorted (`venues`, both venues' `markets`): their order changes nothing
 *   the agent may do, so it must not change the hash;
 * - optional fields absent, never `null`;
 *
 * and with the contracts the policy pins that the mandate itself does not name:
 * the Kuru deployment and its AccountCore (`KURU_DEPLOYMENT`, SEN-189 — the same
 * mandate means different custody on Set C and Set D), and Perpl's Exchange and
 * collateral token. Every other field — expiry, caps, leverage, markets, the
 * return address, the rolling cap — is in it as written, so changing any of
 * them changes the hash.
 *
 * `policyHash` is keccak256 of the canonical JSON of the compiled Privy rules
 * (`compileMandate` / `compileRevocationRules`): the exact rule list the enclave
 * was given, so a reader who recompiles the published mandate can check the
 * enclave holds that policy and not merely the words around it.
 *
 * `schema` is in the hashed object so a future change to this function is a
 * new schema, never a silent change of what an old hash meant.
 */
import { kuruDeployment, type KuruDeploymentId } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from 'viem';

import type { Mandate } from './mandate.ts';
import { canonicalize } from './privy/canonicalize.ts';
import type { PolicyRule } from './privy/policy-types.ts';

/** In the hashed object: bump it whenever `canonicalMandate` changes shape. */
export const MANDATE_HASH_SCHEMA = 'sente.mandate/1';

export interface CanonicalMandateOptions {
  /** The Kuru deployment the mandate is read against. Default: the active one. */
  readonly kuruDeployment?: KuruDeploymentId;
}

/** `"250.50"` -> `"250.5"`, `"7.000"` -> `"7"`. Input is already a non-negative decimal. */
export function normalizeDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const integer = whole.replace(/^0+(?=\d)/, '');
  return trimmed ? `${integer}.${trimmed}` : integer;
}

/** A JS number as its shortest round-trip decimal (ECMAScript `Number::toString`). */
function numberDecimal(value: number): string {
  const text = String(value);
  return /e/i.test(text) ? text : normalizeDecimal(text);
}

function sortedAddresses(values: readonly string[]): Address[] {
  return values.map((v) => getAddress(v)).sort();
}

/**
 * The mandate as the plain, JSON-safe object that is hashed. Exported so a
 * verifier can print what it hashed, not just the digest.
 */
export function canonicalMandate(
  mandate: Mandate,
  options: CanonicalMandateOptions = {},
): Record<string, unknown> {
  const deployment = kuruDeployment(options.kuruDeployment);
  const maxDepositAtoms: Record<string, string> = {};
  for (const [token, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    maxDepositAtoms[getAddress(token)] = cap.toString();
  }
  return {
    schema: MANDATE_HASH_SCHEMA,
    version: mandate.version,
    chainId: mandate.chainId,
    expiresAt: mandate.expiresAt,
    venues: [...mandate.venues].sort(),
    kuru: {
      markets: sortedAddresses(mandate.kuru.markets),
      maxDepositAtoms,
    },
    perpl: {
      maxCollateralAtoms: mandate.perpl.maxCollateralAtoms.toString(),
      maxLeverage: numberDecimal(mandate.perpl.maxLeverage),
      markets: [...mandate.perpl.markets].sort(),
    },
    maxOrderNotional: normalizeDecimal(mandate.maxOrderNotional),
    ...(mandate.rollingCap
      ? {
          rollingCap: {
            windowSeconds: mandate.rollingCap.windowSeconds,
            capAtoms: mandate.rollingCap.capAtoms.toString(),
            token: getAddress(mandate.rollingCap.token),
          },
        }
      : {}),
    ...(mandate.returnTo ? { returnTo: getAddress(mandate.returnTo) } : {}),
    contracts: {
      kuruDeployment: deployment.id,
      kuruAccountCore: getAddress(deployment.contracts.accountCore),
      perplExchange: getAddress(PERPL_TESTNET_CONTRACTS.exchange),
      perplCollateral: getAddress(PERPL_TESTNET_CONTRACTS.collateral),
    },
  };
}

/** The exact bytes `mandateHash` hashes, as a string. */
export function canonicalMandateJson(
  mandate: Mandate,
  options: CanonicalMandateOptions = {},
): string {
  return canonicalize(canonicalMandate(mandate, options));
}

/** keccak256 of the canonical mandate. */
export function mandateHash(mandate: Mandate, options: CanonicalMandateOptions = {}): Hex {
  return keccak256(stringToBytes(canonicalMandateJson(mandate, options)));
}

/**
 * keccak256 of the canonical compiled rules, in the order the compiler emits
 * them (rule order is part of what is PATCHed to Privy).
 */
export function policyHash(rules: readonly PolicyRule[]): Hex {
  return keccak256(stringToBytes(canonicalize(rules)));
}
