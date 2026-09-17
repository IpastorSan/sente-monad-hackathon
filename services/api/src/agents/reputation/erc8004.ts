/**
 * ERC-8004 (Trustless Agents) on Monad testnet — SEN-27.
 *
 * Two registries, the same per-chain singletons the protocol deploys
 * everywhere:
 *
 * - **Identity Registry** (ERC-721 with URI storage). A hired agent is minted
 *   an `agentId` whose `agentURI` resolves to its registration file — name,
 *   model, the mandate that bounds it, its wallet, and a link to its Ledger.
 * - **Reputation Registry**. Every settled thesis (SEN-22) is written as one
 *   feedback entry: its realised PnL in **basis points of the thesis's own cost
 *   basis**, which is the one number that is comparable across venues
 *   (`pnlAsset` differs: USDC on Kuru, AUSD on Perpl).
 *
 * WHAT SIGNS. Both writes come from Sente service EOAs, never from the agent's
 * Privy wallet: routing them through the agent would need a policy rule
 * (`compileMandate`), and the mandate is the user's contract with the agent, not
 * a place to grant it the right to mint NFTs.
 *
 * WHY THERE ARE TWO KEYS. The registry enforces the spec's rule that *"the
 * feedback submitter MUST NOT be the agent owner or an approved operator for
 * agentId"* — measured on the live testnet deployment on 2026-09-17, a
 * `giveFeedback` simulated from the owner of `agentId 0` reverted with
 * `Self-feedback not allowed.`, while the same call from another address
 * succeeded. Since `ERC8004_REGISTRAR_KEY` signs `register` and therefore OWNS
 * the agent, it cannot also be the reviewer. A separate
 * `ERC8004_REVIEWER_KEY` writes the feedback, which is also the honest framing:
 * the reviewer is the client that ran the agent and saw the fills, and it is
 * not the party being reviewed. With no reviewer key configured, feedback is
 * REFUSED rather than attempted — a self-feedback transaction reverts and Monad
 * still charges its gas limit (CLAUDE.md gotcha 4).
 *
 * GAS. Never estimated at runtime: Monad charges `gas * gasPrice` on the
 * LIMIT, not on gas used (gotcha 4), so both limits are measured constants with
 * an env override. Measured 2026-09-17 with `eth_estimateGas` against the live
 * testnet registries, from a funded address, with the exact calldata this module
 * builds:
 *
 * | call | measured | limit here |
 * | --- | --- | --- |
 * | `register(string)`, typical 833-char URI | 685,052 | 950,000 |
 * | `register(string)`, largest this module builds (1,125-char URI) | 849,887 | 950,000 |
 * | `giveFeedback(...)`, across agent ids and clients | 278,412 – 295,694 | 350,000 |
 *
 * Almost all of that is calldata: Monad prices it high, and the registration
 * file is a base64 data URI. The description and the name are therefore capped
 * (`MAX_DESCRIPTION_CHARS`, `MAX_NAME_CHARS`), which is what makes a fixed limit
 * a bound rather than a hope — `erc8004.spec.ts` pins the largest URI the
 * builder can produce against the length the limit was measured at.
 * `scripts/erc8004-live.ts` re-measures both limits against the calldata it is
 * about to send.
 *
 * RESERVE. Both keys are EOAs whose transactions are contract calls, not MON
 * transfers, so Monad's 10 MON reserve (gotcha 12) does not stop a lone send —
 * but a reverted one is still charged the full limit, and a second send from an
 * under-reserve key inside the window is exactly what the reserve rule bites.
 * Each key is therefore serialised (one transaction in flight), never retried on
 * another key, and never re-sent for the same call: a half-applied registration
 * is worse than a missing one.
 *
 * Erasable syntax, no local runtime imports and nothing from `@nestjs/*`, on
 * purpose: `scripts/erc8004-live.ts` loads this file under node's type stripping
 * (CLAUDE.md gotcha 10), so no decorators and no parameter properties either.
 */
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import type { AgentEvent, AgentEventLog } from '../events/agent-event-log.ts';
import type { Verdict, VerdictVenue } from '../events/verdict.ts';
import type { AgentRecord } from '../store/agent-store.ts';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Monad testnet. Both registry pairs are per-chain singletons. */
export const ERC8004_CHAIN_ID = 10143;

/**
 * The testnet pair, verified on 2026-09-17 with `eth_getCode` (both have code)
 * and by reading `getIdentityRegistry()` off the Reputation Registry, which
 * returns exactly `ERC8004_IDENTITY_REGISTRY`. The mainnet-shaped addresses in
 * the SEN-27 plan (`0x8004A169…` / `0x8004BAa1…`) have NO code on testnet — do
 * not use them here.
 */
export const ERC8004_IDENTITY_REGISTRY: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const ERC8004_REPUTATION_REGISTRY: Address = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/**
 * Mainnet, constants only. Nothing in this API talks to mainnet: no mainnet
 * RPC, no mainnet registrar key, no mainnet treasury — so these are documented
 * for the day that changes and referenced nowhere at runtime.
 */
export const ERC8004_MAINNET_IDENTITY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const ERC8004_MAINNET_REPUTATION: Address = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

/** The spec's globally unique handle for one agent: `{namespace}:{chainId}:{registry}`. */
export function agentRegistryId(
  chainId: number = ERC8004_CHAIN_ID,
  identity: Address = ERC8004_IDENTITY_REGISTRY,
): string {
  return `eip155:${chainId}:${identity}`;
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

/** `parseAbi` at module load, so a typo in a signature fails loudly, not silently. */
export const ERC8004_IDENTITY_ABI = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)',
  'function register() returns (uint256 agentId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

export const ERC8004_REPUTATION_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'function getIdentityRegistry() view returns (address)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

// ---------------------------------------------------------------------------
// Gas and value constants
// ---------------------------------------------------------------------------

/**
 * Fixed gas limits (see the module comment for how they were measured, and why
 * they are limits rather than estimates). Overridable per deployment with
 * `ERC8004_REGISTER_GAS` / `ERC8004_FEEDBACK_GAS`.
 *
 * `register` is sized for the LARGEST registration file this module can build
 * ({@link ERC8004_MAX_AGENT_URI_CHARS}), not for the typical one: the limit is
 * what Monad charges, so sizing it for the average would revert on a long
 * strategy text, and sizing it per call would need an RPC round trip before
 * every write.
 */
export const ERC8004_GAS = {
  register: 950_000n,
  feedback: 350_000n,
} as const;

/**
 * `valueDecimals` for a PnL feedback: 2, so the on-chain `value` reads as basis
 * points with two decimals (`25000` = 250.00 bps = 2.50%). int128 and signed,
 * so a losing thesis is negative — the spec's own `tradingYield` example row
 * does the same.
 */
export const ERC8004_VALUE_DECIMALS = 2;

/** `tag1` on every feedback this service writes; `tag2` is the venue. */
export const ERC8004_PNL_TAG = 'pnl';

/** The `bytes32(0)` the spec allows where a feedback carries no off-chain file. */
export const ZERO_FEEDBACK_HASH: Hex = `0x${'00'.repeat(32)}`;

const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

/** `data:application/json;base64,…` puts the whole file in calldata; keep it small. */
export const MAX_DESCRIPTION_CHARS = 320;

/**
 * Also a gas bound, not just tidiness: the registration file is calldata on
 * Monad, and `ERC8004_GAS.register` was measured against the URI this module can
 * produce for a name at this length and a description at its cap. Matches
 * `AGENT_NAME_MAX_LENGTH` in `dto/agent.dto.ts`.
 */
export const MAX_NAME_CHARS = 64;

/**
 * The longest `agentURI` this module can build, measured 2026-09-17: a name at
 * the cap, a description at the cap, an MCP service and an image (1,125 chars,
 * 849,887 gas). `ERC8004_GAS.register` is sized for it, and `erc8004.spec.ts`
 * fails if the builder can ever exceed it.
 */
export const ERC8004_MAX_AGENT_URI_CHARS = 1_125;

/** MCP revision advertised in the registration file's `services` entry. */
export const ERC8004_MCP_VERSION = '2025-06-18';

/** The registration file's `type`, verbatim from the spec. */
export const ERC8004_REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const ERC8004_DEFAULTS = {
  agentBaseUrl: 'https://sente.lol',
} as const;

export interface Erc8004Config {
  /**
   * The key that signs `register` and therefore owns every agent NFT Sente
   * mints. Absent: registration is skipped and agents are hired without an
   * ERC-8004 identity (the API still boots, like an unconfigured gas drip).
   */
  readonly registrarKey?: Hex;
  /**
   * The key that signs `giveFeedback`. It must NOT be the registrar — see the
   * module comment — so a deployment holding only the registrar gets agents with
   * no reputation writes, and says so at boot.
   */
  readonly reviewerKey?: Hex;
  /** Optional RPC override; falls back to viem's Monad testnet endpoint. */
  readonly rpcUrl?: string;
  /** Where an agent's Ledger page lives: `{agentBaseUrl}/agents/{id}`. */
  readonly agentBaseUrl: string;
  /** The shared MCP endpoint advertised in the registration file's `services`. */
  readonly mcpEndpoint?: string;
  /** A hosted image for the registration file; the key is omitted when unset. */
  readonly imageUrl?: string;
  readonly registerGas: bigint;
  readonly feedbackGas: bigint;
}

export interface Erc8004Logger {
  log?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Pure env -> config, so a bad deployment fails at boot rather than on the first
 * hire. A malformed key throws, and the message never echoes the value.
 */
export function loadErc8004Config(env: NodeJS.ProcessEnv = process.env): Erc8004Config {
  return {
    registrarKey: optionalKey(env['ERC8004_REGISTRAR_KEY'], 'ERC8004_REGISTRAR_KEY'),
    reviewerKey: optionalKey(env['ERC8004_REVIEWER_KEY'], 'ERC8004_REVIEWER_KEY'),
    rpcUrl: env['MONAD_TESTNET_RPC_URL']?.trim() || undefined,
    agentBaseUrl: trimSlash(env['ERC8004_AGENT_BASE_URL']) ?? ERC8004_DEFAULTS.agentBaseUrl,
    mcpEndpoint: env['ERC8004_MCP_ENDPOINT']?.trim() || undefined,
    imageUrl: env['ERC8004_IMAGE_URL']?.trim() || undefined,
    registerGas: positiveBigInt(
      env['ERC8004_REGISTER_GAS'],
      ERC8004_GAS.register,
      'ERC8004_REGISTER_GAS',
    ),
    feedbackGas: positiveBigInt(
      env['ERC8004_FEEDBACK_GAS'],
      ERC8004_GAS.feedback,
      'ERC8004_FEEDBACK_GAS',
    ),
  };
}

/** Boot-time summary. Names variables and derived addresses, never key material. */
export function describeErc8004Config(config: Erc8004Config, logger: Erc8004Logger): void {
  const registrar = addressOf(config.registrarKey);
  const reviewer = addressOf(config.reviewerKey);
  if (!registrar) {
    logger.warn(
      'ERC-8004 disabled: ERC8004_REGISTRAR_KEY is unset, so hired agents get no on-chain ' +
        'identity and no reputation. Set it (a funded EOA) to enable SEN-27.',
    );
    return;
  }
  logger.log?.(
    `ERC-8004 enabled: registrar ${registrar} owns each agent NFT; reviewer ` +
      `${reviewer ?? 'unset'}; identity ${ERC8004_IDENTITY_REGISTRY} ` +
      `reputation ${ERC8004_REPUTATION_REGISTRY} ` +
      `gas register=${config.registerGas} feedback=${config.feedbackGas}`,
  );
  if (!reviewer) {
    logger.warn(
      'ERC-8004 feedback disabled: ERC8004_REVIEWER_KEY is unset. The registrar owns every agent ' +
        'it registers and the registry refuses self-feedback, so reputation needs a second ' +
        'funded EOA.',
    );
    return;
  }
  if (isAddressEqual(registrar, reviewer)) {
    logger.warn(
      `ERC-8004 feedback disabled: ERC8004_REVIEWER_KEY is the registrar (${reviewer}); the ` +
        'registry reverts self-feedback and Monad charges the gas limit anyway.',
    );
  }
}

/** True when the reviewer key is the registrar: feedback would revert on chain. */
export function isSelfFeedback(config: Erc8004Config): boolean {
  const registrar = addressOf(config.registrarKey);
  const reviewer = addressOf(config.reviewerKey);
  return registrar !== undefined && reviewer !== undefined && isAddressEqual(registrar, reviewer);
}

function optionalKey(raw: string | undefined, name: string): Hex | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const key = value.startsWith('0x') ? value : `0x${value}`;
  if (!PRIVATE_KEY.test(key)) {
    throw new Error(`${name} is not a 0x-prefixed 32-byte hex private key`);
  }
  return key as Hex;
}

function positiveBigInt(raw: string | undefined, fallback: bigint, name: string): bigint {
  if (!raw?.trim()) return fallback;
  let value: bigint;
  try {
    value = BigInt(raw.trim());
  } catch {
    throw new Error(`${name} must be an integer number of gas, got ${JSON.stringify(raw.trim())}`);
  }
  if (value <= 0n) throw new Error(`${name} must be greater than zero`);
  return value;
}

function trimSlash(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

/** The address behind a key, for logging and for `from`-only simulations. Never the key. */
export function addressOf(key: Hex | undefined): Address | undefined {
  return key ? privateKeyToAccount(key).address : undefined;
}

// ---------------------------------------------------------------------------
// The registration file (agentURI)
// ---------------------------------------------------------------------------

/** The mandate fields the registration file summarises. Public by construction. */
export interface RegistrationMandate {
  readonly venues: readonly string[];
  readonly kuru: { readonly markets: readonly string[] };
  readonly perpl: { readonly markets: readonly string[]; readonly maxLeverage: number };
  readonly maxOrderNotional: string;
  readonly expiresAt: number;
}

export interface AgentRegistrationInput {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly strategy: string;
  readonly address: Address;
  readonly mandate: RegistrationMandate;
  readonly agentBaseUrl: string;
  readonly mcpEndpoint?: string;
  readonly imageUrl?: string;
}

/** The agent's Ledger page: where a reader finds the fills behind any feedback. */
export function agentLedgerUrl(agentBaseUrl: string, agentId: string): string {
  return `${trimSlash(agentBaseUrl) ?? ERC8004_DEFAULTS.agentBaseUrl}/agents/${agentId}`;
}

/**
 * The registration file the spec defines, as JSON. `registrations` is empty on
 * purpose: the `agentId` is assigned BY the registration transaction, so it
 * cannot appear in the URI that same transaction carries. Filling it in needs a
 * second `setAgentURI` transaction — deliberately not spent; see
 * `docs/erc8004.md`.
 */
export function agentRegistrationFile(input: AgentRegistrationInput): Record<string, unknown> {
  const services: Record<string, unknown>[] = [
    { name: 'web', endpoint: agentLedgerUrl(input.agentBaseUrl, input.id) },
  ];
  if (input.mcpEndpoint) {
    services.push({ name: 'MCP', endpoint: input.mcpEndpoint, version: ERC8004_MCP_VERSION });
  }
  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: truncate(input.name, MAX_NAME_CHARS),
    description: describeAgent(input),
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    services,
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  };
}

/** `data:application/json;base64,…` — the spec's fully on-chain form, no hosting needed. */
export function dataUri(json: Record<string, unknown>): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`;
}

/** The `agentURI` for one agent: the registration file, as a data URI. */
export function agentUriFor(input: AgentRegistrationInput): string {
  return dataUri(agentRegistrationFile(input));
}

/**
 * One paragraph a stranger can read: what the agent is, what it may do, what
 * bounds it, and where to watch it. Truncated, because every character is
 * calldata on Monad.
 */
function describeAgent(input: AgentRegistrationInput): string {
  const text =
    `${input.model} trading agent on Monad, run by Sente. Strategy: ${input.strategy} ` +
    `Mandate: ${mandateSummary(input.mandate)} ` +
    `Wallet: ${input.address}. Ledger: ${agentLedgerUrl(input.agentBaseUrl, input.id)}`;
  return truncate(text, MAX_DESCRIPTION_CHARS);
}

/** Cut to `max` characters, with an ellipsis when anything was dropped. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The mandate's bounds in words. Caps stay as the decimals the user wrote —
 * `maxDepositAtoms` and `maxCollateralAtoms` are raw atoms, and printing those
 * without their token's decimals would be a false statement about the size.
 */
export function mandateSummary(mandate: RegistrationMandate): string {
  const venues = mandate.venues.length > 0 ? mandate.venues.join('+') : 'none';
  const kuru = mandate.kuru.markets.length;
  const perpl =
    mandate.perpl.markets.length > 0
      ? `${mandate.perpl.markets.join('/')} at up to ${mandate.perpl.maxLeverage}x`
      : 'no perps';
  const expiry = new Date(mandate.expiresAt * 1000).toISOString().slice(0, 10);
  return (
    `venues ${venues}; kuru ${kuru} market${kuru === 1 ? '' : 's'}; perpl ${perpl}; ` +
    `max order ${mandate.maxOrderNotional}; expires ${expiry}`
  );
}

// ---------------------------------------------------------------------------
// Realised PnL -> basis points
// ---------------------------------------------------------------------------

/**
 * The verdict's realised PnL as basis points of the thesis's own cost basis,
 * scaled by 100 for `valueDecimals = 2`.
 *
 * `25000n` is 250.00 bps, i.e. +2.5% on the notional the thesis opened. Returns
 * `undefined` when there is no honest number to write: a cost basis that is not
 * a positive decimal — a thesis that closed without opening anything of its own,
 * or a venue-reported PnL with no notional behind it — makes the ratio
 * undefined, and writing 0 would say "flat" about a trade that may have made or
 * lost money.
 *
 * Exact signed decimal arithmetic in BigInt, round-half-away-from-zero: the
 * repo's decimal helpers are exact only for non-negative strings, and both
 * `realisedPnl` and the sign of the ratio matter here.
 */
export function pnlBasisPoints(
  realisedPnl: string,
  costBasis: string,
): { readonly value: bigint; readonly valueDecimals: number } | undefined {
  const realised = parseFixed(realisedPnl);
  const basis = parseFixed(costBasis);
  if (!realised || !basis || basis.units <= 0n) return undefined;

  // value = realised / basis * 1e6: four digits of basis points, plus the two
  // that `valueDecimals` accounts for.
  const shift = 6 + basis.scale - realised.scale;
  let numerator = realised.units;
  let denominator = basis.units;
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const rounded = (absNumerator * 2n + absDenominator) / (absDenominator * 2n);
  const value = negative ? -rounded : rounded;
  if (value < INT128_MIN || value > INT128_MAX) return undefined;
  return { value, valueDecimals: ERC8004_VALUE_DECIMALS };
}

interface Fixed {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function parseFixed(value: string): Fixed | undefined {
  if (!DECIMAL.test(value)) return undefined;
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = magnitude.split('.');
  const units = BigInt(`${whole}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

// ---------------------------------------------------------------------------
// The registry client (the seam specs fake)
// ---------------------------------------------------------------------------

export interface Erc8004AgentRegistration {
  readonly agentId: bigint;
  readonly txHash: Hex;
}

export interface Erc8004FeedbackWrite {
  readonly agentId: bigint;
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly endpoint: string;
  readonly feedbackURI: string;
  readonly feedbackHash: Hex;
}

export interface Erc8004Receipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
}

/**
 * The two registry writes and nothing else, so a spec substitutes a fake of a
 * few lines instead of a chain. Both methods may throw; the callers
 * ({@link Erc8004Reputation}) are the ones that promise never to.
 */
export interface Erc8004Client {
  register(agentUri: string): Promise<Erc8004AgentRegistration>;
  giveFeedback(feedback: Erc8004FeedbackWrite): Promise<Erc8004Receipt>;
}

export interface Erc8004ChainOptions {
  readonly registrarKey?: Hex;
  readonly reviewerKey?: Hex;
  readonly rpcUrl?: string;
  readonly registerGas: bigint;
  readonly feedbackGas: bigint;
  readonly identity?: Address;
  readonly reputation?: Address;
  /** How long a broadcast transaction gets to be mined. Default 30 s. */
  readonly receiptTimeoutMs?: number;
}

/**
 * {@link Erc8004Client} over Monad testnet, one viem wallet client per role.
 *
 * Both roles are serialised: one transaction in flight per key, and an explicit
 * nonce that never goes backwards, because the public RPC is load balanced and a
 * `pending` count read right after a receipt can come from a node that has not
 * seen it yet — the same reason `AgentTransactionSender` keeps a last nonce. The
 * gas limit is always the configured constant: Monad charges the LIMIT, so an
 * `estimateGas` per call would be a per-call price increase, not a saving.
 */
export class Erc8004ChainClient implements Erc8004Client {
  readonly registrar?: Address;
  readonly reviewer?: Address;
  readonly #identity: Address;
  readonly #reputation: Address;
  readonly #registerGas: bigint;
  readonly #feedbackGas: bigint;
  readonly #receiptTimeoutMs: number;
  readonly #chain: PublicClient;
  readonly #registrarSender?: RoleSender;
  readonly #reviewerSender?: RoleSender;

  constructor(options: Erc8004ChainOptions) {
    this.#identity = options.identity ?? ERC8004_IDENTITY_REGISTRY;
    this.#reputation = options.reputation ?? ERC8004_REPUTATION_REGISTRY;
    this.#registerGas = options.registerGas;
    this.#feedbackGas = options.feedbackGas;
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 30_000;
    this.#chain = createPublicClient({
      chain: monadTestnet,
      transport: http(options.rpcUrl),
    }) as PublicClient;
    if (options.registrarKey) {
      this.#registrarSender = roleSender(options.registrarKey);
      this.registrar = this.#registrarSender.address;
    }
    if (options.reviewerKey) {
      this.#reviewerSender = roleSender(options.reviewerKey);
      this.reviewer = this.#reviewerSender.address;
    }
  }

  async register(agentUri: string): Promise<Erc8004AgentRegistration> {
    const sender = this.#registrarSender;
    if (!sender) throw new Error('no ERC8004_REGISTRAR_KEY is configured');
    const data = encodeFunctionData({
      abi: ERC8004_IDENTITY_ABI,
      functionName: 'register',
      args: [agentUri],
    });
    const txHash = await this.#send(sender, this.#identity, data, this.#registerGas);
    const receipt = await this.#receipt(txHash);
    const agentId = agentIdFromLogs(receipt.logs, this.#identity, sender.address);
    if (agentId === undefined) {
      throw new Error(`register ${txHash} carried no readable Registered event`);
    }
    return { agentId, txHash };
  }

  async giveFeedback(feedback: Erc8004FeedbackWrite): Promise<Erc8004Receipt> {
    const sender = this.#reviewerSender;
    if (!sender) throw new Error('no ERC8004_REVIEWER_KEY is configured');
    const data = encodeFeedback(feedback);
    const txHash = await this.#send(sender, this.#reputation, data, this.#feedbackGas);
    const receipt = await this.#receipt(txHash);
    return { txHash, blockNumber: receipt.blockNumber };
  }

  /**
   * Broadcast one call. A broadcast failure propagates: it is not retried, on
   * this key or another, because a second `register` would mint a second agent.
   */
  #send(sender: RoleSender, to: Address, data: Hex, gas: bigint): Promise<Hex> {
    return serial(sender, async () => {
      const pending = await this.#chain.getTransactionCount({
        address: sender.address,
        blockTag: 'pending',
      });
      const nonce =
        sender.lastNonce === undefined ? pending : Math.max(pending, sender.lastNonce + 1);
      const fees = await this.#chain.estimateFeesPerGas();
      const hash = await sender.client.sendTransaction({
        account: sender.account,
        chain: monadTestnet,
        to,
        data,
        gas,
        nonce,
        ...(fees.maxFeePerGas !== undefined ? { maxFeePerGas: fees.maxFeePerGas } : {}),
        ...(fees.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
          : {}),
      });
      sender.lastNonce = nonce;
      return hash;
    });
  }

  async #receipt(hash: Hex) {
    const receipt = await this.#chain.waitForTransactionReceipt({
      hash,
      timeout: this.#receiptTimeoutMs,
    });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted on chain`);
    return receipt;
  }
}

interface RoleSender {
  readonly address: Address;
  readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly client: WalletClient;
  tail: Promise<unknown>;
  lastNonce: number | undefined;
}

function roleSender(key: Hex): RoleSender {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    account,
    client: createWalletClient({ account, chain: monadTestnet, transport: http() }) as WalletClient,
    tail: Promise.resolve(),
    lastNonce: undefined,
  };
}

function serial<T>(sender: RoleSender, run: () => Promise<T>): Promise<T> {
  const next = sender.tail.catch(() => undefined).then(run);
  sender.tail = next.catch(() => undefined);
  return next;
}

/** The `agentId` the registry minted, off the receipt's `Registered` event. */
function agentIdFromLogs(
  logs: readonly {
    readonly address: Address;
    readonly data: Hex;
    readonly topics: readonly Hex[];
  }[],
  identity: Address,
  owner: Address,
): bigint | undefined {
  for (const log of logs) {
    if (!isAddressEqual(log.address, identity)) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC8004_IDENTITY_ABI,
        eventName: 'Registered',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as { agentId?: bigint; owner?: Address };
      // Only OUR registration counts: another owner's log is not this hire's id.
      if (
        args.agentId !== undefined &&
        args.owner !== undefined &&
        isAddressEqual(args.owner, owner)
      ) {
        return args.agentId;
      }
    } catch {
      // Not a Registered event we can read: keep looking.
    }
  }
  return undefined;
}

/** The real client when a registrar key is configured, `undefined` otherwise. */
export function createErc8004Client(config: Erc8004Config): Erc8004Client | undefined {
  if (!config.registrarKey) return undefined;
  return new Erc8004ChainClient({
    registrarKey: config.registrarKey,
    reviewerKey: config.reviewerKey,
    rpcUrl: config.rpcUrl,
    registerGas: config.registerGas,
    feedbackGas: config.feedbackGas,
  });
}

/** The `register(string)` calldata for one agent URI: what the live script measures. */
export function encodeRegister(agentUri: string): Hex {
  return encodeFunctionData({
    abi: ERC8004_IDENTITY_ABI,
    functionName: 'register',
    args: [agentUri],
  });
}

/** The `giveFeedback(...)` calldata for one write: what the live script measures. */
export function encodeFeedback(feedback: Erc8004FeedbackWrite): Hex {
  return encodeFunctionData({
    abi: ERC8004_REPUTATION_ABI,
    functionName: 'giveFeedback',
    args: [
      feedback.agentId,
      feedback.value,
      feedback.valueDecimals,
      feedback.tag1,
      feedback.tag2,
      feedback.endpoint,
      feedback.feedbackURI,
      feedback.feedbackHash,
    ],
  });
}

// ---------------------------------------------------------------------------
// The reputation service
// ---------------------------------------------------------------------------

/** DI token for the ERC-8004 writer, so Nest can hand it to the hire path. */
export const ERC8004_WRITER = Symbol('ERC8004_WRITER');

export type Erc8004RefusalReason =
  | 'not_configured'
  | 'reviewer_unconfigured'
  | 'self_feedback_refused'
  | 'not_registered'
  | 'thesis_open'
  | 'notional_unknown'
  | 'duplicate'
  | 'write_failed'
  | 'unconfirmed';

export type Erc8004Registration =
  | {
      readonly ok: true;
      /** The `agentId`, as a decimal string: a uint256 does not survive JSON. */
      readonly agentId: string;
      readonly txHash: Hex;
      readonly agentUri: string;
    }
  | {
      readonly ok: false;
      readonly reason: Erc8004RefusalReason;
      readonly message: string;
      readonly txHash?: Hex;
    };

export type Erc8004Feedback =
  | {
      readonly ok: true;
      readonly agentId: string;
      readonly value: bigint;
      readonly valueDecimals: number;
      readonly tag1: string;
      readonly tag2: VerdictVenue;
      readonly txHash: Hex;
    }
  | {
      readonly ok: false;
      readonly reason: Erc8004RefusalReason;
      readonly message: string;
      readonly txHash?: Hex;
    };

export interface Erc8004ReputationOptions {
  /** Absent when no registrar key is configured: every write then refuses, quietly. */
  readonly client?: Erc8004Client;
  /** Where an agent is read from: a feedback write needs its `erc8004AgentId`. */
  readonly agents: { get(id: string): Promise<AgentRecord | undefined> };
  readonly agentBaseUrl: string;
  readonly mcpEndpoint?: string;
  readonly imageUrl?: string;
  /** True when the reviewer key is the registrar: feedback is refused, not attempted. */
  readonly selfFeedback?: boolean;
  readonly logger?: Erc8004Logger;
}

/**
 * Sente's side of ERC-8004: the identity a hire gets, and the reputation every
 * verdict writes.
 *
 * NOTHING HERE THROWS, and that is the contract with both callers. A hire must
 * not fail because a registry was unreachable — the rule the SEN-14 gas drip
 * follows — and a close that landed must not be reported to the model as failed
 * because its verdict could not be published. Every outcome comes back as a
 * value the caller can log.
 *
 * Writes are queued inside this service: `whenIdle()` is what a spec (or a
 * shutdown) awaits, because the event-log hook fires the feedback without
 * blocking the tool call that produced it.
 */
export class Erc8004Reputation {
  readonly #client?: Erc8004Client;
  readonly #agents: Erc8004ReputationOptions['agents'];
  readonly #agentBaseUrl: string;
  readonly #mcpEndpoint?: string;
  readonly #imageUrl?: string;
  readonly #selfFeedback: boolean;
  readonly #logger?: Erc8004Logger;
  #tail: Promise<void> = Promise.resolve();
  /** `agentId:thesisSeq`, so this process cannot publish one thesis twice. */
  readonly #published = new Set<string>();

  constructor(options: Erc8004ReputationOptions) {
    this.#client = options.client;
    this.#agents = options.agents;
    this.#agentBaseUrl = options.agentBaseUrl;
    this.#mcpEndpoint = options.mcpEndpoint;
    this.#imageUrl = options.imageUrl;
    this.#selfFeedback = options.selfFeedback ?? false;
    this.#logger = options.logger;
  }

  /** The URI a hired agent is registered under. Public for specs and the live script. */
  agentUri(agent: AgentRecord): string {
    return agentUriFor({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      strategy: agent.strategy,
      address: agent.address,
      mandate: agent.mandate,
      agentBaseUrl: this.#agentBaseUrl,
      ...(this.#mcpEndpoint ? { mcpEndpoint: this.#mcpEndpoint } : {}),
      ...(this.#imageUrl ? { imageUrl: this.#imageUrl } : {}),
    });
  }

  /**
   * Mints the agent's identity. Returns the `agentId` to store, or why not.
   *
   * The URI is built from the record AS HIRED: the mandate summary is the one
   * the user wrote, and a later amend does not rewrite it (an on-chain URI edit
   * is another transaction; see `docs/erc8004.md`).
   */
  async registerOnHire(agent: AgentRecord): Promise<Erc8004Registration> {
    const client = this.#client;
    if (!client) return refusal('not_configured', 'ERC-8004 is not configured');
    const agentUri = this.agentUri(agent);
    try {
      const { agentId, txHash } = await client.register(agentUri);
      this.#logger?.log?.(
        `registered agent ${agent.id} as ERC-8004 #${agentId} (${txHash}, ${agentUri.length}-char URI)`,
      );
      return { ok: true, agentId: agentId.toString(), txHash, agentUri };
    } catch (error) {
      const message = describeError(error);
      // No retry, on purpose: a second register would mint a SECOND agent, and an
      // unconfirmed transaction may still land. The operator follows the hash.
      this.#logger?.warn(`agent ${agent.id} not registered with ERC-8004: ${message}`);
      return refusal('write_failed', message);
    }
  }

  /**
   * Publishes one settled thesis as feedback: `value` is the realised PnL in
   * basis points of the thesis's cost basis, `valueDecimals` 2, tagged `pnl` and
   * the venue.
   *
   * `endpoint`, `feedbackURI` and `feedbackHash` are empty on purpose: the spec
   * makes them optional, and Sente hosts no per-feedback document, so pointing at
   * a URI — let alone a hash of it — would imply an audit trail that does not
   * exist. The `agentURI` carries the Ledger link, which is where the fills
   * behind the number are readable.
   */
  recordVerdict(verdict: Verdict): Promise<Erc8004Feedback> {
    return this.#enqueue(() => this.#recordVerdict(verdict));
  }

  /** Resolves when every queued write has settled. Never rejects. */
  whenIdle(): Promise<void> {
    return this.#tail;
  }

  async #recordVerdict(verdict: Verdict): Promise<Erc8004Feedback> {
    const client = this.#client;
    if (!client) return refusal('not_configured', 'ERC-8004 is not configured');
    if (this.#selfFeedback) {
      return refusal(
        'self_feedback_refused',
        'ERC8004_REVIEWER_KEY is the registrar; the registry refuses self-feedback',
      );
    }
    if (verdict.held === 'open') {
      return refusal(
        'thesis_open',
        `thesis ${verdict.thesisSeq} is still open; nothing is settled`,
      );
    }
    const pnl = pnlBasisPoints(verdict.realisedPnl, verdict.costBasis);
    if (!pnl) {
      return refusal(
        'notional_unknown',
        `thesis ${verdict.thesisSeq} has no positive cost basis (${verdict.costBasis} ` +
          `${verdict.pnlAsset}); basis points would be meaningless`,
      );
    }
    const agent = await this.#agents.get(verdict.agentId);
    const agentId = agent?.erc8004AgentId;
    if (agentId === undefined) {
      return refusal('not_registered', `agent ${verdict.agentId} has no ERC-8004 identity`);
    }
    const key = `${agentId}:${verdict.thesisSeq}`;
    if (this.#published.has(key)) {
      return refusal('duplicate', `thesis ${verdict.thesisSeq} was already published (${key})`);
    }
    try {
      const receipt = await client.giveFeedback({
        agentId: BigInt(agentId),
        value: pnl.value,
        valueDecimals: pnl.valueDecimals,
        tag1: ERC8004_PNL_TAG,
        tag2: verdict.venue,
        endpoint: '',
        feedbackURI: '',
        feedbackHash: ZERO_FEEDBACK_HASH,
      });
      this.#published.add(key);
      this.#logger?.log?.(
        `feedback for ERC-8004 #${agentId} thesis ${verdict.thesisSeq} ` +
          `(${verdict.market} ${verdict.venue}): ${formatBps(pnl.value)} bps (${receipt.txHash})`,
      );
      return {
        ok: true,
        agentId,
        value: pnl.value,
        valueDecimals: pnl.valueDecimals,
        tag1: ERC8004_PNL_TAG,
        tag2: verdict.venue,
        txHash: receipt.txHash,
      };
    } catch (error) {
      const message = describeError(error);
      this.#logger?.warn(`ERC-8004 feedback for agent ${verdict.agentId} not written: ${message}`);
      return refusal('write_failed', message);
    }
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function refusal(
  reason: Erc8004RefusalReason,
  message: string,
): { ok: false; reason: Erc8004RefusalReason; message: string } {
  return { ok: false, reason, message };
}

/** `25000n` -> `250.00`, for logs. */
function formatBps(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = (error as { details?: unknown }).details;
  return `${error.name}: ${error.message}${typeof details === 'string' ? ` (${details})` : ''}`;
}

// ---------------------------------------------------------------------------
// The verdict hook
// ---------------------------------------------------------------------------

/**
 * The event log, with the ERC-8004 feedback attached to it.
 *
 * A verdict is appended exactly once per settled thesis (`verdict.ts`), in one
 * place (the gated `close_position`), and both the Tool Runner and the MCP
 * session write through the same log — so decorating the log is the hook that
 * catches every verdict without a second call site to keep in sync.
 *
 * `append` returns as soon as the event is stored: publishing to a registry over
 * RPC must not slow the tool call that closed a position, and a stored verdict
 * must survive a registry that is down. The write is queued inside
 * {@link Erc8004Reputation}, which never rejects; a spec awaits `whenIdle()`.
 */
export class ReputationEventLog implements AgentEventLog {
  readonly #inner: AgentEventLog;
  readonly #reputation: Erc8004Reputation;

  constructor(inner: AgentEventLog, reputation: Erc8004Reputation) {
    this.#inner = inner;
    this.#reputation = reputation;
  }

  async append(event: Parameters<AgentEventLog['append']>[0]): Promise<AgentEvent> {
    const stored = await this.#inner.append(event);
    if (stored.kind === 'verdict') {
      const verdict = stored.detail as unknown as Verdict;
      // Deliberately not awaited: see the class comment. Nothing here rejects.
      void this.#reputation.recordVerdict({ ...verdict, agentId: stored.agentId });
    }
    return stored;
  }

  list(agentId: string, query?: Parameters<AgentEventLog['list']>[1]): Promise<AgentEvent[]> {
    return this.#inner.list(agentId, query);
  }
}
