/**
 * The mandate, anchored on chain (SEN-194).
 *
 * Every agent's ERC-8004 identity (SEN-27) carries one metadata entry,
 * `sente.mandate`, holding the hash of the mandate it runs under and of the
 * Privy policy compiled from it. A hire sets it in the registration
 * transaction itself; every amend and revoke rewrites it with `setMetadata`.
 * Anyone can then read the entry off the Identity Registry, recompute the hash
 * from the mandate the agent publishes, and see whether they match —
 * `scripts/mandate-verify.ts` does exactly that.
 *
 * THE VALUE is 66 bytes, `abi.encodePacked(uint8 version, uint8 status,
 * bytes32 mandateHash, bytes32 policyHash)`:
 *
 * | bytes | field | meaning |
 * | --- | --- | --- |
 * | 0 | version | `1` |
 * | 1 | status | `1` active, `2` revoked |
 * | 2–33 | mandateHash | `@sente/mandate` `mandateHash` |
 * | 34–65 | policyHash | `policyHash` of the rules the enclave holds |
 *
 * Packed rather than ABI-encoded or JSON: the value is calldata AND storage,
 * and Monad charges both by the byte (gotcha 4) — 66 bytes is three storage
 * words, an ABI tuple is five.
 *
 * NOTHING HERE BLOCKS OR FAILS A HIRE, AMEND OR REVOKE. The hire's anchor rides
 * the registration, which never fails a hire (SEN-27). An amend or revoke only
 * queues a rewrite: it lands in the background, and a failed one is retried
 * on a schedule and, after that, on the next boot (`reconcile`). Retrying is
 * safe here as it is not for `register`: `setMetadata` writes a value, so a
 * duplicate costs gas but changes nothing. Each attempt and its outcome is a
 * Ledger event (`anchor`), so the owner sees "Mandate anchored on chain" with
 * its transaction, or why not yet.
 *
 * Erasable syntax and `.ts` specifiers, like `erc8004.ts`: the verify script
 * loads this under node's type stripping (CLAUDE.md gotcha 10).
 */
import {
  compileMandate,
  compileRevocationRules,
  compilesKuruDeposit,
  mandateHash,
  policyHash,
} from '@sente/mandate';
import { encodePacked, isHex, size, sliceHex, type Hash, type Hex } from 'viem';

import type { AgentEventLog } from '../events/agent-event-log.ts';
import type { AgentPatch, AgentRecord, MandateAnchor } from '../store/agent-store.ts';
import {
  describeError,
  ERC8004_CHAIN_ID,
  ERC8004_IDENTITY_REGISTRY,
  type Erc8004Client,
  type Erc8004Logger,
  type Erc8004MetadataEntry,
} from './erc8004.ts';

/** DI token for {@link MandateAnchors}. */
export const MANDATE_ANCHORS = Symbol('MANDATE_ANCHORS');

/** The Identity Registry metadata key the anchor lives under. */
export const MANDATE_METADATA_KEY = 'sente.mandate';
export const MANDATE_ANCHOR_VERSION = 1;
export const MANDATE_ANCHOR_BYTES = 66;

const STATUS_CODES = { active: 1, revoked: 2 } as const;
export type AnchorStatus = keyof typeof STATUS_CODES;

const ZERO_HASH: Hash = `0x${'00'.repeat(32)}`;

/** What the registry should hold for an agent, right now. */
export interface DesiredAnchor {
  readonly status: AnchorStatus;
  readonly mandateHash: Hash;
  readonly policyHash: Hash;
}

/**
 * The anchor an agent's stored record implies: its mandate, and the rules its
 * live policy holds — the revocation rules once revoked; otherwise the
 * mandate compiled exactly as `AgentsService.compile` did, with the builder
 * fee it recorded and the deposit pin once it has one (SEN-188).
 */
export function desiredAnchor(agent: AgentRecord): DesiredAnchor {
  const revoked = agent.status === 'revoked';
  const pinned = agent.kuruDepositPinned === true || !compilesKuruDeposit(agent.mandate);
  const rules = revoked
    ? compileRevocationRules(agent.mandate)
    : compileMandate(agent.mandate, {
        kuruBuilder: agent.kuruBuilder ?? null,
        agentAddress: pinned ? agent.address : null,
      });
  return {
    status: revoked ? 'revoked' : 'active',
    mandateHash: mandateHash(agent.mandate),
    policyHash: policyHash(rules),
  };
}

/** The 66-byte metadata value. */
export function encodeMandateAnchor(anchor: DesiredAnchor): Hex {
  return encodePacked(
    ['uint8', 'uint8', 'bytes32', 'bytes32'],
    [MANDATE_ANCHOR_VERSION, STATUS_CODES[anchor.status], anchor.mandateHash, anchor.policyHash],
  );
}

/** The value read back off the registry, or `undefined` when it is not an anchor. */
export function decodeMandateAnchor(value: Hex): DesiredAnchor | undefined {
  if (!isHex(value) || size(value) !== MANDATE_ANCHOR_BYTES) return undefined;
  const version = Number.parseInt(value.slice(2, 4), 16);
  const code = Number.parseInt(value.slice(4, 6), 16);
  const status = (Object.keys(STATUS_CODES) as AnchorStatus[]).find(
    (s) => STATUS_CODES[s] === code,
  );
  if (version !== MANDATE_ANCHOR_VERSION || !status) return undefined;
  return {
    status,
    mandateHash: sliceHex(value, 2, 34),
    policyHash: sliceHex(value, 34, 66),
  };
}

/** The metadata entry for `register` and `setMetadata`. */
export function mandateMetadataEntry(anchor: DesiredAnchor): Erc8004MetadataEntry {
  return { metadataKey: MANDATE_METADATA_KEY, metadataValue: encodeMandateAnchor(anchor) };
}

/** Whether the stored anchor already says what the registry should hold. */
export function isAnchorCurrent(anchor: MandateAnchor | undefined, want: DesiredAnchor): boolean {
  return (
    anchor !== undefined &&
    anchor.status === want.status &&
    anchor.mandateHash === want.mandateHash &&
    (anchor.policyHash ?? ZERO_HASH) === want.policyHash
  );
}

/** The record to store once `want` is on chain at `txHash`. */
export function anchorRecord(
  want: DesiredAnchor,
  agentTokenId: string,
  txHash: Hash,
  at: Date = new Date(),
): MandateAnchor {
  return {
    mandateHash: want.mandateHash,
    ...(want.policyHash !== ZERO_HASH ? { policyHash: want.policyHash } : {}),
    status: want.status,
    txHash,
    chainId: ERC8004_CHAIN_ID,
    registry: ERC8004_IDENTITY_REGISTRY,
    agentTokenId,
    anchoredAt: at.toISOString(),
  };
}

/** The `detail` of an `anchor` Ledger event. */
export interface AnchorEventDetail {
  readonly status: 'anchored' | 'failed';
  /** The sentence the Ledger shows. */
  readonly message: string;
  readonly txHash?: Hash;
  readonly mandateHash: Hash;
  readonly policyHash: Hash;
  readonly anchorStatus: AnchorStatus;
  readonly agentTokenId?: string;
  readonly registry: string;
  readonly chainId: number;
}

/** Retries after a failed rewrite: 30 s, 2 min, 10 min; then the next boot. */
export const ANCHOR_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** A failure reason short enough for a Ledger row. */
function shortReason(error: unknown): string {
  const text = describeError(error).split('\n')[0] ?? '';
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function anchoredMessage(want: DesiredAnchor, initial: boolean): string {
  if (want.status === 'revoked') return 'Revocation anchored on chain';
  return initial ? 'Mandate anchored on chain' : 'Amended mandate anchored on chain';
}

export interface MandateAnchorsOptions {
  /** Absent when no registrar key is configured: everything is a no-op. */
  readonly client?: Erc8004Client;
  readonly agents: {
    get(id: string): Promise<AgentRecord | undefined>;
    update(id: string, patch: AgentPatch): Promise<AgentRecord>;
    listAll(): Promise<AgentRecord[]>;
  };
  readonly events: Pick<AgentEventLog, 'append'>;
  readonly logger?: Erc8004Logger;
  readonly retryDelaysMs?: readonly number[];
  /** How a retry is scheduled; specs pass one they can run by hand. */
  readonly schedule?: (run: () => void, delayMs: number) => void;
}

function defaultSchedule(run: () => void, delayMs: number): void {
  // Unref'd: a pending retry must not keep a shutting-down process alive; the
  // next boot's `reconcile` picks it up.
  setTimeout(run, delayMs).unref();
}

/**
 * Keeps each agent's on-chain anchor in step with its stored record. One write
 * at a time for the whole process (the registrar key is serialised anyway), and
 * no method rejects.
 */
export class MandateAnchors {
  readonly #client?: Erc8004Client;
  readonly #agents: MandateAnchorsOptions['agents'];
  readonly #events: Pick<AgentEventLog, 'append'>;
  readonly #logger?: Erc8004Logger;
  readonly #retryDelaysMs: readonly number[];
  readonly #schedule: (run: () => void, delayMs: number) => void;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MandateAnchorsOptions) {
    this.#client = options.client;
    this.#agents = options.agents;
    this.#events = options.events;
    this.#logger = options.logger;
    this.#retryDelaysMs = options.retryDelaysMs ?? ANCHOR_RETRY_DELAYS_MS;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  get enabled(): boolean {
    return this.#client !== undefined;
  }

  /**
   * The metadata a hire registers with, or none when anchoring is off. The
   * caller passes it to `Erc8004Reputation.registerOnHire` and hands the
   * outcome back to {@link recordHire}.
   */
  hireMetadata(agent: AgentRecord): { want: DesiredAnchor; entry: Erc8004MetadataEntry } | null {
    if (!this.#client) return null;
    const want = desiredAnchor(agent);
    return { want, entry: mandateMetadataEntry(want) };
  }

  /**
   * After the registration: the anchor to store when it landed (the anchor
   * rode that transaction), and a Ledger event either way. Never throws.
   */
  async recordHire(
    agent: AgentRecord,
    want: DesiredAnchor,
    outcome: { ok: true; agentId: string; txHash: Hash } | { ok: false; message: string },
  ): Promise<MandateAnchor | undefined> {
    if (!outcome.ok) {
      await this.#event(agent.id, want, {
        status: 'failed',
        message:
          'Mandate not anchored on chain: the agent’s on-chain identity could not be ' +
          `registered (${shortReason(outcome.message)})`,
      });
      return undefined;
    }
    const anchor = anchorRecord(want, outcome.agentId, outcome.txHash);
    await this.#event(agent.id, want, {
      status: 'anchored',
      message: anchoredMessage(want, true),
      txHash: outcome.txHash,
      agentTokenId: outcome.agentId,
    });
    return anchor;
  }

  /**
   * Brings one agent's anchor up to date, in the background. Call it after
   * every committed amend and revoke; the returned promise is for specs and
   * never rejects.
   */
  sync(agentId: string): Promise<void> {
    return this.#enqueue(() => this.#sync(agentId, 0));
  }

  /** Every registered agent whose anchor is stale: what boot runs. Never rejects. */
  async reconcile(): Promise<void> {
    if (!this.#client) return;
    let agents: AgentRecord[];
    try {
      agents = await this.#agents.listAll();
    } catch (error) {
      this.#logger?.warn(`mandate anchors not reconciled: ${describeError(error)}`);
      return;
    }
    const stale = agents.filter(
      (a) => a.erc8004AgentId !== undefined && !isAnchorCurrent(a.mandateAnchor, desiredAnchor(a)),
    );
    if (stale.length > 0) {
      this.#logger?.log?.(`re-anchoring ${stale.length} agent mandate(s) on chain`);
    }
    await Promise.all(stale.map((a) => this.sync(a.id)));
  }

  /** Resolves when every queued write has settled. Never rejects. */
  whenIdle(): Promise<void> {
    return this.#tail;
  }

  async #sync(agentId: string, attempt: number): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const agent = await this.#agents.get(agentId);
    const tokenId = agent?.erc8004AgentId;
    // No identity, no anchor: the registration that would hold it failed at
    // hire and is never retried (a second `register` mints a second agent).
    if (!agent || tokenId === undefined) return;
    const want = desiredAnchor(agent);
    if (isAnchorCurrent(agent.mandateAnchor, want)) return;
    try {
      const { txHash } = await client.setMetadata(BigInt(tokenId), mandateMetadataEntry(want));
      await this.#agents.update(agentId, { mandateAnchor: anchorRecord(want, tokenId, txHash) });
      this.#logger?.log?.(
        `anchored agent ${agentId} mandate ${want.mandateHash} (${want.status}) ` +
          `on ERC-8004 #${tokenId}: ${txHash}`,
      );
      await this.#event(agentId, want, {
        status: 'anchored',
        message: anchoredMessage(want, false),
        txHash,
        agentTokenId: tokenId,
      });
    } catch (error) {
      const delay = this.#retryDelaysMs[attempt];
      const reason = shortReason(error);
      this.#logger?.warn(
        `agent ${agentId} mandate not anchored (attempt ${attempt + 1}): ${describeError(error)}`,
      );
      await this.#event(agentId, want, {
        status: 'failed',
        message:
          `Mandate not anchored on chain yet: ${reason}. ` +
          (delay !== undefined
            ? `Retrying in ${Math.round(delay / 1000)} s.`
            : 'Retrying after the next restart or amend.'),
        agentTokenId: tokenId,
      });
      if (delay !== undefined) {
        this.#schedule(() => {
          void this.#enqueue(() => this.#sync(agentId, attempt + 1));
        }, delay);
      }
    }
  }

  async #event(
    agentId: string,
    want: DesiredAnchor,
    detail: Pick<AnchorEventDetail, 'status' | 'message' | 'txHash' | 'agentTokenId'>,
  ): Promise<void> {
    const full: AnchorEventDetail = {
      ...detail,
      mandateHash: want.mandateHash,
      policyHash: want.policyHash,
      anchorStatus: want.status,
      registry: ERC8004_IDENTITY_REGISTRY,
      chainId: ERC8004_CHAIN_ID,
    };
    try {
      await this.#events.append({
        agentId,
        kind: 'anchor',
        detail: full as unknown as Record<string, unknown>,
      });
    } catch (error) {
      this.#logger?.warn(`anchor event for agent ${agentId} not logged: ${describeError(error)}`);
    }
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(run).catch((error: unknown) => {
      this.#logger?.error(`mandate anchor write threw: ${describeError(error)}`);
    });
    this.#tail = next;
    return next;
  }
}
