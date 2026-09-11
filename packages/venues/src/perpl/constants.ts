/**
 * Perpl on Monad testnet (10143) — the values that are fixed per deployment.
 *
 * The adapter itself reads the Exchange and collateral token live from
 * `GET /api/v1/pub/context` (see `onboardingParams`), and that stays the
 * authority for anything it sends. These constants exist for consumers that
 * must name the contracts BEFORE any request is made — a Privy policy compiled
 * by `@sente/mandate` is created ahead of time and cannot read the context. If
 * `onboardingParams(context)` ever disagrees with this table, the policy is
 * stale, not the context.
 *
 * Addresses: docs/monad-testnet-assets.md (Exchange deployed; AUSD `name()`,
 * `symbol()` and `decimals()` read on chain, and confirmed as the token
 * `createAccount` pulls by tracing it).
 */
import type { Address, Hex } from 'viem';

export const PERPL_TESTNET_CHAIN_ID = 10143;

export const PERPL_TESTNET_CONTRACTS = {
  /** The Perpl Exchange proxy: `createAccount`, `allowOrderForwarding`, deposits. */
  exchange: '0x1964C32f0bE608E7D29302AFF5E61268E72080cc',
  /** Agora AUSD, the collateral token. NOT the "Test USD" the api-docs README names. */
  collateral: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
} as const satisfies Record<string, Address>;

/** AUSD is 6 decimals, not 18. */
export const PERPL_COLLATERAL_DECIMALS = 6;

/**
 * The EIP-712 envelope of Perpl's API-key enrollment (`POST /v1/api-key/payload`).
 *
 * Perpl serves this per request rather than publishing it, so these values are
 * observed, not specified: the domain names no contract (`verifyingContract`
 * is the zero address), which is why a policy that wants to pin enrollment
 * also has to match on the message's fixed `statement`.
 *
 * **Correction (2026-09-11, SEN-6):** first read on 2026-09-10 with a 6-field
 * `PerplRegisterApiKey` (signer, statement, publicKey, scope, label, time — the
 * `enroll.test.ts` fixture keeps that shape). By 2026-09-11 the live payload
 * carried 11 fields: `expiresAt`, `ipCidrs`, `origin`, `builderId` and
 * `maxBuilderFeePer100K` were added before `time`. A Privy typed-data message
 * condition matches only when its `types` equal the request's exactly, so a
 * policy compiled from the old struct refused every real enrollment
 * (`policy_violation`) — the enclave failing closed. If Perpl changes the
 * struct again, update this, recompile, and PATCH every agent policy.
 *
 * `domain.salt` is NOT fixed: two reads a day apart differed (`…6aa2f731…`,
 * `…6aa3eb20…`, apparently time-derived). Only its presence matters here — it
 * adds `salt` to `EIP712Domain`; no policy compares its value.
 */
export const PERPL_API_KEY_TYPED_DATA = {
  domain: {
    name: 'perpl.xyz',
    version: '1',
    chainId: PERPL_TESTNET_CHAIN_ID,
    verifyingContract: '0x0000000000000000000000000000000000000000' as Address,
    salt: '0x00000000000000000000000000000000000000006aa2f731368ca5c38d4d3fb0' as Hex,
  },
  primaryType: 'PerplRegisterApiKey',
  types: {
    PerplRegisterApiKey: [
      { name: 'signer', type: 'address' },
      { name: 'statement', type: 'string' },
      { name: 'publicKey', type: 'string' },
      { name: 'scope', type: 'string' },
      { name: 'label', type: 'string' },
      { name: 'expiresAt', type: 'string' },
      { name: 'ipCidrs', type: 'string' },
      { name: 'origin', type: 'string' },
      { name: 'builderId', type: 'string' },
      { name: 'maxBuilderFeePer100K', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  statement: 'I authorize the creation of Perpl API key with the specified scope and parameters',
} as const;
