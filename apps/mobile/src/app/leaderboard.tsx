/**
 * The leaderboard (SEN-26) — the zero-balance landing content.
 *
 * A board, not a scoreboard: every rate is printed with the sample it came
 * from, the formulas that produced them are above the table rather than in a
 * tooltip, and the agents that have not traded enough to be ordered are shown
 * under their own heading instead of being ranked against noise. Tap a row for
 * that agent's Ledger — the numbers here are only useful if you can audit them.
 *
 * Three states this screen refuses to blur together:
 *
 * - **unconfigured / unreachable**: no numbers exist. It says so, in the
 *   indexer's own words from `source.message`, and shows nothing else.
 * - **nothing ranked yet**: numbers exist, none of them big enough to order.
 * - **ranked**: the table.
 *
 * Achromatic, like the rest of the app: no purple (the consensus ramp's), and
 * mono is left for chain facts. A rank is a number, not an address.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  describeAgentsError,
  modelLabel,
  type Leaderboard,
  type LeaderboardRow,
} from '@/agents/api';
import {
  amountLabel,
  pnlLabel,
  rankLabel,
  rateWithSample,
  roiLabel,
  thesisLabel,
  tooFewLabel,
  venueLabel,
} from '@/agents/leaderboard';
import { useSession } from '@/session';
import { Button, Loading, Notice, Screen, Section, TopBar } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

type State =
  | { kind: 'loading' }
  | { kind: 'loaded'; board: Leaderboard }
  | { kind: 'failed'; title: string; detail: string };

export default function LeaderboardScreen() {
  const router = useRouter();
  const { agents: api } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
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

  /**
   * Forking is the honest copy-trade (SEN-28): the new agent carries this row's
   * strategy and model, and is bounded by the mandate the FORKER writes — never
   * by the source's. The next screen is the mandate, so nothing is inherited
   * silently.
   */
  const fork = useCallback(
    (row: LeaderboardRow) =>
      router.push({
        pathname: '/agents/new',
        params: { fork: row.agentId, from: row.name },
      }),
    [router],
  );

  const board = state.kind === 'loaded' ? state.board : null;
  const home = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <Screen refreshing={refreshing} onRefresh={api ? () => void refresh() : undefined}>
      <TopBar back={{ label: 'Home', onPress: home }} />
      <Text style={text.display}>Leaderboard</Text>
      <Text style={[text.dim, styles.intro]}>
        Ranked on what the venues recorded, not on what an agent said. Tap a row for its ledger, or
        fork its strategy under your own mandate.
      </Text>

      {board !== null && board.formula !== '' ? (
        <View style={styles.formula}>
          <Text style={text.label}>How this is measured</Text>
          <Text style={styles.formulaText}>{board.formula}</Text>
        </View>
      ) : null}

      {!api ? (
        <>
          <Notice
            title="Sign in first"
            detail="The board is global, but the API still wants a caller: sign in on the home screen and come back."
          />
          <Button label="Go to sign-in" onPress={() => router.replace('/')} style={styles.cta} />
        </>
      ) : state.kind === 'loading' ? (
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
            <Section label={`Ranked · n ≥ ${state.board.minTrades} settled trades`}>
              <View style={styles.list}>
                {state.board.ranked.map((row) => (
                  <Row
                    key={row.agentId}
                    row={row}
                    minTrades={state.board.minTrades}
                    onPress={open}
                    onFork={fork}
                  />
                ))}
              </View>
            </Section>
          ) : (
            <Notice
              title="Nothing ranked yet"
              detail={`No agent has ${state.board.minTrades} settled trades on the indexer yet. A win rate over two trades is not a result, so nothing is ordered until then.`}
            />
          )}

          {state.board.tooFewTrades.length > 0 ? (
            <Section label="Too few trades to rank">
              <View style={styles.list}>
                {state.board.tooFewTrades.map((row) => (
                  <Row
                    key={row.agentId}
                    row={row}
                    minTrades={state.board.minTrades}
                    onPress={open}
                    onFork={fork}
                  />
                ))}
              </View>
            </Section>
          ) : null}

          {state.board.notes.length > 0 ? (
            <Section label="The fine print">
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

/** One agent: the rate and its sample on the first line, the evidence under it. */
function Row({
  row,
  minTrades,
  onPress,
  onFork,
}: {
  row: LeaderboardRow;
  minTrades: number;
  onPress: (row: LeaderboardRow) => void;
  onFork: (row: LeaderboardRow) => void;
}) {
  const loss = row.roi !== null && row.roi < 0;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(row)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <Text style={[text.num, styles.rank]}>{rankLabel(row.rank)}</Text>
        <Text style={[text.title, styles.name]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[text.title, text.num, loss && text.danger]}>{roiLabel(row.roi)}</Text>
      </View>

      {/* The pair this screen exists for: a rate is never printed alone. */}
      <Text style={[text.strong, text.num, styles.rate]}>{rateWithSample(row.winRate, row.n)}</Text>

      <Text style={[text.caption, text.num, styles.line]}>
        {pnlLabel(row.realisedPnlUsd)} realised on {amountLabel(row.capitalDeployedUsd)} deployed
      </Text>
      <Text style={[text.caption, text.num, styles.line]}>
        {thesisLabel(row.theses)} · {venueLabel(row.venues)}
        {row.indexed ? ` · ${row.fills} fills` : ''}
      </Text>
      {row.rank === null ? (
        <Text style={[text.caption, text.num, styles.line]}>{tooFewLabel(row.n, minTrades)}</Text>
      ) : null}

      <Text style={[text.caption, styles.line]} numberOfLines={1}>
        {modelLabel(row.model)} · {row.mandate}
      </Text>

      {/* The honest copy-trade: the strategy, run under the forker's own mandate
          (SEN-28). Nested inside the row's own press, so tapping the row still
          opens the ledger. */}
      <Button label="Fork strategy" onPress={() => onFork(row)} style={styles.fork} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 4 },
  formula: {
    marginTop: 18,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: color.rule,
    gap: 6,
  },
  formulaText: { fontFamily: font.medium, fontSize: 15, lineHeight: 21, color: color.text },
  cta: { marginTop: 20 },
  list: { marginTop: 8 },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.rule },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  rank: { fontSize: 12, color: color.textFaint },
  name: { flex: 1 },
  rate: { marginTop: 6 },
  line: { marginTop: 3 },
  note: { marginTop: 6 },
  /** Small, left-aligned, inside the row: a row action, not a page action. */
  fork: { alignSelf: 'flex-start', marginTop: 12, minHeight: 0, paddingVertical: 8 },
  pressed: { opacity: 0.7 },
});
