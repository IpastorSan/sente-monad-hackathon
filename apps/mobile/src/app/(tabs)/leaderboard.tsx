/**
 * The Board (SEN-26), a tab since SEN-55 and in Goban since SEN-60.
 *
 * A board, not a scoreboard: every rate is printed with the sample it came
 * from ("won 7 of 10"), and the agents that have not traded enough to be
 * ordered are shown under their own heading instead of being ranked against
 * noise. How it is ranked is one dim line under the title; the formula that
 * produced the numbers is still printed verbatim, in the fine print under the
 * table, rather than paraphrased or hidden in a tooltip. Tap a row for that
 * agent's Ledger — the numbers here are only useful if you can audit them, and
 * the Ledger is where "Fork this strategy" is the primary action.
 *
 * Three states this screen refuses to blur together:
 *
 * - **unconfigured / unreachable**: no numbers exist. It says so, in the
 *   indexer's own words from `source.message`, and shows nothing else.
 * - **nothing ranked yet**: numbers exist, none of them big enough to order.
 * - **ranked**: the table.
 *
 * No time-window control: `GET /leaderboard` has no window, and a control that
 * changed nothing would be lying about what the numbers cover.
 *
 * Colour is for outcomes and for #1: ROI in mint or berry, the leader's numeral
 * in `purpleHi`. Mono is left for chain facts — the agent's address — and a
 * rank is a number, not an address. The user's own agents are marked "· yours"
 * so they can find themselves at a glance.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeAgentsError, type Leaderboard, type LeaderboardRow } from '@/agents/api';
import {
  rankingLine,
  rankNumeral,
  roiLabel,
  settledLabel,
  tooFewLabel,
  wonLabel,
} from '@/agents/leaderboard';
import { useSession } from '@/session';
import { shortAddress } from '@/ui/format';
import { Sigil } from '@/ui/goban';
import { Button, Loading, Notice, Screen, Section } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

type State =
  | { kind: 'loading' }
  | { kind: 'loaded'; board: Leaderboard }
  | { kind: 'failed'; title: string; detail: string };

/** Nothing owned is the answer until `GET /agents` says otherwise. */
const NONE: ReadonlySet<string> = new Set();

export default function LeaderboardScreen() {
  const router = useRouter();
  const { agents: api } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  /**
   * The ids of the user's own agents. The board carries each agent's wallet,
   * not its owner's, so the only honest "yours" is the id against the user's
   * own list. A failed list marks nothing rather than failing the board.
   */
  const [owned, setOwned] = useState<ReadonlySet<string>>(NONE);

  const load = useCallback(async () => {
    if (!api) return;
    void api.list().then(
      (agents) => setOwned(new Set(agents.map((agent) => agent.id))),
      () => undefined,
    );
    try {
      setState({ kind: 'loaded', board: await api.leaderboard() });
    } catch (error) {
      setState({ kind: 'failed', ...describeAgentsError(error) });
    }
  }, [api]);

  // Refetched whenever the screen comes back into view: the indexer is read
  // live on every request, so this is never a stale page.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const open = useCallback(
    (row: LeaderboardRow) =>
      router.push({ pathname: '/agents/[id]/ledger', params: { id: row.agentId } }),
    [router],
  );

  const board = state.kind === 'loaded' ? state.board : null;

  return (
    <Screen tabbed refreshing={refreshing} onRefresh={api ? () => void refresh() : undefined}>
      <Text style={[text.display, styles.title]}>Board</Text>
      {board !== null && board.source.kind === 'ok' ? (
        <Text style={[text.dim, styles.intro]}>{rankingLine(board.minTrades)}</Text>
      ) : null}

      {/* The tab layout redirects a signed-out user, so a missing client is the
          session still arriving, not a state to explain. */}
      {!api || state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'failed' ? (
        <>
          <Notice tone="error" title={state.title} detail={state.detail} />
          <Button label="Try again" onPress={() => void load()} style={styles.cta} />
        </>
      ) : state.board.source.kind !== 'ok' ? (
        <Notice
          tone={state.board.source.kind === 'unconfigured' ? 'info' : 'error'}
          title={
            state.board.source.kind === 'unconfigured'
              ? 'No indexer configured'
              : 'Indexer unavailable'
          }
          detail={state.board.source.message}
        />
      ) : (
        <>
          {state.board.ranked.length > 0 ? (
            <View style={styles.list}>
              {state.board.ranked.map((row) => (
                <Row key={row.agentId} row={row} yours={owned.has(row.agentId)} onPress={open} />
              ))}
            </View>
          ) : (
            <Notice
              title="Nothing ranked yet"
              detail={`No agent has ${state.board.minTrades} settled trades on the indexer yet. A win rate over two trades is not a result, so nothing is ordered until then.`}
            />
          )}

          {state.board.tooFewTrades.length > 0 ? (
            <Section label="Too few trades to rank">
              {state.board.tooFewTrades.map((row) => (
                <Row
                  key={row.agentId}
                  row={row}
                  yours={owned.has(row.agentId)}
                  minTrades={state.board.minTrades}
                  onPress={open}
                />
              ))}
            </Section>
          ) : null}

          {state.board.formula !== '' || state.board.notes.length > 0 ? (
            <Section label="The fine print">
              {state.board.formula !== '' ? (
                <Text style={[text.caption, styles.note]}>{state.board.formula}</Text>
              ) : null}
              {state.board.notes.map((note) => (
                <Text key={note} style={[text.caption, styles.note]}>
                  {note}
                </Text>
              ))}
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/**
 * One agent: its rank, its face, its name and wallet, and on the right the
 * return over the sample it came from. An unranked row (`minTrades` given) is
 * dimmed and says how far it is from counting, in place of the address.
 */
function Row({
  row,
  yours,
  minTrades,
  onPress,
}: {
  row: LeaderboardRow;
  yours: boolean;
  minTrades?: number;
  onPress: (row: LeaderboardRow) => void;
}) {
  const ranked = row.rank !== null;
  const tone = row.roi === null || row.roi === 0 ? null : row.roi > 0 ? text.up : text.down;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens this agent’s ledger"
      onPress={() => onPress(row)}
      style={({ pressed }) => [styles.row, !ranked && styles.dimmed, pressed && styles.pressed]}
    >
      <Text style={[styles.rank, row.rank === 1 && styles.first]}>{rankNumeral(row.rank)}</Text>
      <Sigil seed={row.agentId} />
      <View style={styles.main}>
        <Text style={text.strong} numberOfLines={1}>
          {row.name}
          {yours ? <Text style={text.caption}> · yours</Text> : null}
        </Text>
        {ranked ? (
          <Text style={[text.mono, styles.address]} numberOfLines={1}>
            {shortAddress(row.address)}
          </Text>
        ) : (
          <Text style={text.caption} numberOfLines={1}>
            {settledLabel(row.n)}
            {minTrades !== undefined ? ` · ${tooFewLabel(row.n, minTrades)}` : ''}
          </Text>
        )}
      </View>
      <View style={styles.figure}>
        {/* The pair this screen exists for: a return is never printed without
            the sample it came from. */}
        <Text style={[text.strong, text.num, ranked ? tone : styles.faintFigure]}>
          {roiLabel(row.roi)}
        </Text>
        {ranked ? <Text style={[text.caption, text.num]}>{wonLabel(row.wins, row.n)}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 48 },
  intro: { marginTop: 6 },
  cta: { marginTop: 20 },
  list: { marginTop: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  dimmed: { opacity: 0.6 },
  pressed: { opacity: 0.7 },
  /** The design's condensed rank: Bricolage semibold, big and faint. */
  rank: {
    width: 30,
    fontFamily: font.displaySemibold,
    fontSize: 26,
    lineHeight: 28,
    letterSpacing: -1,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  first: { color: color.purpleHi },
  main: { flex: 1, gap: 2 },
  address: { fontSize: 11, lineHeight: 16 },
  figure: { alignItems: 'flex-end', gap: 2 },
  faintFigure: { color: color.textDim },
  note: { marginTop: 6 },
});
