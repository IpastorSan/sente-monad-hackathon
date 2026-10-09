/**
 * Where each agent's watchers live (SEN-182), with what checking them needs
 * kept between checks: every edge clause's previous answer, each watcher's
 * last firing (for its cooldown), and the counters the agent page shows.
 *
 * PERSISTENCE: in memory, or `<STATE_DIR>/agent-watchers.json` with STATE_DIR
 * set (one process per STATE_DIR, CLAUDE.md gotcha 14). The file is rewritten
 * on every change, checks included: it is a few records, and an edge state
 * that did not survive a restart would either miss a cross or report one twice.
 */
import { JsonRecordFile } from '../../state/json-file';
import type { WatcherClause } from './watcher.schema';

/** DI token for the `WatcherStore`. */
export const WATCHER_STORE = Symbol('WATCHER_STORE');

/** `<STATE_DIR>/<this>.json`. */
export const WATCHERS_FILE = 'agent-watchers';

export type WatcherSetBy = 'agent' | 'owner';

export interface StoredWatcher {
  readonly id: string;
  readonly label: string;
  readonly match: 'all' | 'any';
  readonly clauses: readonly WatcherClause[];
  readonly cooldownMinutes: number;
  readonly setBy: WatcherSetBy;
  /** Unix epoch ms. */
  readonly createdAt: number;
  /**
   * Per clause, the previous check's answer for an edge clause: `null` before
   * the first readable check (no edge can be seen yet) and always for a level.
   */
  readonly edges: readonly (boolean | null)[];
  readonly lastEvaluatedAt: number | null;
  readonly lastFiredAt: number | null;
  readonly fireCount: number;
  /** What the last firing saw, in words. */
  readonly lastObserved: string | null;
  /** Why the last check could not read a clause, if it could not. */
  readonly lastError: string | null;
}

export interface WatcherSet {
  readonly agentId: string;
  readonly heartbeatSeconds: number;
  readonly watchers: readonly StoredWatcher[];
  /** Unix epoch ms. */
  readonly updatedAt: number;
  /** Scheduled checks done without the model. */
  readonly checks: number;
  /** Of those, the ones that started no run: model calls saved. */
  readonly skipped: number;
  /** Runs a watcher started. */
  readonly wakes: number;
  /** Runs the heartbeat started. */
  readonly heartbeats: number;
  readonly lastCheckAt: number | null;
  readonly lastWakeAt: number | null;
}

export interface WatcherStore {
  get(agentId: string): WatcherSet | undefined;
  put(set: WatcherSet): void;
  delete(agentId: string): void;
}

export class InMemoryWatcherStore implements WatcherStore {
  protected readonly sets = new Map<string, WatcherSet>();

  get(agentId: string): WatcherSet | undefined {
    const set = this.sets.get(agentId);
    return set ? structuredClone(set) : undefined;
  }

  put(set: WatcherSet): void {
    this.sets.set(set.agentId, structuredClone(set));
  }

  delete(agentId: string): void {
    this.sets.delete(agentId);
  }
}

export class FileWatcherStore extends InMemoryWatcherStore {
  readonly #file: JsonRecordFile<WatcherSet>;

  /** Loads eagerly, so an unreadable file fails the boot rather than starting empty. */
  constructor(path: string) {
    super();
    this.#file = new JsonRecordFile<WatcherSet>(path);
    for (const set of this.#file.load()) this.sets.set(set.agentId, set);
  }

  get path(): string {
    return this.#file.path;
  }

  get size(): number {
    return this.sets.size;
  }

  override put(set: WatcherSet): void {
    const before = this.sets.get(set.agentId);
    super.put(set);
    this.#save(() => (before ? this.sets.set(set.agentId, before) : this.sets.delete(set.agentId)));
  }

  override delete(agentId: string): void {
    const before = this.sets.get(agentId);
    super.delete(agentId);
    this.#save(() => before && this.sets.set(agentId, before));
  }

  /** Writes through; on failure puts memory back and throws, so the caller knows. */
  #save(undo: () => unknown): void {
    try {
      this.#file.save([...this.sets.values()]);
    } catch (error) {
      undo();
      throw error;
    }
  }
}
