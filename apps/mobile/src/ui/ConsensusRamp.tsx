/**
 * The consensus ramp (SEN-24): the hairline under a Ledger trade that fills in
 * Monad purple as the block the order landed in acquires consensus.
 *
 * A Monad block goes `Proposed` -> `Voted` -> `Finalized`, and SEN-21 exposes
 * exactly that per height at `GET /chain/blocks/:n/consensus`, with the epoch ms
 * at which each state was first seen. This draws those states as progress — one
 * Skia hairline, a third per stop — and only ever animates between states the
 * block's own record contains. A block that skipped `Voted` (Monad does) jumps a
 * third and leaves `VOTED` dark, because that is what the network did.
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
 * A reorg — the same height now holding a different `blockId` — plays the fill
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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { CONSENSUS_STOPS } from '@/agents/ledger';
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
 * data: fine enough to catch each state, coarse enough not to hammer.
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

/** The states Monad's commit process ends at. Both mean "the block is final". */
const FINAL_STATES = new Set(['Finalized', 'Verified']);

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

/** Epoch ms per state, keyed as the API spells them. */
type CommitTimes = Partial<Record<'proposed' | 'voted' | 'finalized' | 'verified', number>>;

type TimeKey = keyof CommitTimes;

/** The `at` key behind each stop. `finalized` falls back to `verified`. */
const TIME_OF_STOP: Record<number, TimeKey> = {
  0: 'proposed',
  1: 'voted',
  2: 'finalized',
};

/** One block's consensus record, as `GET /chain/blocks/:n/consensus` returns it. */
type ConsensusRecord = {
  readonly blockNumber: number;
  /** Monad's id for the block. Stable across its states, so a reorg breaks it. */
  readonly blockId: string;
  /** `Proposed` | `Voted` | `Finalized` | `Verified`. */
  readonly state: string;
  readonly at: CommitTimes;
};

type Phase =
  /** The first read is in flight. */
  | 'reading'
  /** The block's record is in hand, and may still move. */
  | 'live'
  /** The height now holds a different block. */
  | 'reorged'
  /** Older than the window SEN-21 keeps. Not an error. */
  | 'beyond'
  /** The API is not answering. */
  | 'unreachable';

// ---------------------------------------------------------------------------
// Reading consensus
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

/**
 * Follow one block's consensus until it is final, or until we learn why we
 * cannot. It reports the record and whether the record is current; it never
 * invents a state the block has not been in.
 */
function useConsensus(blockNumber: number, userId: string | null) {
  const [phase, setPhase] = useState<Phase>('reading');
  const [record, setRecord] = useState<ConsensusRecord | null>(null);
  /** `null` until the first read decides it. See `isCurrent`. */
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    if (userId === null) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    /** The block this height held when we started: what a reorg changes. */
    let blockId: string | undefined;
    let decided = false;
    const fastUntil = Date.now() + SLOW_AFTER_MS;

    const poll = async (): Promise<void> => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const read = await readConsensus(blockNumber, userId, controller.signal);
        if (stopped) return;
        failures = 0;

        if (read === 'beyond') {
          setPhase('beyond');
          return;
        }

        if (blockId === undefined) {
          blockId = read.blockId;
        } else if (read.blockId !== blockId) {
          setPhase('reorged');
          return;
        }

        setRecord(read);
        setPhase('live');
        if (!decided) {
          decided = true;
          setLive(isCurrent(read));
        }

        // Terminal, or still moving: keep reading while it moves. A block that
        // is taking longer than it should gets asked less often, not never.
        if (!FINAL_STATES.has(read.state)) {
          timer = setTimeout(() => poll(), Date.now() < fastUntil ? POLL_MS : SLOW_POLL_MS);
        }
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= MAX_FAILURES) {
          setPhase('unreachable');
          return;
        }
        timer = setTimeout(() => poll(), POLL_MS);
      } finally {
        clearTimeout(abort);
      }
    };

    void poll();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [blockNumber, userId]);

  // The stops the block's record actually contains, ascending. `at` is the whole
  // map the service holds, so this is the chain's sequence, not our polling's.
  const stops = useMemo(() => stopsIn(record?.at ?? {}), [record]);

  return { phase, stops, at: record?.at ?? EMPTY_TIMES, live };
}

const EMPTY_TIMES: CommitTimes = {};

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
 * `LIVE_MS`. Decided once, on the first read, because that is the moment the
 * answer matters — the ramp either caught the event or it is reading a record.
 */
function isCurrent(record: ConsensusRecord): boolean {
  if (!FINAL_STATES.has(record.state)) return true;
  const newest = newestAt(record.at);
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

export function ConsensusRamp({ blockNumber }: { blockNumber: number }) {
  // The placeholder identity the API's guard wants, from the one place the app
  // keeps it. Consensus itself is public chain data; the route is only behind
  // the same guard as every other Sente route.
  const { auth } = useSession();
  const { phase, stops, at, live } = useConsensus(blockNumber, auth.address);

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
          <Text key={label} style={[styles.stop, { color: stopColor(index, stop, phase, drained) }]}>
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
          style={[
            text.mono,
            text.num,
            caption === null && styles.stampPush,
            stampIn,
          ]}
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
