/**
 * Sente's builder fee on Kuru (SEN-184).
 *
 * Every Kuru order Sente composes — a user's own trade and an agent's alike —
 * can carry Kuru's `builderConfig(builder, feePps)`, which pays `feePps` parts
 * per ten million of the notional to `builder` on top of Kuru's own fee.
 * Sente's builder is the treasury, and the rate is 10 bps.
 *
 * - `KURU_BUILDER_ADDRESS` — who is paid. Unset: the feature is OFF, and every
 *   order uses the plain `batch` overloads exactly as before.
 * - `KURU_BUILDER_FEE_PPS` — the rate, default 10000 (0.10%). The API refuses
 *   to boot above 10000, so a typo cannot charge users more than 10 bps.
 *
 * - `KURU_BUILDER_AGENTS=0` — keep the fee on users' own trades but out of
 *   agents' policies and orders. The fallback for a Privy that will not match
 *   the builder `batch` overloads (see docs/privy-policy-enforcement.md).
 *
 * Perpl orders never carry a Sente fee: Perpl's builder codes are issued by
 * hand and Sente has none.
 *
 * The phone pins the same pair at build time (`EXPO_PUBLIC_KURU_BUILDER_*`,
 * `apps/mobile/src/trade/kuruBuilder.ts`) and refuses any builder it was not
 * built with; `GET /trade/capabilities` publishes this config so a mismatch
 * turns manual trading off instead of failing at signature time.
 *
 * Erasable syntax and `.ts`-free imports only: nothing here needs Nest.
 */
import type { KuruBuilderSettings } from '@sente/venues/kuru';
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem';

/**
 * DI token: the builder AGENTS' policies are compiled with and their orders
 * pay — {@link loadAgentKuruBuilder}, `null` when off.
 */
export const AGENT_KURU_BUILDER = Symbol('AGENT_KURU_BUILDER');

/** 10 bps: `feePps / 10_000_000`. */
export const DEFAULT_KURU_BUILDER_FEE_PPS = 10_000;
/** The most Sente will ever charge, whatever the env says. */
export const MAX_KURU_BUILDER_FEE_PPS = 10_000;

/**
 * How long a user's `approveBuilder` lasts: one year. The planner re-approves
 * once less than a day is left, so a user signs the approval about once a
 * year, and the phone accepts no expiry further out than
 * {@link KURU_BUILDER_APPROVAL_MAX_SECONDS}.
 */
export const KURU_BUILDER_APPROVAL_SECONDS = 365 * 86_400;
/** The phone's ceiling: a year plus a day for clock skew. */
export const KURU_BUILDER_APPROVAL_MAX_SECONDS = 366 * 86_400;

export interface KuruBuilderConfig {
  readonly address: Address;
  readonly feePps: number;
}

type Env = Record<string, string | undefined>;

/** `null` when `KURU_BUILDER_ADDRESS` is unset: no Sente fee anywhere. Throws on a bad value. */
export function loadKuruBuilderConfig(env: Env = process.env): KuruBuilderConfig | null {
  const rawAddress = env['KURU_BUILDER_ADDRESS']?.trim();
  const rawPps = env['KURU_BUILDER_FEE_PPS']?.trim();
  if (!rawAddress) return null;
  if (!isAddress(rawAddress, { strict: false }) || rawAddress.toLowerCase() === zeroAddress) {
    throw new Error(`KURU_BUILDER_ADDRESS "${rawAddress}" is not an address`);
  }
  const text = rawPps || String(DEFAULT_KURU_BUILDER_FEE_PPS);
  if (!/^\d{1,9}$/.test(text)) {
    throw new Error(`KURU_BUILDER_FEE_PPS "${text}" is not a whole number of pps`);
  }
  const feePps = Number(text);
  if (feePps <= 0 || feePps > MAX_KURU_BUILDER_FEE_PPS) {
    throw new Error(
      `KURU_BUILDER_FEE_PPS ${feePps} is outside 1..${MAX_KURU_BUILDER_FEE_PPS} ` +
        '(10000 pps = 10 bps, the most Sente charges)',
    );
  }
  return { address: getAddress(rawAddress), feePps };
}

/** For the boot log. */
export function describeKuruBuilder(config: KuruBuilderConfig | null): string {
  return config
    ? `Sente fee on Kuru: ${feePpsToBps(config.feePps)} bps to ${config.address}`
    : 'Sente fee on Kuru: off (KURU_BUILDER_ADDRESS unset)';
}

/** 10000 pps -> "10". Basis points are 1000 pps each. */
export function feePpsToBps(feePps: number): string {
  const whole = Math.trunc(feePps / 1000);
  const rest = feePps % 1000;
  return rest === 0
    ? String(whole)
    : `${whole}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * The builder agents' policies are compiled with: {@link loadKuruBuilderConfig},
 * unless `KURU_BUILDER_AGENTS` is `0` or `false`.
 */
export function loadAgentKuruBuilder(env: Env = process.env): KuruBuilderConfig | null {
  const config = loadKuruBuilderConfig(env);
  const agents = env['KURU_BUILDER_AGENTS']?.trim();
  return agents === '0' || agents === 'false' ? null : config;
}

/** What a policy was compiled to allow (`@sente/mandate`'s `KuruBuilderGrant`). */
export interface AgentBuilderGrant {
  readonly address: Address;
  readonly maxFeePps: number;
}

/**
 * Agents re-approve only when the approval is about to lapse: it can never
 * outlive the mandate, so "a day early" would mean every order in a mandate's
 * last day paid for a fresh approval.
 */
export const AGENT_BUILDER_RENEW_WITHIN_SECONDS = 60;

/**
 * The builder fee one agent's Kuru orders pay right now, or `undefined` for
 * the plain overloads (gotcha 13): only when the agent's LIVE policy carries
 * the fee rules (`grant`, recorded when it was last compiled) for this same
 * builder at no less than the current rate. An agent hired before SEN-184, or
 * while the fee was off, has no grant and keeps trading without a fee until
 * its mandate is amended.
 */
export function agentKuruBuilder(
  agent: {
    readonly kuruBuilder?: AgentBuilderGrant;
    readonly mandate: { readonly expiresAt: number };
  },
  config: KuruBuilderConfig | null,
): KuruBuilderSettings | undefined {
  const grant = agent.kuruBuilder;
  if (!config || !grant) return undefined;
  if (!isAddressEqual(grant.address, config.address) || config.feePps > grant.maxFeePps) {
    return undefined;
  }
  const expiresAt = BigInt(agent.mandate.expiresAt);
  return {
    address: config.address,
    feePps: config.feePps,
    // The policy caps `expiry` at the mandate's own expiry.
    approvalExpiry: () => expiresAt,
    renewWithinSeconds: AGENT_BUILDER_RENEW_WITHIN_SECONDS,
  };
}
