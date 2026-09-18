/**
 * The consensus ramp (SEN-24): the hairline under a Ledger trade that fills in
 * Monad purple as the block the order landed in acquires consensus.
 *
 * A Monad block goes `Proposed` -> `Voted` -> `Finalized`, and SEN-21 exposes
 * exactly that per height, with the epoch ms at which each state was first
 * seen. This draws those states as progress — one Skia hairline, a third per
 * stop — and only ever animates between states the block's own record contains.
 * A block that skipped `Voted` (Monad does) jumps a third and leaves `VOTED`
 * dark, because that is what the network did.
 *
 * WHERE THE STATE COMES FROM (SEN-35): off the event itself. The API attaches
 * `consensus` to every `order`, `fill` and `close` that names a block, so a row
 * arrives knowing where its block is, and a ledger of settled trades makes ZERO
 * consensus requests. `GET /chain/blocks/:n/consensus` is asked only while a
 * block has not reached finality yet, through `ConsensusFeed` — ONE poller per
 * screen, shared by every row, not one per row. Before that, every row polled
 * from mount and a screenful was a request burst on open.
 *
 * Purple marks an event, not a block. A record whose last state landed more than
 * a couple of seconds ago is settled on arrival — no fill, no ticks, just the
 * neutral track and the height — so a ledger full of old trades is achromatic
 * and the one row that is happening right now is the one that lights up. That is
 * also why the drain: once the block is final the ramp has nothing left to say,
 * so the purple leaves and the block height stamps in behind it, in mono, which
 * is the fact worth keeping.
 *
 * Ticks are per stop and mean "the chain reported this moments ago", not "I
 * watched it land": a row arrives about a second after its order executed, so
 * most ramps catch the sequence a beat late, walk through it, and tick as they
 * go. A block nobody would call current gets none, because a buzz that says
 * "this just happened" about a five-minute-old block is a lie you can feel.
 *
 * A reorg — the same height now holding a different block — plays the fill
 * backwards and says `reordered, resubmitting`, calmly, not as an error.
 * Following the resubmission is the event trail's job: the order that is sent
 * again gets its own `order` event, its own row and its own ramp.
 *
 * Skia rather than two Reanimated views so the track and the fill are one
 * surface: two hairlines in two views can round to different pixel rows at a
 * fractional density and show a seam. Reanimated drives it through Skia's own
 * shared-value binding, which is the pair Expo SDK 57 pins (Skia 2.6.2,
 * Reanimated 4.5.1).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Rect } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { groupThousands } from '@/agents/amounts';
import {
  consensusNeedsPolling,
  CONSENSUS_STOPS,
  FINAL_CONSENSUS_STATES,
  type CommitTimes,
  type EventConsensus,
} from '@/agents/ledger';
import { useSession } from '@/session';
import { API_URL, USER_ID_HEADER } from '@/wallet/api';

import { color, font, text } from './theme';

// ---------------------------------------------------------------------------
// Cadence and shape
// ---------------------------------------------------------------------------

/** A hairline: the same 1dp the Ledger's own rules use. */
const TRACK = 1;
/** The ramp's unit is a third: one per stop. */
const STOPS = 3;
/** The last stop. Landing on it in a live ramp is what starts the drain. */
const FINAL_STOP = STOPS - 1;

/**
 * 150 ms while the whole window is ~500 ms wide and the answers are public chain
 * data: fine enough to catch each state, coarse enough not to hammer. Only
 * blocks that have not finalized are asked for at all.
 */
const POLL_MS = 150;
/**
 * A block that has not finalized in this long is not following the ~500 ms the
 * chain normally takes, so the ramp stops asking at full rate — but it keeps
 * asking, because a stalled block is exactly the one worth still watching.
 */
const SLOW_AFTER_MS = 12_000;
const SLOW_POLL_MS = 2_000;
/** A request that never settles must not stall the ramp forever. */
const REQUEST_TIMEOUT_MS = 2_000;
/** Consecutive failures that mean "the API is not answering". */
const MAX_FAILURES = 3;
/**
 * How recent a state has to be to count as happening now. Comfortably longer
 * than the ~1 s the Ledger takes to surface the event that produced the trade,
 * and far short of the four minutes SEN-21 keeps consensus for.
 */
const LIVE_MS = 2_500;

const FILL_MS = 240;
/** Purple sits at full for this long before it drains, so it can be seen. */
const HOLD_MS = 260;
const DRAIN_MS = 420;

/**
 * How far up the ramp each state sits, by the name the socket uses. `Verified`
 * is past finality and Monad only reports it over the socket (SEN-21 says so),
 * so it lands on `FINALIZED` rather than inventing a fourth label.
 */
const STOP_OF_STATE: Record<string, number> = {
  Proposed: 0,
  Voted: 1,
  Finalized: 2,
  Verified: 2,
};

type TimeKey = keyof CommitTimes;

/** The `at` key behind each stop. `finalized` falls back to `verified`. */
const TIME_OF_STOP: Record<number, TimeKey> = {
  0: 'proposed',
  1: 'voted',
  2: 'finalized',
};

/**
 * One block's consensus record, as `GET /chain/blocks/:n/consensus` returns it.
 *
 * The two ids are different values for the same block and are never compared
 * against each other (SEN-35): `blockId` is Monad's consensus id, from the
 * socket, and `blockHash` is the execution hash, from the API's HTTP fallback.
 * Either one changing at the same height is a reorg; one of them merely
 * appearing is the API learning the block's other name.
 */
type ConsensusRecord = {
  readonly blockNumber: number;
  readonly blockId?: string;
  readonly blockHash?: string;
  /** `Proposed` | `Voted` | `Finalized` | `Verified`. */
  readonly state: string;
  readonly at: CommitTimes;
};

type Phase =
  /** Nothing known yet: no state on the event, and the first read is in flight. */
  | 'reading'
  /** The block's state is in hand, and may still move. */
  | 'live'
  /** The height now holds a different block. */
  | 'reorged'
  /** Older than the window SEN-21 keeps. Not an error. */
  | 'beyond'
  /** The API is not answering. */
  | 'unreachable';

/** What one row knows about its block, from the event or from a read. */
type Reading = {
  readonly phase: Phase;
  readonly state: string | null;
  readonly at: CommitTimes;
  /** Nothing left to ask: final, reorged, past the window, or unreachable. */
  readonly done: boolean;
};

const EMPTY_TIMES: CommitTimes = {};
const READING: Reading = { phase: 'reading', state: null, at: EMPTY_TIMES, done: false };

/** A reading with nothing left to ask: `done` is the point, so it is not optional. */
function terminal(phase: Phase, at: CommitTimes = EMPTY_TIMES): Reading {
  return { phase, state: null, at, done: true };
}

/**
 * The event's own `consensus` block, turned into a reading. This is the whole of
 * SEN-35's cheapness: a finalized or out-of-window row is `done` on arrival and
 * is never asked about.
 */
function seedReading(seed: EventConsensus | null | undefined): Reading {
  if (!seed) return READING;
  if (seed.state === 'unknown') return terminal('beyond');
  if (seed.state === 'reorged') return terminal('reorged', seed.at);
  return { phase: 'live', state: seed.state, at: seed.at, done: !consensusNeedsPolling(seed) };
}

// ---------------------------------------------------------------------------
// One poller for the whole screen
// ---------------------------------------------------------------------------

/**
 * One read. `beyond` is a 404 that is *ours* — the API's own `block_not_tracked`
 * — because Nest answers an unknown route with a bare 404 too, and an API that
 * predates SEN-21 must not read as "that block is old".
 */
async function readConsensus(
  blockNumber: number,
  userId: string,
  signal: AbortSignal,
): Promise<ConsensusRecord | 'beyond'> {
  const response = await fetch(`${API_URL}/chain/blocks/${blockNumber}/consensus`, {
    headers: { [USER_ID_HEADER]: userId },
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) {
      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      if (body?.reason === 'block_not_tracked') return 'beyond';
    }
    throw new Error(`consensus read answered ${response.status}`);
  }
  return (await response.json()) as ConsensusRecord;
}

/** What the feed remembers per block between reads. Not rendered directly. */
type Watched = {
  /** How many rows are showing this height. A block is dropped at zero. */
  rows: number;
  /** Epoch ms this block was first tracked: what the slow-down is measured from. */
  since: number;
  failures: number;
  /** The ids this height held when we started. Either one changing is a reorg. */
  blockId?: string;
  blockHash?: string;
  /** Where the block is now, and the rows to tell when that moves. */
  reading: Reading;
  listeners: Set<(reading: Reading) => void>;
};

type Feed = {
  /**
   * Register a row's interest in a height and subscribe it to that height's
   * readings; the returned function drops both.
   */
  track(
    blockNumber: number,
    seed: EventConsensus | null | undefined,
    onReading: (reading: Reading) => void,
  ): () => void;
};

const FeedContext = createContext<Feed | null>(null);

/**
 * The screen's single consensus poller. Wrap the Ledger's list in it; every
 * `ConsensusRamp` underneath shares it.
 *
 * Each row registers its height and its seed state. Only the heights that have
 * not reached finality are ever requested, all of them in one pass per tick, so
 * a screenful of settled trades costs nothing and two rows on the same block
 * cost one request rather than two. Without this provider a ramp still renders
 * what its event told it — it simply never refreshes.
 *
 * A tick pushes each height's reading to the rows showing THAT height rather
 * than re-rendering the list through the context: the context value is stable
 * for the screen's whole life, so the one row that is moving is the only one
 * that re-renders.
 */
export function ConsensusFeed({ children }: { children: ReactNode }) {
  const { auth } = useSession();
  const userId = auth.address;

  const watched = useRef<Map<number, Watched>>(new Map());
  /** Bumped when a height that can still move is tracked, to restart the loop. */
  const [wake, setWake] = useState(0);

  const track = useCallback<Feed['track']>((blockNumber, seed, onReading) => {
    let entry = watched.current.get(blockNumber);
    if (!entry) {
      entry = {
        rows: 0,
        since: Date.now(),
        failures: 0,
        reading: seedReading(seed),
        listeners: new Set(),
      };
      watched.current.set(blockNumber, entry);
      // A block the event already settled needs no poller at all.
      if (!entry.reading.done) setWake((n) => n + 1);
    }
    entry.rows += 1;
    entry.listeners.add(onReading);
    // A row joining a height another row is already watching starts where that
    // reading is, not where its own event left off.
    onReading(entry.reading);

    return () => {
      const held = watched.current.get(blockNumber);
      if (!held) return;
      held.listeners.delete(onReading);
      held.rows -= 1;
      if (held.rows <= 0) watched.current.delete(blockNumber);
    };
  }, []);

  useEffect(() => {
    if (userId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (blockNumber: number, reading: Reading): void => {
      const entry = watched.current.get(blockNumber);
      if (!entry) return;
      entry.reading = reading;
      for (const listener of entry.listeners) listener(reading);
    };

    const readOne = async (blockNumber: number): Promise<void> => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const read = await readConsensus(blockNumber, userId, controller.signal);
        const entry = watched.current.get(blockNumber);
        if (stopped || !entry) return;
        entry.failures = 0;

        if (read === 'beyond') {
          settle(blockNumber, terminal('beyond'));
          return;
        }
        if (reorgedAway(entry, read)) {
          settle(blockNumber, terminal('reorged', read.at));
          return;
        }
        entry.blockId ??= read.blockId;
        entry.blockHash ??= read.blockHash;
        settle(blockNumber, {
          phase: 'live',
          state: read.state,
          at: read.at,
          done: FINAL_CONSENSUS_STATES.includes(read.state),
        });
      } catch {
        const entry = watched.current.get(blockNumber);
        if (stopped || !entry) return;
        entry.failures += 1;
        if (entry.failures >= MAX_FAILURES) settle(blockNumber, terminal('unreachable'));
      } finally {
        clearTimeout(abort);
      }
    };

    const tick = async (): Promise<void> => {
      const pending = [...watched.current.entries()]
        .filter(([, entry]) => !entry.reading.done)
        .map(([blockNumber]) => blockNumber);
      // Nothing is moving: the loop ends rather than idling. `track` wakes it.
      if (pending.length === 0) return;

      await Promise.all(pending.map(readOne));
      if (stopped) return;

      // The fastest cadence any pending block still deserves: a block that has
      // been stuck for a while is asked about less often, never not at all.
      const oldest = Math.min(
        ...pending.map((blockNumber) => watched.current.get(blockNumber)?.since ?? Date.now()),
      );
      const delay = Date.now() - oldest < SLOW_AFTER_MS ? POLL_MS : SLOW_POLL_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [userId, wake]);

  const feed = useMemo<Feed>(() => ({ track }), [track]);
  return <FeedContext.Provider value={feed}>{children}</FeedContext.Provider>;
}

/**
 * Whether this height now holds a different block than the one we started on.
 *
 * Each id is compared only against its own kind: `blockId` is Monad's consensus
 * id and `blockHash` the execution hash, so they are different strings for the
 * same block and one of them merely appearing is not a reorg (SEN-35).
 */
function reorgedAway(entry: Watched, read: ConsensusRecord): boolean {
  const moved = (was: string | undefined, now: string | undefined): boolean =>
    was !== undefined && now !== undefined && was !== now;
  return moved(entry.blockId, read.blockId) || moved(entry.blockHash, read.blockHash);
}

/**
 * One row's view of its block: what the event said, kept current by the feed for
 * as long as the block can still move.
 */
function useConsensus(blockNumber: number, seed: EventConsensus | null | undefined) {
  const track = useContext(FeedContext)?.track;

  // The row opens on what its own event said, and the feed pushes it every move
  // after that — so a poll re-renders the rows on THAT block and no others.
  const [reading, setReading] = useState<Reading>(() => seedReading(seed));

  // The seed is read once, when the row registers: what happens to the block
  // afterwards is the feed's answer, not the event's. Hence the ref — a fresh
  // `consensus` object on a re-render must not re-register the row.
  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    if (track) return track(blockNumber, seedRef.current, setReading);
    // A ramp outside `ConsensusFeed` would sit on its seed for good, which for a
    // block still acquiring consensus is a ramp that silently stops. Say so
    // rather than shipping a frozen hairline.
    if (consensusNeedsPolling(seedRef.current)) {
      console.warn(
        `ConsensusRamp for block ${blockNumber} is outside a <ConsensusFeed>, so it cannot follow ` +
          'the block past the state its event carried',
      );
    }
    return;
  }, [track, blockNumber]);

  // The stops the block's record actually contains, ascending. `at` is the whole
  // map the API holds, so this is the chain's sequence, not our polling's.
  const stops = useMemo(() => stopsIn(reading.at), [reading.at]);

  // Whether this is something happening now, decided from the FIRST reading —
  // the moment the answer matters. A row that arrives already final is a record
  // being read, and reading a record is not an event.
  const live = useRef<boolean | null>(null);
  if (live.current === null && reading.phase !== 'reading') {
    live.current = isCurrent(reading);
  }

  return { phase: reading.phase, stops, at: reading.at, live: live.current };
}

// ---------------------------------------------------------------------------
// What the record says
// ---------------------------------------------------------------------------

/** The stops present in an `at` map, ascending. */
function stopsIn(at: CommitTimes): number[] {
  const stops = new Set<number>();
  for (const state of Object.keys(at) as TimeKey[]) {
    const stop = STOP_OF_STATE[capitalise(state)];
    if (stop !== undefined) stops.add(stop);
  }
  return [...stops].sort((a, b) => a - b);
}

/** The epoch ms of the newest state in the record, or null if it has none. */
function newestAt(at: CommitTimes): number | null {
  let newest: number | null = null;
  for (const when of Object.values(at)) {
    if (typeof when === 'number' && (newest === null || when > newest)) newest = when;
  }
  return newest;
}

/**
 * Whether the block is something happening now: still moving, or final within
 * `LIVE_MS`.
 */
function isCurrent(reading: Reading): boolean {
  if (reading.phase !== 'live') return false;
  if (reading.state === null || !FINAL_CONSENSUS_STATES.includes(reading.state)) return true;
  const newest = newestAt(reading.at);
  return newest !== null && Date.now() - newest <= LIVE_MS;
}

/** Whether the chain reported this stop's state within `LIVE_MS` of now. */
function justHappened(at: CommitTimes, stop: number): boolean {
  const key = stateKey(at, stop);
  const when = key === null ? undefined : at[key];
  return when !== undefined && Date.now() - when <= LIVE_MS;
}

/** The `at` key a stop is recorded under, or null when the record lacks one. */
function stateKey(at: CommitTimes, stop: number): TimeKey | null {
  const preferred = TIME_OF_STOP[stop];
  if (preferred !== undefined && at[preferred] !== undefined) return preferred;
  // A block can skip `Voted`, and `Verified` is what follows `Finalized`.
  if (stop === FINAL_STOP && at.verified !== undefined) return 'verified';
  return null;
}

function capitalise(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/** `+262 ms`: how long this state took to arrive after `Proposed`, or null. */
function sinceProposed(at: CommitTimes, state: TimeKey): number | null {
  const landed = at[state];
  const start = at.proposed;
  return landed !== undefined && start !== undefined && landed >= start ? landed - start : null;
}

function tickHaptic(stop: number): void {
  const feedback =
    stop === 0
      ? Haptics.selectionAsync()
      : Haptics.impactAsync(
          stop === 1 ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium,
        );
  // A device with haptics switched off rejects here. A missed tick is not a
  // missed trade.
  void feedback.catch(() => undefined);
}

/**
 * What the ramp says while it is lit. It follows the stop being *shown*, not
 * the furthest one on record, so the words and the fill agree.
 */
function liveCaption(
  phase: Phase,
  stop: number | null,
  at: CommitTimes,
  live: boolean | null,
): string | null {
  if (phase === 'reorged') return 'reordered, resubmitting';
  if (phase === 'unreachable') return 'consensus unavailable';
  if (phase === 'beyond') return 'past the consensus window';
  if (phase !== 'live' || live !== true || stop === null) return null;
  if (stop === 0) return 'proposed';
  const key = stateKey(at, stop);
  if (key === null) return null;
  const elapsed = sinceProposed(at, key);
  return elapsed === null ? key : `${key} +${groupThousands(String(elapsed))} ms`;
}

/** What the fill is worth: a third per stop reached, nothing once it drains. */
function fillFraction(stop: number | null, drained: boolean): number {
  if (stop === null || drained) return 0;
  return (stop + 1) / STOPS;
}

/**
 * A stop's label colour. Purple only while the ramp is live and lit; `textDim`
 * once the reading is a record, `textFaint` for a stop the block never passed.
 */
function stopColor(index: number, stop: number | null, phase: Phase, drained: boolean): string {
  const reached = stop !== null && index <= stop;
  // A reorg takes the whole reading back: nothing on this ramp was about the
  // block the chain settled on.
  if (phase === 'reorged') return color.textFaint;
  if (reached && phase === 'live' && !drained) return color.ramp;
  if (reached && phase === 'live') return color.textDim;
  return color.textFaint;
}

// ---------------------------------------------------------------------------
// The ramp
// ---------------------------------------------------------------------------

export function ConsensusRamp({
  blockNumber,
  consensus,
}: {
  blockNumber: number;
  /** The event's own `consensus` block. What the ramp opens on (SEN-35). */
  consensus?: EventConsensus | null;
}) {
  const { phase, stops, at, live } = useConsensus(blockNumber, consensus);

  const [width, setWidth] = useState(0);
  /** The stop being shown. Walks up the record's own sequence, one beat apart. */
  const [stop, setStop] = useState<number | null>(null);
  /** Purple is done: drained after finality, or never lit because we were late. */
  const [drained, setDrained] = useState(false);

  const fill = useSharedValue(0);
  const stamp = useSharedValue(0);

  // A ramp that arrived after the fact settles at once: reading a record is not
  // an event, and twenty rows lighting up on screen load would say it was.
  useEffect(() => {
    if (live === false) setDrained(true);
  }, [live]);

  // `at` is read through a ref so a poll does not restart the walk in flight.
  const atRef = useRef(at);
  useEffect(() => {
    atRef.current = at;
  }, [at]);

  const stopsKey = stops.join(',');
  useEffect(() => {
    if (live === null) return;
    const list = stopsKey === '' ? [] : stopsKey.split(',').map(Number);
    if (list.length === 0) return;
    if (!live) {
      setStop(list[list.length - 1] ?? null);
      return;
    }
    const next = list.find((entry) => stop === null || entry > stop);
    if (next === undefined) return;
    const delay = stop === null ? 0 : FILL_MS;
    const timer = setTimeout(() => {
      setStop(next);
      if (justHappened(atRef.current, next)) tickHaptic(next);
    }, delay);
    return () => clearTimeout(timer);
  }, [stopsKey, stop, live]);

  // Purple sits full for a beat before it goes, so the last state is seen rather
  // than merely computed. Measured from the moment the fill arrives.
  useEffect(() => {
    if (phase !== 'live' || stop !== FINAL_STOP || !live) return;
    const hold = setTimeout(() => setDrained(true), FILL_MS + HOLD_MS);
    return () => clearTimeout(hold);
  }, [phase, stop, live]);

  const target = fillFraction(stop, drained);
  const leaving = drained || phase === 'reorged';
  useEffect(() => {
    fill.value = withTiming(target, {
      duration: leaving ? DRAIN_MS : FILL_MS,
      easing: leaving ? Easing.inOut(Easing.quad) : Easing.out(Easing.cubic),
    });
  }, [fill, target, leaving]);

  // The height stamps in as the purple leaves — and for a ramp that never lit,
  // because the stamp is the one thing it still knows.
  const settled = drained || phase === 'beyond' || phase === 'unreachable' || phase === 'reorged';
  useEffect(() => {
    stamp.value = withTiming(settled ? 1 : 0, { duration: DRAIN_MS });
  }, [stamp, settled]);

  const caption = liveCaption(phase, stop, at, live);
  const captionFade = useAnimatedStyle(() => ({ opacity: 1 - stamp.value }));
  const stampIn = useAnimatedStyle(() => ({
    opacity: stamp.value,
    transform: [{ translateX: (1 - stamp.value) * 4 }],
  }));
  const fillWidth = useDerivedWidth(fill, width);

  return (
    <View
      style={styles.ramp}
      accessible
      accessibilityLabel={accessibilityLabel(phase, stop, blockNumber)}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Canvas style={{ width, height: TRACK }}>
        <Rect x={0} y={0} width={width} height={TRACK} color={color.rule} />
        <Rect x={0} y={0} width={fillWidth} height={TRACK} color={color.ramp} />
      </Canvas>

      <View style={styles.stops}>
        {CONSENSUS_STOPS.map((label, index) => (
          <Text
            key={label}
            style={[styles.stop, { color: stopColor(index, stop, phase, drained) }]}
          >
            {label}
          </Text>
        ))}
      </View>

      <View style={styles.captionRow}>
        {caption !== null ? (
          <Animated.Text style={[styles.caption, captionFade]} numberOfLines={1}>
            {caption}
          </Animated.Text>
        ) : null}
        <Animated.Text
          style={[text.mono, text.num, caption === null && styles.stampPush, stampIn]}
          selectable
        >
          block {groupThousands(String(blockNumber))}
        </Animated.Text>
      </View>
    </View>
  );
}

/**
 * The fill's width in the canvas' own coordinates. A derived value rather than a
 * state update per frame: it stays on the UI thread next to the animation that
 * drives it, and Skia binds it by name like any other shared value.
 */
function useDerivedWidth(fill: { value: number }, width: number) {
  const widthValue = useSharedValue(width);
  useEffect(() => {
    widthValue.value = width;
  }, [widthValue, width]);
  return useDerivedValue(() => fill.value * widthValue.value);
}

function accessibilityLabel(phase: Phase, stop: number | null, blockNumber: number): string {
  const block = `block ${blockNumber}`;
  if (phase === 'beyond') return `${block}: past the window Sente tracks consensus for`;
  if (phase === 'unreachable') return `${block}: consensus unavailable`;
  if (phase === 'reorged') return `${block}: reordered, resubmitting`;
  if (stop === null) return `${block}: reading consensus`;
  return `${block}: consensus ${CONSENSUS_STOPS[stop] ?? stop}`;
}

const styles = StyleSheet.create({
  ramp: { marginTop: 14 },
  stops: { flexDirection: 'row', marginTop: 5 },
  stop: {
    flex: 1,
    fontFamily: font.mono,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.6,
    textAlign: 'center',
  },
  captionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  caption: {
    flexShrink: 1,
    fontFamily: font.mono,
    fontSize: 10.5,
    lineHeight: 16,
    letterSpacing: 0.4,
    color: color.textFaint,
  },
  stampPush: { marginLeft: 'auto' },
});
