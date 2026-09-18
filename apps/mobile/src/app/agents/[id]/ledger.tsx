/**
 * The Agent Ledger (SEN-23) — Sente's identity screen.
 *
 * A live trail of what one agent did: every thesis it wrote before executing,
 * every trade (and every order that did not land), every refusal, and the
 * verdict when a position closes. Each entry builds itself in over ~600ms, so
 * the ledger reads as a stream arriving rather than a list appearing.
 *
 * Two rules hold this screen together, and both are deliberate:
 *
 * - Numbers are Inter with tabular figures. Mono is reserved for chain facts —
 *   the transaction hash, the block height, the agent id — so mono means "this
 *   came from the chain" and nothing else.
 * - The ground is achromatic, so the consensus ramp's purple (SEN-24) is the
 *   only colour on the screen and reads as an event: it is there while a block
 *   is acquiring consensus and gone once it has it. The ramp also owns the
 *   block height, which is why a trade row prints it once, under the ramp,
 *   rather than beside the hash.
 *
 * An enclave refusal is rendered as a filled tag, not as an error: an agent
 * refused by a policy it cannot widen is the product working.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { Agent } from '@/agents/api';
import {
  clockTime,
  demoLedger,
  directionLabel,
  heldLabel,
  refusalLayerLabel,
  shortHash,
  signedPnl,
  venueLabel,
  type LedgerEntry,
  type RefusalEntry,
  type ThesisEntry,
  type TradeEntry,
  type VerdictEntry,
} from '@/agents/ledger';
import { useAgentEvents } from '@/agents/useAgentEvents';
import { useSession } from '@/session';
import { ConsensusFeed, ConsensusRamp } from '@/ui/ConsensusRamp';
import { Button, Loading, Notice, Screen, Tag, TopBar } from '@/ui/kit';
import { color, text } from '@/ui/theme';

/** The plan's number: long enough to read as construction, short enough not to wait. */
const BUILD_MS = 600;
/** Rows arriving together stagger by this, so the first screen assembles downward. */
const STAGGER_MS = 45;
const STAGGER_ROWS = 8;
/**
 * Only the newest rows animate their build. A ledger tails forward for as long
 * as the screen is open, so without a bound every entry ever seen would hold a
 * live animated node; rows below this render static, and nothing is lost by it
 * once they are off-screen anyway.
 */
const BUILD_ROWS = 24;

const ENTRY_LABEL: Record<LedgerEntry['kind'], string> = {
  thesis: 'Thesis',
  trade: 'Trade',
  refusal: 'Refusal',
  verdict: 'Verdict',
};

export default function LedgerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents: api } = useSession();
  const { entries, loaded, error } = useAgentEvents(id);
  const [agent, setAgent] = useState<Agent | null>(null);
  /** The agent this one was forked from, named — when it is readable (SEN-28). */
  const [forkedFromName, setForkedFromName] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !id) return;
    let cancelled = false;
    api.get(id).then(
      (fresh) => {
        if (!cancelled) setAgent(fresh);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  /**
   * Lineage, not a link: the source may belong to someone else, and a ledger is
   * readable for your own agents. A source we cannot read is named as just
   * that — the id is on the agent's own screen.
   */
  const forkedFrom = agent?.forkedFrom;
  useEffect(() => {
    if (!api || !forkedFrom) return;
    let cancelled = false;
    api.get(forkedFrom).then(
      (source) => {
        if (!cancelled) setForkedFromName(source.name);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, forkedFrom]);

  // The hook pages oldest-first; a ledger reads newest-first, the way a fill
  // report does. Reversing here keeps the mapping order-stable for tests.
  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  const sample = useMemo(() => demoLedger(), []);

  const empty = loaded && entries.length === 0;
  const rows = empty ? sample : ordered;

  const back = () => (router.canGoBack() ? router.back() : router.replace('/agents'));

  return (
    <Screen>
      <TopBar back={{ label: agent?.name ?? 'Agent', onPress: back }} />
      <Text style={text.display}>Ledger</Text>
      <Text style={[text.dim, styles.meta]}>
        {agent ? `${agent.name} · ` : ''}
        <Text style={text.mono}>{id ?? '—'}</Text>
      </Text>
      {forkedFrom !== undefined ? (
        <Text style={[text.caption, styles.forkLine]}>
          Forked from {forkedFromName ?? 'another agent'}
        </Text>
      ) : null}

      <View style={styles.status}>
        <View style={[styles.dot, error !== null && styles.dotStale]} />
        <Text style={text.caption}>
          {error !== null
            ? `Not updating — ${error}`
            : loaded
              ? 'Live · tailing this agent’s trail'
              : 'Reading the agent’s trail…'}
        </Text>
      </View>

      {/* The honest copy-trade (SEN-28): this agent's strategy under the
          forker's own mandate, and never its wallet. */}
      {id !== undefined ? (
        <Button
          label="Fork this strategy"
          onPress={() =>
            router.push({
              pathname: '/agents/new',
              params: { fork: id, ...(agent?.name ? { from: agent.name } : {}) },
            })
          }
          style={styles.forkAction}
        />
      ) : null}

      {empty ? (
        <Notice
          title="No events yet"
          detail="This agent hasn’t recorded anything. What follows is a sample ledger, so you can see its shape — none of it is this agent’s history."
        />
      ) : null}

      {!loaded ? (
        <Loading />
      ) : (
        // One consensus poller for the whole screen (SEN-35). Every ramp below
        // opens on the state its own event carried and registers here; only the
        // blocks that have not finalized are ever requested, so a screenful of
        // settled trades asks the API for nothing.
        <ConsensusFeed>
          <View style={styles.list}>
            {rows.map((entry, index) => (
              <Entry
                key={`${empty ? 'sample' : 'live'}-${entry.seq}`}
                entry={entry}
                delay={Math.min(index, STAGGER_ROWS) * STAGGER_MS}
                animate={index < BUILD_ROWS}
              />
            ))}
          </View>
        </ConsensusFeed>
      )}
    </Screen>
  );
}

/**
 * One entry, building in. The rule above it draws left-to-right and the row
 * fades up behind it: the hairline is the structure, so it is the structure
 * that arrives first.
 */
function Building({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const build = useSharedValue(0);
  // Read once. The delay only means anything at mount — a row that merely
  // shifted down because a newer one arrived must not replay.
  const applyAt = useRef(delay);

  useEffect(() => {
    build.value = withDelay(
      applyAt.current,
      withTiming(1, { duration: BUILD_MS, easing: Easing.out(Easing.cubic) }),
    );
  }, [build]);

  const rule = useAnimatedStyle(() => ({ transform: [{ scaleX: build.value }] }));
  const content = useAnimatedStyle(() => ({
    opacity: build.value,
    transform: [{ translateY: (1 - build.value) * 6 }],
  }));

  return (
    <View>
      <Animated.View style={[styles.entryRule, rule]} />
      <Animated.View style={content}>{children}</Animated.View>
    </View>
  );
}

function Entry({ entry, delay, animate }: { entry: LedgerEntry; delay: number; animate: boolean }) {
  const row = (
    <View style={styles.entry}>
      <View style={styles.entryHead}>
        <Text style={text.label}>{ENTRY_LABEL[entry.kind]}</Text>
        <Text style={[text.caption, text.num]}>{clockTime(entry.at)}</Text>
      </View>
      {bodyFor(entry)}
    </View>
  );

  if (!animate) {
    return (
      <View>
        <View style={styles.entryRule} />
        {row}
      </View>
    );
  }
  return <Building delay={delay}>{row}</Building>;
}

function bodyFor(entry: LedgerEntry): ReactNode {
  switch (entry.kind) {
    case 'thesis':
      return <ThesisBody entry={entry} />;
    case 'trade':
      return <TradeBody entry={entry} />;
    case 'refusal':
      return <RefusalBody entry={entry} />;
    case 'verdict':
      return <VerdictBody entry={entry} />;
  }
}

/** The agent's own words, written before execution. */
function ThesisBody({ entry }: { entry: ThesisEntry }) {
  return (
    <>
      <Text style={[text.body, styles.quote]}>{entry.thesis || '—'}</Text>
      <Text style={[text.caption, text.num, styles.after]}>
        {directionLabel(entry.direction)} · {entry.market}
      </Text>
      {entry.invalidation ? (
        <>
          <Text style={[text.label, styles.after]}>Would be wrong if</Text>
          <Text style={[text.dim, styles.tight]}>{entry.invalidation}</Text>
        </>
      ) : null}
    </>
  );
}

/** A fill report, not a card: one dense line, then the chain facts beneath it. */
function TradeBody({ entry }: { entry: TradeEntry }) {
  const line = [
    directionLabel(entry.direction),
    entry.market,
    entry.size,
    entry.price !== null ? `@ ${entry.price}` : null,
    entry.leverage !== null ? `${entry.leverage}×` : null,
    entry.venue !== null ? venueLabel(entry.venue) : null,
  ]
    .filter((part): part is string => part !== null)
    .join('  ');

  const onChain = entry.txHash !== null || entry.blockNumber !== null;

  return (
    <>
      <Text style={[text.strong, text.num, styles.trade]}>{line}</Text>
      {onChain ? (
        <View style={styles.chain}>
          {entry.txHash !== null ? (
            <Text style={text.mono} selectable>
              {shortHash(entry.txHash)}
            </Text>
          ) : null}
        </View>
      ) : null}
      {!entry.filled ? (
        <Text style={[text.caption, text.danger, styles.after]}>
          Did not fill{entry.status !== null ? ` · ${entry.status}` : ''}
        </Text>
      ) : null}
      <Ramp entry={entry} />
    </>
  );
}

/**
 * Any row that landed in a block gets the ramp, and the ramp owns the height:
 * it is what the ramp is about, and it prints it in the same mono a chain fact
 * gets anywhere else. A close settles on chain like a trade does, so it draws
 * one too (SEN-35); SEN-22's own verdict is a judgement rather than a
 * transaction and has no block to draw.
 */
function Ramp({ entry }: { entry: TradeEntry | VerdictEntry }) {
  if (entry.blockNumber === null) return null;
  return <ConsensusRamp blockNumber={entry.blockNumber} consensus={entry.consensus} />;
}

/** The layer that refused, plainly. Pride, not an error. */
function RefusalBody({ entry }: { entry: RefusalEntry }) {
  const enclave = entry.layer === 'enclave';
  return (
    <>
      <View style={styles.refusalHead}>
        <Tag label={refusalLayerLabel(entry.layer)} filled={enclave} />
        <Text style={[text.mono, text.num]} selectable>
          {entry.code}
        </Text>
      </View>
      <Text style={[text.body, styles.tight]}>{entry.message || '—'}</Text>
      {enclave ? (
        <Text style={[text.caption, styles.after]}>
          The enclave refused a call this agent’s mandate does not allow, and nothing was signed. An
          agent cannot widen its own authority — this is that guarantee, doing its job.
        </Text>
      ) : null}
    </>
  );
}

/** What the position actually did. */
function VerdictBody({ entry }: { entry: VerdictEntry }) {
  return (
    <>
      <View style={styles.verdict}>
        <Text style={[text.title, text.num]}>{signedPnl(entry.pnl)}</Text>
        <Text style={text.dim}>{heldLabel(entry.held)}</Text>
      </View>
      <Text style={[text.caption, styles.after]}>
        {entry.pnl === null
          ? 'No realised PnL on this event'
          : `Realised PnL${entry.market !== null ? ` · ${entry.market}` : ''}, as the venue reported it`}
      </Text>
      <Ramp entry={entry} />
    </>
  );
}

const styles = StyleSheet.create({
  meta: { marginTop: 4 },
  forkLine: { marginTop: 6 },
  forkAction: { marginTop: 16, minHeight: 0, paddingVertical: 12 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.textDim },
  dotStale: { backgroundColor: color.danger },
  list: { marginTop: 2 },
  entryRule: { height: 1, backgroundColor: color.rule, transformOrigin: 'left' },
  entry: { paddingTop: 12, paddingBottom: 20 },
  entryHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  quote: {
    color: color.textDim,
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: color.ruleStrong,
  },
  trade: { marginTop: 2 },
  chain: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  refusalHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  verdict: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
  },
  after: { marginTop: 10 },
  tight: { marginTop: 4 },
});
