/**
 * The Agents tab (SEN-114, plan U-8; agents.html → "Agents tab"): three
 * segments on one screen.
 *
 * - **Presets** — the catalog as cards, each preset drawn as a joseki with
 *   its risk as three stones and its cohort line with the sample it came
 *   from. Guardian is featured. Works signed out and before `GET /presets`
 *   exists, from the catalog bundled out of `@sente/presets`.
 * - **Yours** — the SEN-58 roster, grouped by what you can do: working agents
 *   open the cockpit; a stopped agent's one job left is giving the money back
 *   (SEN-17), so that is its inline action.
 * - **Top** — the Board (SEN-26), folded in from its stack screen, with the
 *   user's best ranked agent pinned above the dock.
 *
 * Account sits behind the header's button until Home grows its avatar (U-7).
 * `?segment=yours|top` opens a segment directly.
 */
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { modelLabel, type Agent, type AgentSummary, type LeaderboardRow } from '@/agents/api';
import { signedPnl } from '@/agents/ledger';
import { MoveLine } from '@/agents/MoveLine';
import { yourBest } from '@/agents/top';
import { BestRow, TopBoard, useBoard } from '@/agents/TopBoard';
import {
  describeMove,
  formatHolding,
  holdsReturnable,
  isTrading,
  mainHolding,
  pnlTone,
  venuesCaption,
  type Holding,
} from '@/agents/usage';
import { useAgentsOverview } from '@/agents/useAgentsOverview';
import { useWalletHoldings } from '@/agents/useWalletHoldings';
import {
  FEATURED_PRESET_ID,
  matchesFilter,
  PRESET_FILTERS,
  type PresetFilter,
} from '@/presets/cards';
import { FeaturedPreset, PresetCard } from '@/presets/PresetCard';
import { usePresets, type PresetsState } from '@/presets/usePresets';
import { useSession } from '@/session';
import { isoDate } from '@/ui/format';
import { Pill, Sigil } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  Card,
  CONTENT_MAX,
  Chip,
  Chips,
  DOCK,
  IconButton,
  Loading,
  Notice,
  Screen,
  Section,
  Segmented,
  useWide,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

type Segment = 'presets' | 'yours' | 'top';

const SEGMENTS: readonly { value: Segment; label: string }[] = [
  { value: 'presets', label: 'Presets' },
  { value: 'yours', label: 'Yours' },
  { value: 'top', label: 'Top' },
];

function isSegment(value: unknown): value is Segment {
  return value === 'presets' || value === 'yours' || value === 'top';
}

export default function AgentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const { agents: api } = useSession();
  const params = useLocalSearchParams<{ segment?: string }>();
  const [segment, setSegment] = useState<Segment>(
    isSegment(params.segment) ? params.segment : 'presets',
  );

  const presets = usePresets();
  // Refetches on focus: after a hire, an amend or a revoke, the list has to say so.
  const yours = useAgentsOverview();
  const top = useBoard(segment === 'top');

  const best = useMemo(
    () => (top.state.kind === 'loaded' ? yourBest(top.state.board.ranked, top.owned) : null),
    [top.state, top.owned],
  );

  const hire = () => router.push('/agents/new');
  // `/presets/[id]` is U-9's screen; until it lands the push reaches the
  // not-found route. The cast is for typed routes, which only know files that
  // exist today.
  const openPreset = (id: string) => router.push(`/presets/${encodeURIComponent(id)}` as Href);
  const openLedger = (row: LeaderboardRow) =>
    router.push({ pathname: '/agents/[id]/ledger', params: { id: row.agentId } });

  const refreshing =
    segment === 'presets' ? presets.refreshing : segment === 'yours' ? yours.refreshing : false;
  const onRefresh = !api
    ? undefined
    : segment === 'presets'
      ? () => void presets.refresh()
      : segment === 'yours'
        ? () => void yours.refresh()
        : () => void top.load();

  const pinned = segment === 'top' && best !== null;

  return (
    <View style={styles.fill}>
      <Screen tabbed refreshing={refreshing} onRefresh={onRefresh}>
        <View style={styles.header}>
          <Text style={text.display}>Agents</Text>
          <View style={styles.actions}>
            <IconButton icon="account" label="Account" onPress={() => router.push('/account')} />
            {api ? (
              <Button label="Hire" kind="primary" size="sm" icon="plus" onPress={hire} />
            ) : null}
          </View>
        </View>
        <View style={styles.segments}>
          <Segmented options={SEGMENTS} value={segment} onChange={setSegment} />
        </View>

        {segment === 'presets' ? (
          <PresetsSegment
            presets={presets.state.presets}
            stats={presets.state.stats}
            onOpen={openPreset}
          />
        ) : !api ? (
          <Notice
            title="Sign in first"
            detail="Agents belong to your passkey account. Sign in, then come back."
          />
        ) : segment === 'yours' ? (
          <YoursSegment
            overview={yours}
            onHire={hire}
            onBrowse={() => setSegment('presets')}
            onOpen={(agent, sheet) =>
              router.push({
                pathname: '/agents/[id]',
                params: sheet ? { id: agent.id, sheet } : { id: agent.id },
              })
            }
          />
        ) : (
          <>
            <TopBoard
              state={top.state}
              owned={top.owned}
              onOpen={openLedger}
              onRetry={() => void top.load()}
            />
            {/* Room for the pinned row, so it never covers the last one. */}
            {pinned ? <View style={styles.pinSpace} /> : null}
          </>
        )}
      </Screen>

      {pinned ? (
        <View
          style={[
            styles.pinned,
            wide ? styles.pinnedWide : { bottom: insets.bottom + DOCK.lift + DOCK.height + 10 },
          ]}
        >
          <BestRow row={best.row} label={best.label} onPress={openLedger} />
        </View>
      ) : null}
    </View>
  );
}

// ─── Presets ────────────────────────────────────────────────────────────────

function PresetsSegment({
  presets,
  stats,
  onOpen,
}: {
  presets: PresetsState['presets'];
  stats: PresetsState['stats'];
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<PresetFilter>('all');
  // The featured card stands in for Guardian under "All" only; under any other
  // chip Guardian is an ordinary card if it matches, so no filter hides it.
  const featured =
    filter === 'all' ? presets.find((preset) => preset.id === FEATURED_PRESET_ID) : undefined;
  const shown = presets.filter((preset) => preset !== featured && matchesFilter(preset, filter));

  return (
    <>
      {featured ? (
        <View style={styles.featured}>
          <FeaturedPreset
            preset={featured}
            stats={stats.get(featured.id)}
            onPress={() => onOpen(featured.id)}
          />
        </View>
      ) : null}
      <View style={styles.chips}>
        <Chips>
          {PRESET_FILTERS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={filter === option.value}
              onPress={() => setFilter(option.value)}
            />
          ))}
        </Chips>
      </View>
      <View style={styles.list}>
        {shown.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            stats={stats.get(preset.id)}
            onPress={() => onOpen(preset.id)}
          />
        ))}
        {shown.length === 0 ? <Text style={text.dim}>No presets match.</Text> : null}
      </View>
    </>
  );
}

// ─── Yours ──────────────────────────────────────────────────────────────────

function YoursSegment({
  overview,
  onHire,
  onBrowse,
  onOpen,
}: {
  overview: ReturnType<typeof useAgentsOverview>;
  onHire: () => void;
  onBrowse: () => void;
  onOpen: (agent: Agent, sheet?: 'return') => void;
}) {
  const { state, refresh } = overview;
  const agents = state.kind === 'loaded' ? state.agents : null;
  const holdings = useWalletHoldings(agents);
  const now = Date.now();

  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'failed') {
    return (
      <>
        <Notice tone="error" title={state.title} detail={state.detail} />
        <Button label="Try again" onPress={() => void refresh()} style={styles.cta} />
      </>
    );
  }
  if (state.agents.length === 0) {
    return (
      <Card style={styles.empty}>
        <Text style={text.title}>Hire your first agent</Text>
        <Text style={text.dim}>
          An agent trades for you inside a mandate you set: which markets, how much per deposit, how
          large an order, and until when. The enclave won’t sign anything past it.
        </Text>
        <Button label="Start from a preset" kind="primary" onPress={onBrowse} />
        <Button label="Write your own" kind="soft" icon="plus" onPress={onHire} />
      </Card>
    );
  }

  const working = state.agents.filter((agent) => agent.status === 'active');
  const stopped = state.agents.filter((agent) => agent.status !== 'active');
  const card = (agent: Agent) => (
    <AgentCard
      key={agent.id}
      agent={agent}
      summary={state.summaries.get(agent.id)}
      holdings={holdings.get(agent.id)}
      now={now}
      onOpen={() => onOpen(agent)}
      onReturn={() => onOpen(agent, 'return')}
    />
  );

  return (
    <>
      {working.length > 0 ? (
        <Section label="Working">
          <View style={styles.cards}>{working.map(card)}</View>
        </Section>
      ) : null}
      {stopped.length > 0 ? (
        <Section label="Stopped">
          <View style={styles.cards}>{stopped.map(card)}</View>
        </Section>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={onBrowse}
        style={({ pressed }) => [styles.another, pressed && styles.pressed]}
      >
        <View style={styles.anotherIcon}>
          <Icon name="plus" size={18} color={color.purpleHi} />
        </View>
        <View style={styles.grow}>
          <Text style={styles.anotherTitle}>Hire another</Text>
          <Text style={text.dim}>Start from a preset, or fork one from Top</Text>
        </View>
      </Pressable>
    </>
  );
}

/**
 * One agent, one card (SEN-58): its sigil, what it trades, its status, the
 * balance in its own wallet, today's P&L and its last move as a stone. A
 * revoked agent that still holds funds offers the return inline (SEN-17).
 */
function AgentCard({
  agent,
  summary,
  holdings,
  now,
  onOpen,
  onReturn,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  /** `undefined` until the chain answers, or if it didn't. */
  holdings: Holding[] | undefined;
  now: number;
  onOpen: () => void;
  onReturn: () => void;
}) {
  const active = agent.status === 'active';
  const trading = active && isTrading(summary, now);
  const main = holdings
    ? mainHolding(holdings, agent.mandate.venues.includes('kuru') ? 'USDC' : 'AUSD')
    : null;
  const move = summary?.lastEvent ? describeMove(summary.lastEvent) : null;
  const today = summary?.pnl.last24h;
  const tone = pnlTone(today);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${active ? (trading ? 'trading' : 'watching') : 'revoked'}`}
      onPress={onOpen}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card quiet={!active}>
        <View style={styles.top}>
          <Sigil seed={agent.id} dimmed={!active} />
          <View style={styles.grow}>
            <Text style={[text.title, !active && styles.dim]} numberOfLines={1}>
              {agent.name}
            </Text>
            <Text style={text.caption} numberOfLines={1}>
              {active
                ? `${modelLabel(agent.model)} · ${venuesCaption(agent.mandate)}`
                : `Revoked${agent.revokedAt ? ` ${isoDate(agent.revokedAt)}` : ''}`}
            </Text>
          </View>
          {active ? (
            <Pill label={trading ? 'Trading' : 'Watching'} tone={trading ? 'live' : 'idle'} />
          ) : (
            <Pill label="Revoked" tone="revoked" />
          )}
        </View>

        {active ? (
          <>
            <View style={styles.figures}>
              <Text style={[text.strong, text.num]}>
                {main ? formatHolding(main) : '—'}{' '}
                <Text style={text.dim}>{main?.symbol ?? ''}</Text>
              </Text>
              {today !== undefined ? (
                <Text
                  style={[
                    text.dim,
                    text.num,
                    tone === 'up' && text.up,
                    tone === 'down' && text.down,
                  ]}
                >
                  {tone === null ? '0' : signedPnl(today)} today
                </Text>
              ) : null}
            </View>
            {move ? (
              <>
                <View style={styles.hairline} />
                <MoveLine move={move} now={now} />
              </>
            ) : null}
          </>
        ) : holdings && main && holdsReturnable(holdings) ? (
          <View style={styles.figures}>
            <Text style={[text.dim, text.num, styles.grow]}>
              {formatHolding(main)} {main.symbol} still in its wallet
            </Text>
            <Button label="Return" kind="soft" size="sm" onPress={onReturn} />
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.ink },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 44,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  segments: { marginTop: 12 },
  featured: { marginTop: 16 },
  chips: { marginTop: 14 },
  list: { marginTop: 12, gap: 12 },
  cards: { gap: 12, marginTop: 8 },
  cta: { marginTop: 20 },
  empty: { marginTop: 24, gap: 12 },
  another: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 22,
    padding: 14,
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
  },
  anotherIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.well,
  },
  anotherTitle: { fontFamily: font.displaySemibold, fontSize: 15, color: color.text },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, gap: 2 },
  dim: { color: color.textDim },
  figures: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
  },
  hairline: { height: 1, backgroundColor: color.line, marginVertical: 12 },
  pressed: { opacity: 0.85 },
  pinSpace: { height: 84 },
  pinned: {
    position: 'absolute',
    left: 14,
    right: 14,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 18,
    backgroundColor: '#221C44',
    borderWidth: 1,
    borderColor: color.purple,
  },
  // No dock on a wide screen (SEN-166): the row sits at the foot of the column.
  pinnedWide: { bottom: 20, maxWidth: CONTENT_MAX - 28, marginHorizontal: 'auto' },
});
