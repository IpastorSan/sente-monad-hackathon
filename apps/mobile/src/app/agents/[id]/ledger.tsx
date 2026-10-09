/**
 * The Agent Ledger (SEN-23) — Sente's identity screen, in Goban (SEN-60).
 *
 * A live trail of what one agent did: every thesis it wrote before executing,
 * every trade (and every order that did not land), every refusal, and the
 * verdict when a position closes — plus the deposits that funded it, the one
 * row nothing the agent did produced (SEN-30/SEN-50).
 *
 * The ledger is a line on the board. Each entry is placed on the spine as a
 * stone, and the stone's shape says what kind of entry it is before a word is
 * read (`Stone` in `ui/goban.tsx`; the choice is `stoneFor` in
 * `agents/ledgerView.ts`). Newest first, because it is a live feed. Each entry
 * is placed over ~600ms — it rises and settles — so the ledger reads as a
 * stream arriving rather than a list appearing.
 *
 * Two rules hold this screen together, and both are deliberate:
 *
 * - Mono is reserved for chain facts — the transaction hash, the block height,
 *   an address, a policy code — so mono means "this came from the chain". The
 *   one exception is the time in each entry's margin, set in the same small
 *   mono the design gives it so the column reads as a margin, not as prose.
 *   Figures are Geist with tabular numbers; the agent's own words are
 *   `text.voice` — mono too, but at reading size and purple, so a thesis never
 *   reads like a hash or a system message.
 * - Purple is an event. A trade stone is purple because it is a move, and the
 *   consensus ramp (SEN-24) is purple only while its block is acquiring
 *   consensus — it drains to neutral once final, so settled rows go quiet and
 *   the one happening now is the one that lights up. The ramp also owns the
 *   block height, which is why a row prints it once, under the ramp, rather
 *   than beside the hash.
 *
 * An enclave refusal is a lilac `held` pill, not an error: an agent refused by
 * a policy it cannot widen is the product working. Nothing here is berry except
 * money that was lost.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { Agent } from '@/agents/api';
import {
  demoLedger,
  heldLabel,
  shortHash,
  type AccountEntry,
  type DepositEntry,
  type LedgerEntry,
  type RefusalEntry,
  type ThesisEntry,
  type TradeEntry,
  type VerdictEntry,
} from '@/agents/ledger';
import {
  accountOpened,
  countLabel,
  depositHeadline,
  depositSource,
  entryTime,
  heldBy,
  inFilter,
  LEDGER_FILTERS,
  ledgerStats,
  stoneFor,
  thesisKind,
  tradeDetail,
  tradeHeadline,
  verdictHeadline,
  type LedgerFilter,
} from '@/agents/ledgerView';
import { useAgentEvents } from '@/agents/useAgentEvents';
import { useSession } from '@/session';
import { ConsensusFeed, ConsensusRamp } from '@/ui/ConsensusRamp';
import { Pill, Stat, Stone } from '@/ui/goban';
import { Button, Chip, Chips, Loading, Notice, Screen, TopBar } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

/** The plan's number: long enough to read as construction, short enough not to wait. */
const PLACE_MS = 600;
/** Entries arriving together stagger by this, so the first screen assembles downward. */
const STAGGER_MS = 100;
const STAGGER_ROWS = 6;
/**
 * Only the newest rows animate their placing. A ledger tails forward for as
 * long as the screen is open, so without a bound every entry ever seen would
 * hold a live animated node; rows below this render static, and nothing is lost
 * by it once they are off-screen anyway.
 */
const BUILD_ROWS = 24;
/** `--ease-place` in `docs/design/sente.css`: settles with a slight overshoot. */
const EASE_PLACE = Easing.bezier(0.2, 0.9, 0.25, 1.15);
/** The stone's size, and so the spine's offset: the line runs through its centre. */
const STONE = 14;

export default function LedgerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents: api } = useSession();
  const { entries, loaded, error } = useAgentEvents(id);
  const [agent, setAgent] = useState<Agent | null>(null);
  /** The agent this one was forked from, named — when it is readable (SEN-28). */
  const [forkedFromName, setForkedFromName] = useState<string | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>('all');

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
  const sample = useMemo(() => demoLedger().reverse(), []);
  // The figures are this agent's own, never the sample's: an agent that has
  // done nothing shows zeros over a sample labelled as one.
  const stats = useMemo(() => ledgerStats(entries), [entries]);

  const empty = loaded && entries.length === 0;
  const rows = (empty ? sample : ordered).filter((entry) => inFilter(entry, filter));

  const back = () => (router.canGoBack() ? router.back() : router.replace('/agents'));

  /**
   * The honest copy-trade (SEN-28): this agent's strategy under the forker's
   * own mandate, and never its wallet. The next screen is the mandate, so
   * nothing is inherited silently. It is the Ledger's primary action because
   * the Ledger is where a strategy earns it (the Board sends you here).
   */
  const fork =
    id !== undefined ? (
      <Button
        kind="primary"
        label="Fork this strategy"
        onPress={() =>
          router.push({
            pathname: '/agents/new',
            params: { fork: id, ...(agent?.name ? { from: agent.name } : {}) },
          })
        }
      />
    ) : undefined;

  return (
    <Screen footer={fork}>
      <TopBar
        back={{ label: agent?.name ?? 'Agent', onPress: back }}
        right={
          !loaded ? null : error !== null ? (
            <Pill tone="idle" label="Paused" />
          ) : (
            <Pill tone="live" label="Live" />
          )
        }
      />
      <Text style={text.display}>Ledger</Text>
      {forkedFrom !== undefined ? (
        <Text style={[text.caption, styles.under]}>
          Forked from {forkedFromName ?? 'another agent'}
        </Text>
      ) : null}
      {error !== null ? (
        <Text style={[text.caption, styles.under]}>Not updating — {error}</Text>
      ) : null}

      <View style={styles.stats}>
        <Stat label="Trades" value={countLabel(stats.trades)} />
        <Stat label="Held" value={countLabel(stats.held)} />
        <Stat label="P&L" value={stats.pnl ?? '—'} tone={stats.tone ?? undefined} />
      </View>

      {empty ? (
        <Notice
          title="No events yet"
          detail="This agent hasn’t recorded anything. What follows is a sample ledger, so you can see its shape — none of it is this agent’s history."
        />
      ) : null}

      <Chips>
        {LEDGER_FILTERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={filter === option.value}
            onPress={() => setFilter(option.value)}
          />
        ))}
      </Chips>

      {!loaded ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Text style={[text.dim, styles.nothing]}>Nothing of this kind yet.</Text>
      ) : (
        // One consensus poller for the whole screen (SEN-35). Every ramp below
        // opens on the state its own event carried and registers here; only the
        // blocks that have not finalized are ever requested, so a screenful of
        // settled trades asks the API for nothing.
        <ConsensusFeed>
          <View style={styles.spine}>
            <View style={styles.line} />
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
 * One entry, placed: it rises 6px and settles with a slight overshoot, the
 * design's "place" motion. Reduced motion places it at once.
 */
function Placed({ children, delay }: { children: ReactNode; delay: number }) {
  const place = useSharedValue(0);
  // Read once. The delay only means anything at mount — a row that merely
  // shifted down because a newer one arrived must not replay.
  const applyAt = useRef(delay);

  useEffect(() => {
    place.value = withDelay(
      applyAt.current,
      withTiming(1, { duration: PLACE_MS, easing: EASE_PLACE }),
    );
  }, [place]);

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, place.value),
    transform: [{ translateY: (1 - place.value) * 6 }, { scale: 0.98 + place.value * 0.02 }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}

function Entry({ entry, delay, animate }: { entry: LedgerEntry; delay: number; animate: boolean }) {
  const reduced = useReducedMotion();
  const move = (
    <View style={styles.move}>
      {/* The ground behind the stone hides the spine, so a hollow stone reads
          as a ring on the line rather than a line through a ring. */}
      <View style={styles.stone}>
        <Stone kind={stoneFor(entry)} size={STONE} />
      </View>
      <View style={styles.body}>{bodyFor(entry)}</View>
    </View>
  );
  if (!animate || reduced) return move;
  return <Placed delay={delay}>{move}</Placed>;
}

/** The first line of every entry: what it is on the left, when on the right. */
function Meta({ at, children }: { at: number; children: ReactNode }) {
  return (
    <View style={styles.meta}>
      <View style={styles.metaHead}>{children}</View>
      <Text style={styles.time}>{entryTime(at)}</Text>
    </View>
  );
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
    case 'deposit':
      return <DepositBody entry={entry} />;
    case 'account':
      return <AccountBody entry={entry} />;
  }
}

/** The agent's own words, written before execution — in its own voice. */
function ThesisBody({ entry }: { entry: ThesisEntry }) {
  return (
    <>
      <Meta at={entry.at}>
        <Text style={styles.kind}>{thesisKind(entry)}</Text>
      </Meta>
      <Text style={[text.voice, styles.tight]}>{entry.thesis || '—'}</Text>
      {entry.invalidation ? (
        <Text style={[text.caption, styles.tight]}>Wrong if: {entry.invalidation}</Text>
      ) : null}
    </>
  );
}

/**
 * A fill report: what moved, at what price, where — then the chain facts. An
 * order that did not land says so in its headline rather than vanishing,
 * because an agent whose orders silently disappear is not one you can audit.
 */
function TradeBody({ entry }: { entry: TradeEntry }) {
  const detail = tradeDetail(entry);
  return (
    <>
      <Meta at={entry.at}>
        <Text style={[text.strong, text.num]}>{tradeHeadline(entry)}</Text>
      </Meta>
      {detail !== '' ? <Text style={[text.dim, text.num]}>{detail}</Text> : null}
      <Hash hash={entry.txHash} />
      <Ramp entry={entry} />
    </>
  );
}

/**
 * Any row that landed in a block gets the ramp, and the ramp owns the height:
 * it is what the ramp is about, and it prints it in the same mono a chain fact
 * gets anywhere else. A close settles on chain like a trade does, so it draws
 * one too (SEN-35), and so does a deposit (SEN-50) — the API attaches consensus
 * to any event that names a block, so this needed nothing on the server.
 * SEN-22's own verdict carries the block of the fill that settled it, so it
 * draws one when it has it.
 */
function Ramp({ entry }: { entry: TradeEntry | VerdictEntry | DepositEntry }) {
  if (entry.blockNumber === null) return null;
  return <ConsensusRamp blockNumber={entry.blockNumber} consensus={entry.consensus} />;
}

/** A transaction hash, short and selectable. Mono: it is the chain's. */
function Hash({ hash }: { hash: string | null }) {
  if (hash === null) return null;
  return (
    <Text style={[text.mono, styles.tight]} selectable>
      {shortHash(hash)}
    </Text>
  );
}

/**
 * Funds arriving — the one row the agent did not cause (SEN-30). It names the
 * sender instead of a venue, and it draws the ramp because a transfer lands in a
 * block exactly like a trade does.
 */
function DepositBody({ entry }: { entry: DepositEntry }) {
  const source = depositSource(entry);
  return (
    <>
      <Meta at={entry.at}>
        <Text style={[text.strong, text.num]}>{depositHeadline(entry)}</Text>
      </Meta>
      {/* The sender is the fact this row adds over a balance going up, so it is
          the line under the figure — in mono, because it is the chain's. */}
      {source !== null ? (
        <Text style={text.mono} selectable>
          {source}
        </Text>
      ) : (
        <Text style={text.caption}>Arrived in this agent’s wallet</Text>
      )}
      <Hash hash={entry.txHash} />
      <Ramp entry={entry} />
    </>
  );
}

/** Sente opening the agent's venue account (SEN-187), or why it has not yet. */
function AccountBody({ entry }: { entry: AccountEntry }) {
  return (
    <>
      <Meta at={entry.at}>
        <Text style={accountOpened(entry) ? text.strong : [text.strong, text.dim]}>
          {accountOpened(entry) ? entry.message : 'Perps not open yet'}
        </Text>
      </Meta>
      {accountOpened(entry) ? null : (
        <Text style={[text.body, styles.tight]}>{entry.message || '—'}</Text>
      )}
      <Hash hash={entry.txHash} />
    </>
  );
}

/** The layer that held the line, plainly. Pride, not an error. */
function RefusalBody({ entry }: { entry: RefusalEntry }) {
  return (
    <>
      <Meta at={entry.at}>
        <Pill tone="held" label={heldBy(entry.layer)} />
      </Meta>
      <Text style={[text.body, styles.tight]}>{entry.message || '—'}</Text>
      <Text style={[text.caption, styles.tight]}>
        {entry.layer === 'enclave'
          ? 'Nothing was signed. An agent can’t widen its own authority — this is that guarantee, doing its job. '
          : 'Sente checked it against the mandate before sending, and didn’t send it. '}
        <Text style={text.mono}>{entry.code}</Text>
      </Text>
    </>
  );
}

/** What the position actually did: the figure in mint or berry, then the chain's say. */
function VerdictBody({ entry }: { entry: VerdictEntry }) {
  const { lead, pnl, tone } = verdictHeadline(entry);
  return (
    <>
      <Meta at={entry.at}>
        <Text style={[text.strong, text.num]}>
          {lead}
          {pnl !== null ? (
            <Text style={tone === 'up' ? text.up : tone === 'down' ? text.down : null}>
              {` ${pnl}`}
            </Text>
          ) : null}
        </Text>
      </Meta>
      {/* A close reports the number, not the judgement; SEN-22's verdict says
          whether the thesis held. */}
      {entry.held !== null ? <Text style={text.dim}>{heldLabel(entry.held)}</Text> : null}
      {entry.notes.map((note) => (
        <Text key={note} style={[text.caption, styles.tight]}>
          {note}
        </Text>
      ))}
      <Hash hash={entry.txHash} />
      <Ramp entry={entry} />
    </>
  );
}

const styles = StyleSheet.create({
  under: { marginTop: 6 },
  stats: { flexDirection: 'row', gap: 8, marginTop: 14 },
  nothing: { marginTop: 20 },
  spine: { marginTop: 22 },
  /** The board line the stones sit on: through their centres, stone to stone. */
  line: {
    position: 'absolute',
    left: STONE / 2 - 0.5,
    top: 8,
    bottom: 8,
    width: 1,
    backgroundColor: color.lineStrong,
  },
  move: { flexDirection: 'row', gap: 14, paddingBottom: 22 },
  stone: {
    marginTop: 4,
    width: STONE,
    height: STONE,
    borderRadius: STONE / 2,
    backgroundColor: color.ink,
  },
  body: { flex: 1, gap: 4 },
  meta: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 22,
  },
  metaHead: { flexShrink: 1 },
  kind: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 22,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  time: { fontFamily: font.chain, fontSize: 11, lineHeight: 22, color: color.textFaint },
  tight: { marginTop: 2 },
});
