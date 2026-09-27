/**
 * One agent: the cockpit (SEN-115), three tabs over the same agent.
 *
 * - OVERVIEW is a trader profile, not a settings page: realised P&L as the
 *   headline, its equity curve, four stats, the open positions from the
 *   portfolio route, and the cadence control.
 * - HISTORY puts the best closed trades on top and the Ledger's stone spine
 *   below, grouped by day with each day's realised total.
 * - MANDATE is one card: the rules as a sentence, then proof they held, then
 *   the gauges and the actions.
 *
 * Everything SEN-58 built is still here, only re-laid out: Fund sits top
 * right, Run now and the ask field in a bar at the foot of every tab (asking is
 * how you steer the agent, so it gets a permanent place), Amend, Return and
 * Revoke on the Mandate card; ids and the instructions are behind ⋯ → Details.
 * Fund, run, return and revoke confirm in an in-app sheet (never `Alert`);
 * amend reuses the hire form's mandate and review steps.
 *
 * Return is available on a REVOKED agent too, and deliberately so (SEN-17): a
 * revoke leaves the way out open, so "how do I get my money back" has the same
 * one-tap answer after the agent has stopped as before. The agents list links
 * straight to it with `?sheet=return`.
 *
 * The portfolio and schedule routes may not be deployed yet (B-T10, B-T13): a
 * 404 from them hides their section instead of showing an error, and the P&L
 * falls back to the chain read of the agent's wallet.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatAtoms, parseAmount } from '@/agents/amounts';
import {
  AgentsApiError,
  describeAgentsError,
  modelLabel,
  type Agent,
  type AgentPortfolioDto,
  type AgentScheduleStatusDto,
  type AgentSummary,
  type PreparedMandateChange,
} from '@/agents/api';
import { describeApprovalError, needsApproval, revokeWithApproval } from '@/agents/approval';
import { readBalance, readBalances } from '@/agents/balances';
import {
  bestTrades,
  CADENCES,
  cockpitStats,
  COCKPIT_TABS,
  EQUITY_RANGES,
  equitySeries,
  historyDays,
  largestOrderLine,
  mandateSigned,
  pnlUnit,
  positionRows,
  rulesSentence,
  scheduleLine,
  settledTrades,
  shortDate,
  signedParts,
  tabFrom,
  trackLayout,
  type CockpitTab,
  type EquityRange,
  type PositionRow,
} from '@/agents/cockpit';
import { FUNDING_TOKENS } from '@/agents/fund';
import { clockTime, type LedgerEntry } from '@/agents/ledger';
import {
  depositHeadline,
  depositSource,
  heldBy,
  inFilter,
  LEDGER_FILTERS,
  stoneFor,
  thesisKind,
  tradeDetail,
  tradeHeadline,
  verdictHeadline,
  type LedgerFilter,
} from '@/agents/ledgerView';
import { describeMandate, type Enforcer, type Token } from '@/agents/mandate';
import { expiryUsage, formatHolding, isTrading, mainHolding } from '@/agents/usage';
import { useAgentEvents } from '@/agents/useAgentEvents';
import { toHoldings } from '@/agents/useWalletHoldings';
import { useSession } from '@/session';
import { describeSendError, sendSponsored } from '@/wallet/send';
import { Chart } from '@/ui/chart/Chart';
import { shortAddress } from '@/ui/format';
import { EnforcerTag, Gauge, Pill, Sigil, Stat, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  ButtonRow,
  Card,
  Chip,
  Chips,
  Field,
  IconButton,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  SectionLink,
  Segmented,
  Sheet,
  Tag,
  TopBar,
  type NoticeTone,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { BigNumber, RangePills, SideTag, TokenGlyph } from '@/ui/trading';

type NoticeState = { tone: NoticeTone; title: string; detail?: string };
type SheetId = 'fund' | 'run' | 'return' | 'revoke' | 'details';

/**
 * Limits the Mandate card already says elsewhere — in the sentence, the proof
 * or the expiry gauge — so the rows under the gauge leave them out. `returnTo`
 * is in Details: it is an address, not a limit.
 */
const NOT_A_ROW = new Set([
  'maxOrderNotional',
  'expiresAt',
  'kuru.markets',
  'perpl.markets',
  'returnTo',
]);

export default function AgentScreen() {
  const router = useRouter();
  const {
    id,
    sheet: askedSheet,
    tab: askedTab,
  } = useLocalSearchParams<{ id: string; sheet?: string; tab?: string }>();
  const { agents: api } = useSession();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [summary, setSummary] = useState<AgentSummary | undefined>(undefined);
  /** `undefined` while reading; `null` when the route is missing or failed — the section hides. */
  const [portfolio, setPortfolio] = useState<AgentPortfolioDto | null | undefined>(undefined);
  const [schedule, setSchedule] = useState<AgentScheduleStatusDto | null>(null);
  const [loadError, setLoadError] = useState<NoticeState | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<CockpitTab>(() => tabFrom(askedTab));
  // The whole trail, tailed while the screen is focused: History draws it, and
  // Overview's stats, equity and best trades are read from it.
  const events = useAgentEvents(id);

  const refreshBalances = useCallback((address: Agent['address']) => {
    readBalances(address).then(setBalances, () => setBalances(null));
  }, []);

  const load = useCallback(async () => {
    if (!api || !id) return;
    // Only the agent itself is required. The summary, portfolio and schedule
    // decorate it: an older API, or a blip, leaves the screen standing.
    const [fresh, summaries, held, cadence] = await Promise.allSettled([
      api.get(id),
      api.summaries(),
      api.portfolio(id),
      api.schedule(id),
    ]);
    if (fresh.status === 'rejected') {
      setLoadError({ tone: 'error', ...describeAgentsError(fresh.reason) });
      return;
    }
    setAgent(fresh.value);
    setLoadError(null);
    refreshBalances(fresh.value.address);
    setSummary(
      summaries.status === 'fulfilled'
        ? summaries.value.find((line) => line.agentId === id)
        : undefined,
    );
    setPortfolio(held.status === 'fulfilled' ? held.value : null);
    setSchedule(cadence.status === 'fulfilled' ? cadence.value : null);
  }, [api, id, refreshBalances]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Arriving from the list's inline "Return" opens the return sheet once, not
  // on every refetch.
  const opened = useRef(false);
  useEffect(() => {
    if (agent && askedSheet === 'return' && !opened.current) {
      opened.current = true;
      setSheet('return');
    }
  }, [agent, askedSheet]);

  const close = () => setSheet(null);
  const finish = (next: NoticeState) => {
    setSheet(null);
    setNotice(next);
    void load();
  };

  const backToList = () => (router.canGoBack() ? router.back() : router.replace('/agents'));

  if (!agent) {
    return (
      <Screen>
        <TopBar back={{ label: 'Agents', onPress: backToList }} />
        {!api ? (
          <Notice title="Sign in first" detail="Agents belong to your passkey account." />
        ) : loadError ? (
          <Notice tone="error" title={loadError.title} detail={loadError.detail} />
        ) : (
          <Loading />
        )}
      </Screen>
    );
  }

  const active = agent.status === 'active';
  const now = Date.now();
  const trading = active && isTrading(summary, now);
  const amend = () => router.push({ pathname: '/agents/new', params: { amend: agent.id } });

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      footer={active ? <AskBar agent={agent} onOpen={() => setSheet('run')} /> : undefined}
    >
      <TopBar
        back={{ label: 'Agents', onPress: backToList }}
        right={
          <View style={styles.topActions}>
            {active ? (
              <Button
                label="Fund"
                kind="primary"
                size="sm"
                icon="plus"
                onPress={() => setSheet('fund')}
              />
            ) : null}
            <IconButton icon="more" label="Details" onPress={() => setSheet('details')} />
          </View>
        }
      />
      <View style={styles.header}>
        <Sigil seed={agent.id} size={56} dimmed={!active} />
        <View style={styles.headerText}>
          <Text style={[text.display, styles.name]} numberOfLines={2}>
            {agent.name}
          </Text>
          <View style={styles.meta}>
            {agent.preset ? (
              <Tag label={`${agent.preset.name}${agent.preset.customized ? ' · edited' : ''}`} />
            ) : null}
            <Text style={text.caption}>{modelLabel(agent.model)}</Text>
            {active ? (
              <Pill label={trading ? 'Trading' : 'Watching'} tone={trading ? 'live' : 'idle'} />
            ) : (
              <Pill label="Revoked" tone="revoked" />
            )}
          </View>
        </View>
      </View>

      {notice ? <Notice tone={notice.tone} title={notice.title} detail={notice.detail} /> : null}

      {active ? null : (
        <Notice
          title={`Revoked${agent.revokedAt ? ` on ${shortDate(Date.parse(agent.revokedAt))}` : ''}`}
          detail={
            agent.policyCleared === false
              ? 'The agent won’t run again, but its wallet policy still holds the old rules. Revoke again to clear it.'
              : 'It can’t trade, deposit or approve anything again — revoking is permanent. Its ' +
                'policy keeps only the way out, so you can still send its funds back to your wallet.'
          }
        />
      )}

      <View style={styles.tabs}>
        <Segmented options={COCKPIT_TABS} value={tab} onChange={setTab} />
      </View>

      {tab === 'overview' ? (
        <Overview
          agent={agent}
          summary={summary}
          balances={balances}
          portfolio={portfolio}
          schedule={schedule}
          entries={events.entries}
          now={now}
          onReturn={() => setSheet('return')}
          onScheduled={(updated) => {
            setAgent(updated);
            void load();
          }}
        />
      ) : tab === 'history' ? (
        <History agent={agent} events={events} now={now} />
      ) : (
        <MandateCard
          agent={agent}
          summary={summary}
          now={now}
          onAmend={amend}
          onReturn={() => setSheet('return')}
          onRevoke={() => setSheet('revoke')}
        />
      )}

      <DetailsSheet agent={agent} visible={sheet === 'details'} onClose={close} />
      <FundSheet agent={agent} visible={sheet === 'fund'} onClose={close} onSent={finish} />
      <RunSheet agent={agent} visible={sheet === 'run'} onClose={close} />
      <ReturnSheet agent={agent} visible={sheet === 'return'} onClose={close} onDone={finish} />
      <RevokeSheet agent={agent} visible={sheet === 'revoke'} onClose={close} onDone={finish} />
    </Screen>
  );
}

/**
 * The foot of every tab: Run now (a run with no instruction) beside the ask
 * field. Both open the run sheet, whose instruction field is the ask — the
 * full Ask sheet with suggestions is U-11's.
 */
function AskBar({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  return (
    <View style={styles.askBar}>
      <Button label="Run now" kind="soft" size="sm" icon="bolt" onPress={onOpen} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ask ${agent.name} to do something`}
        onPress={onOpen}
        style={({ pressed }) => [styles.askField, pressed && styles.pressed]}
      >
        <Text style={[text.dim, styles.grow]} numberOfLines={1}>
          Ask {agent.name} to…
        </Text>
        <Icon name="chevron" size={16} color={color.textDim} />
      </Pressable>
    </View>
  );
}

// ─── Overview ───────────────────────────────────────────────────────────────

function Overview({
  agent,
  summary,
  balances,
  portfolio,
  schedule,
  entries,
  now,
  onReturn,
  onScheduled,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  balances: Record<string, bigint> | null;
  portfolio: AgentPortfolioDto | null | undefined;
  schedule: AgentScheduleStatusDto | null;
  entries: LedgerEntry[];
  now: number;
  onReturn: () => void;
  onScheduled: (agent: Agent) => void;
}) {
  const active = agent.status === 'active';
  const [range, setRange] = useState<EquityRange>('All');
  const [scrub, setScrub] = useState<number | null>(null);

  const trades = useMemo(() => settledTrades(entries), [entries]);
  const stats = cockpitStats(trades, entries, summary, agent.createdAt);
  const series = useMemo(
    () => equitySeries(trades, range, now, Date.parse(agent.createdAt)),
    // `now` moves every render; the window only needs to follow the trades.
    [trades, range, agent.createdAt],
  );

  // Scrubbing the curve moves the headline to that point, and the right-hand
  // line to its date; the chart never owns the headline.
  const scrubbed = scrub !== null && series ? scrub : null;
  const headline = signedParts(
    scrubbed !== null ? series?.points[scrubbed] : (summary?.pnl.allTime ?? null),
  );
  const today = signedParts(summary?.pnl.last24h);
  const { unit, approx } = pnlUnit(agent.mandate.venues);

  const holdings = balances ? toHoldings(balances) : null;
  const main = holdings
    ? mainHolding(holdings, agent.mandate.venues.includes('kuru') ? 'USDC' : 'AUSD')
    : null;
  const others = holdings?.filter((holding) => holding !== main && holding.atoms > 0n) ?? [];
  const rows = portfolio ? positionRows(portfolio, entries, agent.preset) : null;

  return (
    <View>
      <View style={styles.hero}>
        <Text style={text.label}>{scrubbed !== null ? 'P&L at this point' : 'All-time P&L'}</Text>
        <View style={styles.figure}>
          <BigNumber
            // No summary (an API before SEN-56) is no figure, not a zero.
            value={scrubbed === null && !summary ? '—' : headline.magnitude}
            prefix={headline.sign}
            approx={approx}
            style={headline.tone === 'up' ? text.up : headline.tone === 'down' ? text.down : null}
          />
          {unit ? <Text style={text.dim}>{unit}</Text> : null}
          <Text
            style={[
              text.dim,
              text.num,
              styles.pushRight,
              scrubbed === null && today.tone === 'up' && text.up,
              scrubbed === null && today.tone === 'down' && text.down,
            ]}
          >
            {scrubbed !== null && series
              ? shortDate(series.ats[scrubbed] ?? now)
              : summary
                ? `${today.sign}${today.magnitude} today`
                : ''}
          </Text>
        </View>
        <Text style={[text.caption, text.num]}>
          {portfolio
            ? `≈ $${portfolio.totals.approxUsd} across its wallet and venues · P&L is realised only`
            : main
              ? `${formatHolding(main)} ${main.symbol} in its wallet · P&L is realised only`
              : balances === null
                ? 'Reading the chain…'
                : 'P&L is realised only'}
        </Text>
        {!portfolio && others.length > 0 ? (
          <Text style={[text.caption, text.num]}>
            {others.map((holding) => `${formatHolding(holding)} ${holding.symbol}`).join(' · ')}
          </Text>
        ) : null}
      </View>

      {series ? (
        <View style={styles.chart}>
          <Chart
            kind="area"
            points={series.points}
            height={92}
            onScrub={setScrub}
            label={`${agent.name}’s realised P&L`}
          />
        </View>
      ) : (
        <Text style={[text.caption, styles.chartEmpty]}>
          No settled trades in this window yet, so there is no curve to draw.
        </Text>
      )}
      <RangePills
        options={EQUITY_RANGES}
        value={range}
        onChange={(next) => {
          // A scrub index belongs to the series it was taken on.
          setScrub(null);
          setRange(next);
        }}
      />

      <View style={styles.stats}>
        <View style={styles.statRow}>
          <Stat label="Won" value={stats.won} />
          <Stat label="Avg hold" value={stats.avgHold} />
        </View>
        <View style={styles.statRow}>
          <Stat label="Held" value={stats.held} />
          <Stat label="Live since" value={stats.liveSince} />
        </View>
      </View>

      {active ? null : (
        // The whole point of a revoke that keeps the exit (SEN-17).
        <View style={styles.revokedAction}>
          <Button label="Return funds" kind="primary" size="sm" icon="return" onPress={onReturn} />
        </View>
      )}

      {rows === null ? (
        portfolio === undefined ? (
          <Text style={[text.caption, styles.reading]}>Reading its positions…</Text>
        ) : null
      ) : (
        <Section label={rows.length === 1 ? 'Open position' : 'Open positions'}>
          {rows.length === 0 ? (
            <Text style={text.dim}>Nothing open. It is holding cash.</Text>
          ) : (
            <View style={styles.positions}>
              {rows.map((row) => (
                <PositionCard key={row.key} row={row} />
              ))}
            </View>
          )}
        </Section>
      )}

      {active ? (
        <Cadence agent={agent} schedule={schedule} now={now} onScheduled={onScheduled} />
      ) : null}
    </View>
  );
}

/** One open position: what it is, what it's worth, and where price sits between stop and target. */
function PositionCard({ row }: { row: PositionRow }) {
  const track =
    row.levels && row.entry && row.mark ? trackLayout(row.levels, row.entry, row.mark) : null;
  return (
    <Card style={styles.position}>
      <View style={styles.positionTop}>
        <TokenGlyph symbol={row.base} />
        <View style={styles.grow}>
          <View style={styles.inline}>
            <Text style={text.strong}>{row.base}</Text>
            <SideTag side={row.side} />
          </View>
          <Text style={[text.caption, text.num]} numberOfLines={1}>
            {row.detail}
          </Text>
        </View>
        <View style={styles.positionFig}>
          <Text
            style={[
              text.strong,
              text.num,
              row.tone === 'up' && text.up,
              row.tone === 'down' && text.down,
            ]}
          >
            {row.pnl ?? '—'}
          </Text>
          {row.pct ? (
            <Text
              style={[
                text.caption,
                text.num,
                row.tone === 'up' && text.up,
                row.tone === 'down' && text.down,
              ]}
            >
              {row.pct}
            </Text>
          ) : null}
        </View>
      </View>
      {track && row.levels ? (
        <View>
          <View style={styles.track}>
            <View
              style={[
                styles.trackSpan,
                {
                  left: `${Math.min(track.entry, track.mark) * 100}%`,
                  width: `${Math.abs(track.mark - track.entry) * 100}%`,
                },
              ]}
            />
            <View style={[styles.trackEntry, { left: `${track.entry * 100}%` }]} />
            <View style={[styles.trackMark, { left: `${track.mark * 100}%` }]} />
          </View>
          <View style={styles.trackLegend}>
            <Text style={[text.caption, text.num]}>stop {row.levels.stop}</Text>
            <Text style={[text.caption, text.num]}>target {row.levels.target}</Text>
          </View>
          <Text style={text.caption}>Watched: checked every run, not venue orders.</Text>
        </View>
      ) : row.liq ? (
        <Text style={[text.caption, text.num]}>
          Mark {row.mark ?? '—'} · Liq. est {row.liq}
        </Text>
      ) : null}
      {row.thesis ? (
        <Text style={text.voice} numberOfLines={4}>
          {row.thesis}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * How often the agent checks the markets (SEN-67's `PATCH …/schedule`). The
 * line under it comes from `GET …/schedule` when the server has it (B-T13),
 * else from the agent record alone.
 */
function Cadence({
  agent,
  schedule,
  now,
  onScheduled,
}: {
  agent: Agent;
  schedule: AgentScheduleStatusDto | null;
  now: number;
  onScheduled: (agent: Agent) => void;
}) {
  const { agents: api } = useSession();
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<NoticeState | null>(null);
  const current = agent.schedule?.everySeconds ?? null;

  const choose = async (seconds: number | null) => {
    if (!api || seconds === current || busy !== undefined) return;
    setBusy(seconds);
    setError(null);
    try {
      onScheduled(await api.setSchedule(agent.id, seconds));
    } catch (caught) {
      setError({ tone: 'error', ...describeAgentsError(caught) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Section label="Checks the markets">
      <Chips>
        {CADENCES.map((option) => (
          <Chip
            key={option.label}
            label={busy === option.seconds ? '…' : option.label}
            selected={option.seconds === current}
            onPress={() => void choose(option.seconds)}
          />
        ))}
      </Chips>
      <Text style={[text.caption, styles.after]}>
        {scheduleLine(schedule, agent.schedule, now)}
      </Text>
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
    </Section>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

function History({
  agent,
  events,
  now,
}: {
  agent: Agent;
  events: ReturnType<typeof useAgentEvents>;
  now: number;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const trades = useMemo(() => settledTrades(events.entries), [events.entries]);
  const best = bestTrades(trades);
  const won = trades.filter((trade) => trade.tone === 'up').length;
  const days = useMemo(
    () =>
      historyDays(
        events.entries.filter((entry) => inFilter(entry, filter)),
        now,
      ),
    // `now` moves every render; "Today" only needs the entries to re-group.
    [events.entries, filter],
  );
  const active = agent.status === 'active';

  return (
    <View>
      {best.length > 0 ? (
        <Section
          label="Best trades"
          aside={
            <Text style={text.caption}>
              won {won} of {trades.length}
            </Text>
          }
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.best}>
              {best.map((trade) => (
                <View key={trade.seq} style={styles.bestCard}>
                  <Text style={text.caption} numberOfLines={1}>
                    {trade.title}
                  </Text>
                  <Text style={[styles.bestPnl, text.up]}>{trade.pnl}</Text>
                  <Text style={[text.caption, text.num]}>{trade.caption}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </Section>
      ) : null}

      <Section
        label="Moves"
        aside={
          <SectionLink
            label="Full ledger"
            onPress={() =>
              router.push({ pathname: '/agents/[id]/ledger', params: { id: agent.id } })
            }
          />
        }
      >
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
        {!events.loaded ? (
          <Text style={[text.caption, styles.after]}>Reading its moves…</Text>
        ) : events.entries.length === 0 && events.error !== null ? (
          <Text style={[text.caption, styles.after]}>
            Couldn’t read its moves. Pull down to try again.
          </Text>
        ) : events.entries.length === 0 ? (
          <Text style={[text.dim, styles.after]}>
            {active
              ? 'No moves yet. It trades on its next run, or when you run it now.'
              : 'No moves.'}
          </Text>
        ) : days.length === 0 ? (
          <Text style={[text.dim, styles.after]}>Nothing of this kind yet.</Text>
        ) : (
          days.map((day) => (
            <View key={day.key} style={styles.day}>
              <View style={styles.dayHead}>
                <Text style={text.strong}>{day.label}</Text>
                {day.pnl !== null ? (
                  <Text
                    style={[
                      text.caption,
                      text.num,
                      day.tone === 'up' && text.up,
                      day.tone === 'down' && text.down,
                    ]}
                  >
                    {day.pnl}
                  </Text>
                ) : null}
              </View>
              <View style={styles.spine}>
                <View style={styles.spineLine} />
                {day.entries.map((entry) => (
                  <SpineEntry key={entry.seq} entry={entry} />
                ))}
              </View>
            </View>
          ))
        )}
      </Section>
    </View>
  );
}

/**
 * One stone on the History spine: the Ledger's grammar (ring = thesis, solid =
 * trade, barred ring = held, half stone = verdict) in a tighter row. Chain
 * facts and the consensus ramp stay on the full Ledger.
 */
function SpineEntry({ entry }: { entry: LedgerEntry }) {
  let head: ReactNode;
  let body: ReactNode = null;
  switch (entry.kind) {
    case 'thesis':
      head = <Text style={styles.kind}>{thesisKind(entry)}</Text>;
      body = entry.thesis ? (
        <Text style={text.voice} numberOfLines={3}>
          {entry.thesis}
        </Text>
      ) : null;
      break;
    case 'trade': {
      const detail = tradeDetail(entry);
      head = <Text style={[text.strong, text.num]}>{tradeHeadline(entry)}</Text>;
      body = detail ? <Text style={[text.dim, text.num]}>{detail}</Text> : null;
      break;
    }
    case 'refusal':
      head = <Pill tone="held" label={heldBy(entry.layer)} />;
      body = entry.message ? <Text style={text.dim}>{entry.message}</Text> : null;
      break;
    case 'verdict': {
      const { lead, pnl, tone } = verdictHeadline(entry);
      head = (
        <Text style={[text.strong, text.num]}>
          {lead}
          {pnl !== null ? (
            <Text style={tone === 'up' ? text.up : tone === 'down' ? text.down : null}>
              {` ${pnl}`}
            </Text>
          ) : null}
        </Text>
      );
      break;
    }
    case 'deposit': {
      const source = depositSource(entry);
      head = <Text style={[text.strong, text.num]}>{depositHeadline(entry)}</Text>;
      body = source ? <Text style={text.mono}>{source}</Text> : null;
      break;
    }
  }
  return (
    <View style={styles.move}>
      <View style={styles.stone}>
        <Stone kind={stoneFor(entry)} size={STONE} />
      </View>
      <View style={styles.moveBody}>
        <View style={styles.moveMeta}>
          <View style={styles.moveHead}>{head}</View>
          <Text style={styles.time}>{clockTime(entry.at).slice(0, 5)}</Text>
        </View>
        {body}
      </View>
    </View>
  );
}

/** The stone's size, and so the spine's offset: the line runs through its centre. */
const STONE = 14;

// ─── Mandate ────────────────────────────────────────────────────────────────

/**
 * Rules, then proof, then the ledger of limits. Order size is Sente's own
 * pre-send check, so it is proof, not a gauge; the gauges are the limits the
 * enclave enforces and that have something to measure against — time. A
 * limit with nothing measuring it (the rolling cap has no usage route yet) is
 * its cap alone, as a row: a made-up fill would be a lie on the screen that
 * has to be trusted.
 */
function MandateCard({
  agent,
  summary,
  now,
  onAmend,
  onReturn,
  onRevoke,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  now: number;
  onAmend: () => void;
  onReturn: () => void;
  onRevoke: () => void;
}) {
  const active = agent.status === 'active';
  const { mandate } = agent;
  const limits = describeMandate(mandate);
  const expiry = expiryUsage(
    summary?.mandateSince ?? Date.parse(agent.createdAt),
    mandate.expiresAt,
    now,
  );
  const made = signedParts(summary?.pnl.allTime);
  const { unit } = pnlUnit(mandate.venues);

  return (
    <View>
      <Card goban style={styles.rulesCard}>
        <View style={styles.between}>
          <Text style={text.label}>The rules</Text>
          <Text style={text.caption}>{mandateSigned(agent.createdAt, summary?.mandateSince)}</Text>
        </View>
        {/* A revoked agent's policy keeps only the way out, so its old rules
            no longer bound anything; stating them would read as live limits. */}
        {active ? (
          <Text style={[text.body, styles.rules]}>
            {rulesSentence(agent).map((part, index) => (
              <Text key={index} style={part.strong ? styles.rulesStrong : null}>
                {part.text}
              </Text>
            ))}
          </Text>
        ) : (
          <Text style={[text.body, styles.rules]}>
            Revoked. Its policy keeps only the way out: funds can go back to you and nowhere else.
          </Text>
        )}
        <View>
          <ProofRow label="Made for you, realised">
            <Text
              style={[
                text.strong,
                text.num,
                made.tone === 'up' && text.up,
                made.tone === 'down' && text.down,
              ]}
            >
              {summary ? `${made.sign}${made.magnitude}${unit ? ` ${unit}` : ''}` : '—'}
            </Text>
          </ProofRow>
          <ProofRow label="Held orders that broke its limits">
            <Pill tone="held" label={`Held ${summary?.held ?? 0}`} />
          </ProofRow>
          <ProofRow label="Largest order" last>
            <Text style={[text.strong, text.num]}>{largestOrderLine(summary, mandate)}</Text>
          </ProofRow>
        </View>
      </Card>

      {active ? (
        <View style={styles.gauges}>
          <Gauge
            label="Expires"
            value={expiry.value}
            used={expiry.used}
            enforcer={limits.find((limit) => limit.id === 'expiresAt')?.enforcer}
          />
          {limits
            .filter((limit) => !NOT_A_ROW.has(limit.id))
            .map((limit) => (
              <LimitRow
                key={limit.id}
                label={limit.label}
                value={limit.value}
                enforcer={limit.enforcer}
              />
            ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        {active ? (
          <>
            <ButtonRow>
              <Button
                label="Amend"
                kind="primary"
                size="sm"
                onPress={onAmend}
                style={styles.grow}
              />
              <Button
                label="Return funds"
                kind="soft"
                size="sm"
                onPress={onReturn}
                style={styles.grow}
              />
              <Button
                label="Revoke"
                kind="danger"
                size="sm"
                onPress={onRevoke}
                style={styles.grow}
              />
            </ButtonRow>
            <Text style={[text.caption, styles.after]}>
              Return sends everything back to your wallet. Revoke stops it for good; its funds stay
              returnable.
            </Text>
          </>
        ) : (
          <ButtonRow>
            <Button
              label="Return funds"
              kind="primary"
              size="sm"
              icon="return"
              onPress={onReturn}
              style={styles.grow}
            />
            {agent.policyCleared === false ? (
              // Clears the old rules from its wallet policy.
              <Button
                label="Revoke again"
                kind="danger"
                size="sm"
                onPress={onRevoke}
                style={styles.grow}
              />
            ) : null}
          </ButtonRow>
        )}
      </View>
    </View>
  );
}

function ProofRow({
  label,
  last = false,
  children,
}: {
  label: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.proof, last && styles.proofLast]}>
      <Text style={[text.dim, styles.grow]}>{label}</Text>
      {children}
    </View>
  );
}

/** A limit with no usage to draw: its cap, and who enforces it — a gauge's head alone. */
function LimitRow({
  label,
  value,
  enforcer,
}: {
  label: string;
  value: string;
  enforcer: Enforcer;
}) {
  return (
    <View style={styles.limit}>
      <View style={styles.limitLabel}>
        <Text style={text.dim}>{label}</Text>
        <EnforcerTag enforcer={enforcer} />
      </View>
      <Text style={[text.strong, text.num, styles.limitValue]}>{value}</Text>
    </View>
  );
}

/** ⋯ → Details: the ids a support question needs, and the instructions the agent runs on. */
function DetailsSheet({
  agent,
  visible,
  onClose,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Details" onClose={onClose}>
      <Row label="Agent" value={agent.id} mono />
      <Row label="Wallet" value={agent.address} mono />
      <Row label="Wallet id" value={agent.walletId} mono />
      <Row label="Policy" value={agent.policyId} mono />
      {agent.erc8004AgentId ? <Row label="ERC-8004" value={agent.erc8004AgentId} mono /> : null}
      {/* The whole address, never shortened: it is the one place its funds can go. */}
      <Row label="Funds return to" value={agent.mandate.returnTo ?? 'Nowhere'} mono />
      <Text style={[text.label, styles.instructions]}>System prompt</Text>
      <Text style={[text.body, styles.prose]} selectable>
        {agent.systemPrompt || '—'}
      </Text>
      <Text style={[text.label, styles.instructions]}>Strategy</Text>
      <Text style={[text.body, styles.prose]} selectable>
        {agent.strategy || '—'}
      </Text>
    </Sheet>
  );
}

/**
 * Funding an agent from the user's own Privy wallet (SEN-42).
 *
 * Nothing about this is a server transfer: the API composes the Privy request,
 * this phone rebuilds it from what is on screen and refuses to sign anything
 * else (`wallet/send.ts`), and Privy pays the gas — so the user needs no MON.
 * It replaces the Kernel UserOperation batch this sheet used to send.
 */
function FundSheet({
  agent,
  visible,
  onClose,
  onSent,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
  onSent: (notice: NoticeState) => void;
}) {
  const { wallet, walletApi, auth } = useSession();
  const [token, setToken] = useState<Token>(FUNDING_TOKENS[0] as Token);
  const [amount, setAmount] = useState('');
  const [available, setAvailable] = useState<bigint | null>(null);
  const [error, setError] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const from = wallet.address;
  useEffect(() => {
    if (!visible || !from) return;
    let cancelled = false;
    setAvailable(null);
    // Read from the chain rather than from `wallet.wallet.balances`: the API
    // reports MON, USDC and AUSD, and this sheet offers every Kuru asset.
    readBalance(token, from).then(
      (balance) => {
        if (!cancelled) setAvailable(balance);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [visible, token, from]);

  const atoms = parseAmount(amount, token.decimals);
  const tooMuch = atoms !== null && available !== null && atoms > available;
  const invalid = amount.trim() !== '' && atoms === null;
  const walletId = wallet.wallet?.walletId;
  const ready = wallet.status === 'ready' && walletId !== undefined;

  const send = async () => {
    if (atoms === null || atoms === 0n || walletId === undefined) return;
    setError(null);
    setBusy(true);
    const label = `${formatAtoms(atoms, token.decimals)} ${token.symbol}`;
    try {
      const sent = await sendSponsored(
        walletApi,
        { walletId, token, to: agent.address, atoms },
        auth.signPrivyAuthorization,
      );
      const status = sent.confirmation?.status ?? sent.status;
      if (status === 'included') {
        setAmount('');
        onSent({ tone: 'ok', title: `Sent ${label} to ${agent.name}` });
      } else if (status === 'reverted') {
        // Gotcha 8: the operation reverted inside a transaction that may well
        // have succeeded. Nothing moved, and saying otherwise would be a lie.
        setError({
          tone: 'error',
          title: 'The transfer reverted',
          detail: 'It was included on chain but didn’t execute, so nothing moved.',
        });
      } else {
        setAmount('');
        onSent({
          tone: 'info',
          title: `Sending ${label}`,
          detail: `Submitted, not confirmed yet (${status}). The balance updates once it lands.`,
        });
      }
    } catch (caught) {
      setError({ tone: 'error', ...describeSendError(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Fund ${agent.name}`} onClose={onClose}>
      <Chips>
        {FUNDING_TOKENS.map((option) => (
          <Chip
            key={option.symbol}
            label={option.symbol}
            selected={option.symbol === token.symbol}
            onPress={() => setToken(option)}
          />
        ))}
      </Chips>
      <Field
        label="Amount"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        suffix={token.symbol}
        placeholder="0"
        error={
          invalid
            ? `Enter an amount with at most ${token.decimals} decimals.`
            : tooMuch
              ? 'More than your account holds.'
              : undefined
        }
        hint={
          from
            ? `Your account holds ${available === null ? '…' : formatAtoms(available, token.decimals)} ${token.symbol}`
            : undefined
        }
      />
      <Row label="From" value={from ? shortAddress(from) : '—'} mono />
      <Row label="To" value={shortAddress(agent.address)} mono />
      <Text style={[text.caption, styles.after]}>
        Your passkey signs this transfer and Sente pays the gas, so you need no MON. Sente holds no
        key that can move your funds — and the agent’s key can only ever send them back to you, with
        the “Return funds” button, whether or not it is still running.
      </Text>
      {!ready ? (
        <Notice
          tone="error"
          title="Your wallet isn’t ready"
          detail={
            wallet.error?.message ?? 'Sign in on the home screen and wait for it to register.'
          }
        />
      ) : null}
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <Button
        label={
          atoms && atoms > 0n
            ? `Approve & send ${formatAtoms(atoms, token.decimals)} ${token.symbol}`
            : 'Approve & send'
        }
        kind="primary"
        busy={busy}
        disabled={!ready || atoms === null || atoms === 0n || tooMuch}
        onPress={() => void send()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

function RunSheet({
  agent,
  visible,
  onClose,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
}) {
  const { agents: api } = useSession();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<NoticeState | null>(null);

  const dismiss = () => {
    setOutcome(null);
    onClose();
  };

  const run = async () => {
    if (!api) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await api.run(agent.id, instruction.trim() || undefined);
      if (result.kind === 'unavailable') {
        setOutcome({
          tone: 'info',
          title: 'Not available yet',
          detail:
            'This server can’t run agents on demand yet. The button starts working once the agent runner ships.',
        });
      } else {
        const { iterations, stopReason, costUsd } = result.result;
        setOutcome({
          tone: 'ok',
          title: 'Run finished',
          detail: `${iterations} steps · stopped on ${stopReason}${costUsd !== undefined ? ` · $${costUsd.toFixed(4)}` : ''}`,
        });
      }
    } catch (error) {
      setOutcome({ tone: 'error', ...describeAgentsError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Run ${agent.name} now`} onClose={dismiss}>
      <Text style={text.dim}>
        One run: the agent reads the markets its mandate allows and decides whether to trade.
        Everything it tries is still checked against the mandate.
      </Text>
      <Field
        label="Instruction (optional)"
        value={instruction}
        onChangeText={setInstruction}
        multiline
        placeholder="e.g. Only rebalance, no new positions."
      />
      {outcome ? (
        <Notice tone={outcome.tone} title={outcome.title} detail={outcome.detail} />
      ) : null}
      <Button
        label="Run now"
        kind="primary"
        icon="bolt"
        busy={busy}
        onPress={() => void run()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

/**
 * RETURNING AN AGENT'S FUNDS TO ITS OWNER (SEN-17).
 *
 * One tap, no signature, no address to type: the destination is the `returnTo`
 * compiled into the agent's enclave policy — this account's own wallet — and the
 * agent's key can sign a transfer to it and to nowhere else. So there is nothing
 * here for the passkey to approve that the policy does not already pin, which is
 * why this sheet is a confirmation and not an approval.
 *
 * It works on a revoked agent, because a revoke leaves those rules in place.
 */
function ReturnSheet({
  agent,
  visible,
  onClose,
  onDone,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
  onDone: (notice: NoticeState) => void;
}) {
  const { agents: api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeState | null>(null);
  const exit = agent.mandate.returnTo;

  const send = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.returnFunds(agent.id);
      const moved = result.assets.filter((asset) => asset.returned?.success);
      const failed = result.assets.filter((asset) => asset.returned && !asset.returned.success);
      const summary = moved.map((asset) => `${asset.returned!.amount} ${asset.asset}`).join(', ');
      if (failed.length > 0) {
        // Gotcha 8's corollary: each leg is its own transaction, so some can land
        // while others revert. Saying "sent" here would be a lie about money.
        setError({
          tone: 'error',
          title: 'Part of it didn’t go through',
          detail:
            `${failed.map((asset) => asset.asset).join(', ')} reverted on chain, so that part ` +
            `didn’t move${summary ? `. ${summary} did` : ''}. Try again.`,
        });
        return;
      }
      onDone(
        moved.length > 0
          ? {
              tone: 'ok',
              title: `Sent ${summary} back to your wallet`,
              detail: `Gas cost the agent ${result.monSpent} MON. Balances update once the chain catches up.`,
            }
          : {
              tone: 'info',
              title: 'There was nothing to send back',
              detail:
                'This agent holds no tokens. Its leftover MON stays with it: no rule lets an ' +
                'agent move native MON, so gas cannot be swept.',
            },
      );
    } catch (caught) {
      setError({ tone: 'error', ...describeAgentsError(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Return ${agent.name}’s funds`} onClose={onClose}>
      <Text style={text.body}>
        Everything this agent holds — in its wallet and as free Kuru collateral — goes back to your
        own wallet. Collateral reserved by a resting order stays until that order is cancelled.
      </Text>
      <Row label="To your wallet" value={exit ? shortAddress(exit) : '—'} mono />
      <Text style={[text.caption, styles.after]}>
        {exit
          ? 'This address is written into the agent’s signing policy, so its key can send funds ' +
            'here and nowhere else — even after the mandate expires or you revoke it.'
          : 'This agent was hired before return-to-owner existed, so its policy has no transfer ' +
            'rule. Amend its mandate and it will carry your wallet.'}
      </Text>
      <Text style={[text.caption, styles.after]}>
        Its leftover MON stays with it: no rule lets an agent move native MON.
      </Text>
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <Button
        label="Return everything"
        kind="primary"
        icon="return"
        busy={busy}
        disabled={!exit}
        onPress={() => void send()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

function RevokeSheet({
  agent,
  visible,
  onClose,
  onDone,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
  onDone: (notice: NoticeState) => void;
}) {
  const { agents: api, auth } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeState | null>(null);
  /**
   * A device-owned agent's policy can only be changed by a PATCH this phone
   * signed (SEN-44): the API asks, the passkey approves. `revokeWithApproval`
   * checks that the PATCH leaves exactly this mandate's way out and nothing the
   * agent could take risk with, before signing anything (SEN-17).
   */
  const signs = needsApproval(agent);
  const [prepared, setPrepared] = useState<PreparedMandateChange | null>(null);

  // Asked for as the sheet opens, not when the button is pressed: the change is
  // then on screen to read (how many rules it leaves), and the passkey prompt is
  // not sitting behind a round trip. Preparing again supersedes this one
  // server-side, so an abandoned sheet leaves nothing committable behind.
  useEffect(() => {
    if (!visible || !signs || !api) return;
    let cancelled = false;
    setPrepared(null);
    api.prepareRevoke(agent.id).then(
      (change) => {
        if (!cancelled) setPrepared(change);
      },
      (caught: unknown) => {
        if (!cancelled) setError({ tone: 'error', ...describeApprovalError(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, signs, api, agent.id]);

  const revoke = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const revoked = signs
        ? await revokeWithApproval(api, agent, auth.signPrivyAuthorization, prepared ?? undefined)
        : await api.revoke(agent.id);
      onDone(
        revoked.policyCleared === false
          ? {
              tone: 'error',
              title: 'Revoked, but the policy isn’t cleared yet',
              detail: 'The agent won’t run again. Revoke again to clear its wallet policy.',
            }
          : {
              tone: 'ok',
              title: `${agent.name} is revoked`,
              detail:
                'It can’t trade or deposit again. You can still send its funds back to your wallet.',
            },
      );
    } catch (caught) {
      if (caught instanceof AgentsApiError && caught.reason === 'wallet_policy_update_failed') {
        // The agent IS revoked; only the enclave policy clear failed.
        onDone({ tone: 'error', ...describeAgentsError(caught) });
      } else {
        setError({ tone: 'error', ...describeApprovalError(caught) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Revoke ${agent.name}?`} onClose={onClose}>
      <Text style={text.body}>
        The agent stops for good, and its signing policy loses every rule it could trade, deposit or
        approve with. This can’t be undone.
      </Text>
      <Text style={[text.dim, styles.after]}>
        What it keeps is the way out: funds stay in its wallet until you send them back with “Return
        funds”, which still works afterwards. Its leftover MON stays with it.
      </Text>
      {signs ? (
        <>
          <Text style={[text.dim, styles.after]}>
            Your passkey signs this. Sente holds no key that can change this agent’s policy, so the
            phone checks that the change leaves nothing but the way home and then approves it.
          </Text>
          <Row
            label="Enclave rules after"
            value={prepared ? `${String(prepared.summary.ruleCount)} — the way out only` : '…'}
          />
        </>
      ) : null}
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <View style={styles.sheetAction}>
        <ButtonRow>
          <Button label="Keep agent" onPress={onClose} style={styles.grow} />
          <Button
            label={signs ? 'Approve & revoke' : 'Revoke permanently'}
            kind="danger"
            busy={busy}
            onPress={() => void revoke()}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  headerText: { flex: 1, gap: 6 },
  name: { fontSize: 28, lineHeight: 32 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  tabs: { marginTop: 18 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Overview
  hero: { marginTop: 18, gap: 4 },
  figure: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 2 },
  pushRight: { marginLeft: 'auto' },
  chart: { marginTop: 10 },
  chartEmpty: { marginTop: 14, marginBottom: 8 },
  stats: { gap: 8, marginTop: 12 },
  statRow: { flexDirection: 'row', gap: 8 },
  revokedAction: { marginTop: 16 },
  reading: { marginTop: 18 },
  positions: { gap: 10 },
  position: { gap: 12 },
  positionTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  positionFig: { alignItems: 'flex-end' },
  track: { height: 6, borderRadius: 3, backgroundColor: color.well, marginVertical: 6 },
  trackSpan: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 3,
    backgroundColor: 'rgba(131, 110, 249, 0.35)',
  },
  trackEntry: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: color.text,
  },
  trackMark: {
    position: 'absolute',
    top: -3,
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    backgroundColor: color.purple,
    borderWidth: 2,
    borderColor: color.purpleHi,
  },
  trackLegend: { flexDirection: 'row', justifyContent: 'space-between' },
  askBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  askField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.well,
  },
  // History
  best: { flexDirection: 'row', gap: 10 },
  bestCard: {
    width: 150,
    gap: 4,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  bestPnl: { fontFamily: font.display, fontSize: 26, lineHeight: 30 },
  day: { marginTop: 18 },
  dayHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  spine: {},
  /** The board line the stones sit on: through their centres, stone to stone. */
  spineLine: {
    position: 'absolute',
    left: STONE / 2 - 0.5,
    top: 8,
    bottom: 8,
    width: 1,
    backgroundColor: color.lineStrong,
  },
  move: { flexDirection: 'row', gap: 14, paddingBottom: 16 },
  stone: {
    marginTop: 4,
    width: STONE,
    height: STONE,
    borderRadius: STONE / 2,
    backgroundColor: color.ink,
  },
  moveBody: { flex: 1, gap: 4 },
  moveMeta: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 22,
  },
  moveHead: { flexShrink: 1 },
  kind: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 22,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  time: { fontFamily: font.chain, fontSize: 11, lineHeight: 22, color: color.textFaint },
  // Mandate
  rulesCard: { marginTop: 16, gap: 12 },
  rules: { color: color.textDim },
  rulesStrong: { fontFamily: font.semibold, color: color.text },
  proof: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  proofLast: { borderBottomWidth: 0 },
  gauges: { gap: 4, marginTop: 18 },
  limit: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  limitLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  limitValue: { fontSize: 14, flexShrink: 1, textAlign: 'right' },
  actions: { marginTop: 18 },
  // Sheets
  instructions: { marginTop: 20 },
  after: { marginTop: 10 },
  prose: { color: color.textDim, marginTop: 6 },
  sheetAction: { marginTop: 20 },
});
