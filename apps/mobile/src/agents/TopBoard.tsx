/**
 * The Board (SEN-26), folded into the Agents tab as "Top" by SEN-114. It was
 * its own tab until SEN-109 and a stack screen until this; the rules it was
 * built on did not move with it:
 *
 * A board, not a scoreboard: every rate is printed with the sample it came
 * from ("won 7 of 10"), and the agents that have not traded enough to be
 * ordered are shown under their own heading instead of being ranked against
 * noise. How it is ranked is one dim line at the top; the formula that
 * produced the numbers is printed verbatim in the fine print, not paraphrased.
 * Tap a row for that agent's Ledger — the numbers are only useful if you can
 * audit them, and the Ledger is where "Fork this strategy" is the primary
 * action.
 *
 * Three states this segment refuses to blur together:
 *
 * - **unconfigured / unreachable**: no numbers exist. It says so, in the
 *   indexer's own words from `source.message`, and shows nothing else.
 * - **nothing ranked yet**: numbers exist, none of them big enough to order.
 * - **ranked**: the table.
 *
 * No period chips, though the study draws 1D/1W/1M/All: `GET /leaderboard`
 * has no window, and a control that changed nothing would be lying about what
 * the numbers cover.
 */
import { useFocusEffect } from 'expo-router';
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
import { Button, Loading, Notice, Section } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

export type BoardState =
  | { kind: 'loading' }
  | { kind: 'loaded'; board: Leaderboard }
  | { kind: 'failed'; title: string; detail: string };

/** Nothing owned is the answer until `GET /agents` says otherwise. */
const NONE: ReadonlySet<string> = new Set();

/**
 * The board and which of its rows are the user's. Loads only while `active`
 * (the Top segment is showing), and again each time the tab regains focus:
 * the indexer is read live on every request.
 */
export function useBoard(active: boolean): {
  state: BoardState;
  owned: ReadonlySet<string>;
  load: () => Promise<void>;
} {
  const { agents: api } = useSession();
  const [state, setState] = useState<BoardState>({ kind: 'loading' });
  /**
   * The board carries each agent's wallet, not its owner's, so the only
   * honest "yours" is the id against the user's own list. A failed list marks
   * nothing rather than failing the board.
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

  useFocusEffect(
    useCallback(() => {
      if (active) void load();
    }, [active, load]),
  );

  return { state, owned, load };
}

export function TopBoard({
  state,
  owned,
  onOpen,
  onRetry,
}: {
  state: BoardState;
  owned: ReadonlySet<string>;
  onOpen: (row: LeaderboardRow) => void;
  onRetry: () => void;
}) {
  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'failed') {
    return (
      <>
        <Notice tone="error" title={state.title} detail={state.detail} />
        <Button label="Try again" onPress={onRetry} style={styles.cta} />
      </>
    );
  }
  const { board } = state;
  if (board.source.kind !== 'ok') {
    return (
      <Notice
        tone={board.source.kind === 'unconfigured' ? 'info' : 'error'}
        title={
          board.source.kind === 'unconfigured' ? 'No indexer configured' : 'Rankings unavailable'
        }
        detail={board.source.message}
      />
    );
  }
  return (
    <>
      <Text style={[text.caption, styles.intro]}>{rankingLine(board.minTrades)}</Text>
      {board.ranked.length > 0 ? (
        <View style={styles.list}>
          {board.ranked.map((row) => (
            <Row key={row.agentId} row={row} yours={owned.has(row.agentId)} onPress={onOpen} />
          ))}
        </View>
      ) : (
        <Notice
          title="Nothing ranked yet"
          detail={`No agent has ${board.minTrades} settled trades on the indexer yet. A win rate over two trades is not a result, so nothing is ordered until then.`}
        />
      )}

      {board.tooFewTrades.length > 0 ? (
        <Section label="Too few trades to rank">
          {board.tooFewTrades.map((row) => (
            <Row
              key={row.agentId}
              row={row}
              yours={owned.has(row.agentId)}
              minTrades={board.minTrades}
              onPress={onOpen}
            />
          ))}
        </Section>
      ) : null}

      {board.formula !== '' || board.notes.length > 0 ? (
        <Section label="The fine print">
          {board.formula !== '' ? (
            <Text style={[text.caption, styles.note]}>{board.formula}</Text>
          ) : null}
          {board.notes.map((note) => (
            <Text key={note} style={[text.caption, styles.note]}>
              {note}
            </Text>
          ))}
        </Section>
      ) : null}
    </>
  );
}

/**
 * The pinned "your best" row: rank, face, where it stands, and its return
 * over its own sample, like every other figure on the board.
 */
export function BestRow({
  row,
  label,
  onPress,
}: {
  row: LeaderboardRow;
  label: string;
  onPress: (row: LeaderboardRow) => void;
}) {
  const tone = roiTone(row);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens this agent’s ledger"
      onPress={() => onPress(row)}
      style={({ pressed }) => [styles.best, pressed && styles.pressed]}
    >
      <Text style={[styles.rank, styles.first]}>{rankNumeral(row.rank)}</Text>
      <Sigil seed={row.agentId} />
      <View style={styles.main}>
        <Text style={text.strong} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={text.caption} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.figure}>
        <Text style={[text.strong, text.num, tone]}>{roiLabel(row.roi)}</Text>
        <Text style={[text.caption, text.num]}>{wonLabel(row.wins, row.n)}</Text>
      </View>
    </Pressable>
  );
}

function roiTone(row: LeaderboardRow) {
  return row.roi === null || row.roi === 0 ? null : row.roi > 0 ? text.up : text.down;
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
        {/* The pair this board exists for: a return is never printed without
            the sample it came from. */}
        <Text style={[text.strong, text.num, ranked ? roiTone(row) : styles.faintFigure]}>
          {roiLabel(row.roi)}
        </Text>
        {ranked ? <Text style={[text.caption, text.num]}>{wonLabel(row.wins, row.n)}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 14 },
  cta: { marginTop: 20 },
  list: { marginTop: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  best: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
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
