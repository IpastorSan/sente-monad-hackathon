// The pure half of `live-flows.ts`: what the secrets file must hold, what a
// bootstrap still has to do, which host a run may touch, the run's ids, the
// budget arithmetic and how an agent run is judged. No network, no clock, no
// file system, so `plan.test.ts` runs it with plain values.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';

import type { MandateForm } from '../../src/agents/mandate.ts';

export const PRODUCTION_API = 'https://api.sente.lol';
export const SECRETS_FILE_NAME = 'sente-live-check-user.json';
export const AGENT_NAME = 'live-check-agent';
export const AGENT_MODEL = 'moonshotai/kimi-k2.6';
export const PERPL_SYMBOL = 'BTC-PERP';
export const AGENT_INSTRUCTION =
  'Place one post-only bid on BTC-PERP at half the mark price for the minimum size, then ' +
  'cancel it. Do nothing else.';
/** The user's own Perpl trade-key label, so Perpl's key list says what enrolled it. */
export const PERPL_KEY_LABEL = 'sente-live-check';

const DAY_SECONDS = 86_400;
/** The longest expiry the app offers (`EXPIRY_PRESETS_DAYS`). */
export const AGENT_EXPIRY_DAYS = 90;

/** Every amount here is in token atoms; USDC and AUSD both have 6 decimals. */
export const DECIMALS = 6;
const usd = (text: string): bigint => parseUnits(text, DECIMALS);

export const BOOTSTRAP = {
  /** Perpl's opening minimum, for the user's account and the agent's. */
  perplOpenAtoms: usd('100'),
  /** The agent's USDC: its Kuru deposit cap, and what it is funded with. */
  agentUsdcAtoms: usd('15'),
  /** The agent's AUSD: exactly its Perpl opening deposit. */
  agentAusdAtoms: usd('100'),
} as const;

export const BUDGET = {
  /** Wallet + Kuru USDC a run needs: a 10 USDC minimum-notional bid and room for the fee. */
  minUsdcAtoms: usd('12'),
  /**
   * Wallet AUSD a run needs. Nothing in a run spends wallet AUSD; this only
   * notices the account being drained. The starter kit's 250 less the user's
   * and the agent's Perpl openings leaves 50.
   */
  minAusdAtoms: usd('50'),
  /** One agent run may cost at most this much of the user's model credits. */
  maxRunCreditsUsd: 0.3,
  /** And must leave at least this much behind. */
  minCreditsLeftUsd: 1,
  /** How much USDC a run may lose (wallet + Kuru), e.g. to a builder fee. */
  maxUsdcLossAtoms: usd('0.10'),
} as const;

// ---------------------------------------------------------------------------
// The secrets file

export type LiveSecrets = {
  version: 1;
  /** The API origin the identity was bootstrapped against. Runs refuse any other. */
  api: string;
  createdAt: string;
  /** secp256k1, signs in. Never printed. */
  authKey: `0x${string}`;
  /** P-256, owns the user's Privy wallet. Never printed. */
  deviceKey: string;
  user?: { address: Address; walletId: string; walletAddress: Address };
  perpl?: { accountId: string; apiKey?: string };
  agent?: { id: string; walletId: string; address: Address; policyId: string; ownerKind: string };
  agentFunding?: { usdc?: string; ausd?: string };
  agentPerpl?: { accountId: string; transactions: string[] };
};

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

const HEX32 = /^(0x)?[0-9a-f]{64}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '')
    throw new SecretsError(`${where}.${key} is missing`);
  return value;
}

function address(record: Record<string, unknown>, key: string, where: string): Address {
  const value = text(record, key, where);
  if (!isAddress(value, { strict: false })) {
    throw new SecretsError(`${where}.${key} is not an address`);
  }
  return getAddress(value);
}

function section<T>(
  root: Record<string, unknown>,
  key: string,
  read: (record: Record<string, unknown>, where: string) => T,
): T | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new SecretsError(`${key} is not an object`);
  return read(value, key);
}

/**
 * The file's contents, checked field by field. Throws {@link SecretsError}
 * naming the field, never quoting a value: two of them are private keys.
 */
export function parseSecrets(raw: string): LiveSecrets {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    throw new SecretsError('the secrets file is not JSON');
  }
  if (!isObject(root)) throw new SecretsError('the secrets file is not an object');
  if (root['version'] !== 1) throw new SecretsError('version must be 1');
  const authKey = text(root, 'authKey', 'file');
  if (!HEX32.test(authKey) || !authKey.startsWith('0x')) {
    throw new SecretsError('authKey is not a 0x-prefixed 32-byte key');
  }
  const deviceKey = text(root, 'deviceKey', 'file');
  if (!HEX32.test(deviceKey) || deviceKey.startsWith('0x')) {
    throw new SecretsError('deviceKey is not a bare hex 32-byte key');
  }
  const secrets: LiveSecrets = {
    version: 1,
    api: normalizeApi(text(root, 'api', 'file')),
    createdAt: text(root, 'createdAt', 'file'),
    authKey: authKey as `0x${string}`,
    deviceKey,
  };
  const user = section(root, 'user', (r, w) => ({
    address: address(r, 'address', w),
    walletId: text(r, 'walletId', w),
    walletAddress: address(r, 'walletAddress', w),
  }));
  const perpl = section(root, 'perpl', (r, w) => {
    const apiKey = r['apiKey'];
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey === '')) {
      throw new SecretsError(`${w}.apiKey is not a string`);
    }
    return { accountId: text(r, 'accountId', w), ...(apiKey ? { apiKey } : {}) };
  });
  const agent = section(root, 'agent', (r, w) => ({
    id: text(r, 'id', w),
    walletId: text(r, 'walletId', w),
    address: address(r, 'address', w),
    policyId: text(r, 'policyId', w),
    ownerKind: text(r, 'ownerKind', w),
  }));
  const agentFunding = section(root, 'agentFunding', (r, w) => {
    const out: { usdc?: string; ausd?: string } = {};
    for (const key of ['usdc', 'ausd'] as const) {
      const value = r[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new SecretsError(`${w}.${key} is not a string`);
      out[key] = value;
    }
    return out;
  });
  const agentPerpl = section(root, 'agentPerpl', (r, w) => {
    const transactions = r['transactions'];
    if (!Array.isArray(transactions) || transactions.some((t) => typeof t !== 'string')) {
      throw new SecretsError(`${w}.transactions is not a list of hashes`);
    }
    return { accountId: text(r, 'accountId', w), transactions: transactions as string[] };
  });
  return {
    ...secrets,
    ...(user ? { user } : {}),
    ...(perpl ? { perpl } : {}),
    ...(agent ? { agent } : {}),
    ...(agentFunding ? { agentFunding } : {}),
    ...(agentPerpl ? { agentPerpl } : {}),
  };
}

/** Ids of things that exist on the server because of this file. */
export function recordedIds(secrets: LiveSecrets | null): string[] {
  if (!secrets) return [];
  return [
    ...(secrets.user ? [`user wallet ${secrets.user.walletId}`] : []),
    ...(secrets.perpl ? [`Perpl account ${secrets.perpl.accountId}`] : []),
    ...(secrets.agent ? [`agent ${secrets.agent.id}`] : []),
  ];
}

// ---------------------------------------------------------------------------
// Bootstrap

export const BOOTSTRAP_PHASES = [
  'identity',
  'register',
  'perpl-onboard',
  'perpl-enroll',
  'hire',
  'fund-agent',
  'agent-perpl',
] as const;
export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number];

function phaseDone(phase: BootstrapPhase, s: LiveSecrets | null): boolean {
  switch (phase) {
    case 'identity':
      return s !== null;
    case 'register':
      return s?.user !== undefined;
    case 'perpl-onboard':
      return s?.perpl !== undefined;
    case 'perpl-enroll':
      return s?.perpl?.apiKey !== undefined;
    case 'hire':
      return s?.agent !== undefined;
    case 'fund-agent':
      return s?.agentFunding?.usdc !== undefined && s.agentFunding.ausd !== undefined;
    case 'agent-perpl':
      return s?.agentPerpl !== undefined;
  }
}

/** What a bootstrap still has to do, in order. */
export function remainingPhases(secrets: LiveSecrets | null): BootstrapPhase[] {
  return BOOTSTRAP_PHASES.filter((phase) => !phaseDone(phase, secrets));
}

export function isBootstrapped(secrets: LiveSecrets | null): secrets is LiveSecrets {
  return secrets !== null && remainingPhases(secrets).length === 0;
}

/**
 * `--bootstrap` creates things on the server once. A file that already names
 * any of them is refused, so a second bootstrap cannot mint a second user or a
 * second agent; `--resume` finishes one that stopped part-way.
 */
export function bootstrapRefusal(secrets: LiveSecrets | null, resume: boolean): string | null {
  const ids = recordedIds(secrets);
  if (isBootstrapped(secrets)) {
    return `already bootstrapped (${ids.join(', ')}); nothing to do`;
  }
  if (ids.length > 0 && !resume) {
    return (
      `the secrets file already has ${ids.join(', ')}; refusing to bootstrap again. ` +
      'Pass --resume to finish the remaining steps.'
    );
  }
  if (secrets !== null && ids.length === 0 && !resume) {
    return 'the secrets file exists but names nothing yet; pass --resume to continue with its keys';
  }
  return null;
}

/** A run needs every phase done. */
export function runRefusal(secrets: LiveSecrets | null): string | null {
  if (!secrets) return 'no secrets file: run --bootstrap first';
  const left = remainingPhases(secrets);
  return left.length === 0
    ? null
    : `bootstrap is unfinished (${left.join(', ')}): --bootstrap --resume`;
}

// ---------------------------------------------------------------------------
// The target host

/** The API URL as an origin, e.g. `https://api.sente.lol`. */
export function normalizeApi(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecretsError(`not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecretsError(`the API must be http(s): ${url}`);
  }
  if (parsed.pathname.replace(/\/+$/, '') !== '' || parsed.search || parsed.hash) {
    throw new SecretsError(`the API must be a bare origin: ${url}`);
  }
  return parsed.origin;
}

export function isProduction(api: string): boolean {
  return new URL(api).hostname === new URL(PRODUCTION_API).hostname;
}

/**
 * Whether this invocation may touch `api`: only the host the identity was
 * bootstrapped on, and production only with `--yes`. `null` means go.
 */
export function targetRefusal(input: {
  api: string;
  recorded: string | null;
  yes: boolean;
}): string | null {
  if (input.recorded !== null && input.recorded !== input.api) {
    return `this identity was bootstrapped on ${input.recorded}, not ${input.api}`;
  }
  if (isProduction(input.api) && !input.yes) {
    return `${input.api} is PRODUCTION: real funds move. Re-run with --yes to go ahead.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run ids

export const RUN_STEPS = [
  'session',
  'pre-cleanup',
  'kuru',
  'perpl',
  'agent-run',
  'enclave-refusal',
  'post-cleanup',
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** `20261009-1a2b3c4d`: the day and the commit. */
export function runIdOf(date: Date, gitSha: string): string {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const sha = gitSha.trim().slice(0, 8);
  if (!/^[0-9a-f]{7,8}$/.test(sha)) throw new Error(`not a git sha: ${gitSha}`);
  return `${day}-${sha}`;
}

/**
 * A stable UUID v4 for one step of one run: the `/trade` idempotency key. A
 * step retried inside the same run (or the same day on the same commit)
 * reuses its trade instead of placing a second one.
 */
export function clientTradeIdFor(runId: string, step: string): string {
  const bytes = sha256(utf8ToBytes(`sente.live-flows:${runId}:${step}`)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Prices and sizes

/** Half of `reference`, floored onto `tick` (book units). Never zero. */
export function halfOnTick(reference: bigint, tick: bigint): bigint {
  if (reference <= 0n || tick <= 0n) throw new Error('reference and tick must be positive');
  const half = reference / 2n;
  const floored = half - (half % tick);
  return floored > 0n ? floored : tick;
}

const decimalsOf = (value: string): number => (value.split('.')[1] ?? '').length;

/** `halfOnTick` for decimal strings, e.g. Perpl's mark and tick. */
export function decimalHalfOnTick(mark: string, tick: string): string {
  const places = Math.max(decimalsOf(mark), decimalsOf(tick));
  const units = halfOnTick(parseUnits(mark, places), parseUnits(tick, places));
  return trimDecimal(formatUnits(units, places));
}

function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/**
 * The agent's `maxOrderNotional`: a full-mark minimum-size BTC order, so a
 * half-mark bid fits even after the price doubles, and never under the 11
 * a Kuru minimum-notional order needs. Whole quote units.
 */
export function agentMaxOrderNotional(mark: string, minSize: string): string {
  const places = decimalsOf(mark) + decimalsOf(minSize);
  const product = parseUnits(mark, decimalsOf(mark)) * parseUnits(minSize, decimalsOf(minSize));
  const scale = 10n ** BigInt(places);
  const whole = (product + scale - 1n) / scale;
  return (whole > 11n ? whole : 11n).toString();
}

/** The agent's mandate, as the hire screen's form would hold it. */
export function agentMandateForm(input: {
  kuruMarket: Address;
  maxOrderNotional: string;
  nowSeconds: number;
  returnTo: Address;
}): MandateForm {
  return {
    kuru: true,
    perpl: true,
    kuruMarkets: [input.kuruMarket],
    depositCaps: { USDC: formatUnits(BOOTSTRAP.agentUsdcAtoms, DECIMALS) },
    perplCollateral: formatUnits(BOOTSTRAP.perplOpenAtoms, DECIMALS),
    perplMarkets: PERPL_SYMBOL,
    maxLeverage: '2',
    maxOrderNotional: input.maxOrderNotional,
    expiresAt: input.nowSeconds + AGENT_EXPIRY_DAYS * DAY_SECONDS,
    returnTo: input.returnTo,
  };
}

// ---------------------------------------------------------------------------
// Budget

export type Holdings = {
  /** Wallet USDC plus the Kuru account's USDC (free and locked). */
  usdcAtoms: bigint;
  /** Wallet AUSD. */
  ausdAtoms: bigint;
};

export type CreditsReading = { usedUsd: number; remainingUsd: number | null };

/** Why a run may not start on these holdings; empty means it may. */
export function startBudgetProblems(input: {
  starterKit: string | undefined;
  holdings: Holdings;
}): string[] {
  const problems: string[] = [];
  if (input.starterKit !== 'sent') {
    problems.push(`starter kit is ${input.starterKit ?? 'unknown'}, not sent`);
  }
  if (input.holdings.usdcAtoms < BUDGET.minUsdcAtoms) {
    problems.push(
      `USDC ${formatUnits(input.holdings.usdcAtoms, DECIMALS)} < ${formatUnits(BUDGET.minUsdcAtoms, DECIMALS)}`,
    );
  }
  if (input.holdings.ausdAtoms < BUDGET.minAusdAtoms) {
    problems.push(
      `AUSD ${formatUnits(input.holdings.ausdAtoms, DECIMALS)} < ${formatUnits(BUDGET.minAusdAtoms, DECIMALS)}`,
    );
  }
  return problems;
}

/** What one agent run cost in credits, and whether that is within budget. */
export function creditsProblems(before: CreditsReading, after: CreditsReading): string[] {
  const spent = after.usedUsd - before.usedUsd;
  const problems: string[] = [];
  if (spent >= BUDGET.maxRunCreditsUsd) {
    problems.push(`the run cost $${spent.toFixed(4)} ≥ $${BUDGET.maxRunCreditsUsd}`);
  }
  if (after.remainingUsd === null) {
    problems.push('the credits limit is unknown');
  } else if (after.remainingUsd <= BUDGET.minCreditsLeftUsd) {
    problems.push(`$${after.remainingUsd.toFixed(4)} credits left ≤ $${BUDGET.minCreditsLeftUsd}`);
  }
  return problems;
}

export type Deltas = { usdcAtoms: bigint; ausdAtoms: bigint };

export function deltasOf(before: Holdings, after: Holdings): Deltas {
  return {
    usdcAtoms: after.usdcAtoms - before.usdcAtoms,
    ausdAtoms: after.ausdAtoms - before.ausdAtoms,
  };
}

/** A run places and cancels resting orders: it should cost (almost) nothing. */
export function deltaProblems(deltas: Deltas): string[] {
  const problems: string[] = [];
  if (deltas.usdcAtoms < -BUDGET.maxUsdcLossAtoms) {
    problems.push(
      `USDC moved ${signed(deltas.usdcAtoms)} (allowed −${formatUnits(BUDGET.maxUsdcLossAtoms, DECIMALS)})`,
    );
  }
  if (deltas.ausdAtoms !== 0n) problems.push(`AUSD moved ${signed(deltas.ausdAtoms)} (allowed 0)`);
  return problems;
}

export function signed(atoms: bigint): string {
  return `${atoms < 0n ? '−' : '+'}${formatUnits(atoms < 0n ? -atoms : atoms, DECIMALS)}`;
}

// ---------------------------------------------------------------------------
// Judging the agent run

/** An event of the run, as `RunResult.events` / `GET /agents/:id/events` carry it. */
export type RunEvent = {
  kind: string;
  tool?: string;
  layer?: string;
  detail?: Record<string, unknown>;
};

export type RunVerdict = { ok: true } | { ok: false; problem: string };

/**
 * The agent did what it was told: one order placed and cancelled, both
 * reported ok, and nothing refused by either layer.
 */
export function judgeAgentRun(input: {
  stopReason: string;
  events: readonly RunEvent[];
}): RunVerdict {
  const refusals = input.events.filter((e) => e.kind === 'refusal');
  if (refusals.length > 0) {
    const first = refusals[0]!;
    return {
      ok: false,
      problem: `refused by ${first.layer ?? '?'} on ${first.tool ?? '?'}: ${String(first.detail?.['code'] ?? '')}`,
    };
  }
  const ok = (tool: string) =>
    input.events.some(
      (e) => e.kind === 'order' && e.tool === tool && e.detail?.['status'] === 'ok',
    );
  if (!ok('place_limit'))
    return { ok: false, problem: 'no place_limit order event that went through' };
  if (!ok('cancel_order')) return { ok: false, problem: 'no cancel_order event that went through' };
  if (input.events.some((e) => e.kind === 'fill')) {
    return { ok: false, problem: 'a post-only bid at half the mark filled' };
  }
  if (input.stopReason !== 'end_turn' && input.stopReason !== 'stop_sequence') {
    return { ok: false, problem: `the run stopped on ${input.stopReason}` };
  }
  return { ok: true };
}
