/**
 * Inside a live position (SEN-117, plan U-11): one agent's open position on
 * one market, with its levels drawn on the chart, the P&L, the agent's own
 * "why", when it will next look — and the Ask sheet.
 *
 * Spec: docs/design/trading/cockpit.html, "Inside a live position" (Range
 * Hunter's MON long, Basis Monk's MON-PERP short) and "Asking, not closing".
 *
 * THERE IS NO CLOSE BUTTON, on purpose. Funds given to an agent are the
 * agent's: the user can ask it to act (a run with an instruction), amend the
 * mandate, revoke or return funds, never trade its position for it. "Ask to
 * close" and "Change levels" both open the same sheet, because levels are the
 * agent's instructions, not orders the user owns. The run's entries then land
 * on this screen one by one through `useAgentEvents` — polled, not streamed.
 *
 * Every level says what it is (`levels.ts`): a target that rests on the venue
 * is an ORDER, everything else is WATCHED, checked when the agent runs.
 * Liquidation is Perpl's estimate from our formula and excludes accrued
 * funding, so it is always "est.". An agent with no preset draws no levels.
 *
 * The portfolio and schedule routes may not be deployed yet (B-T10, B-T13):
 * without them the screen still shows the market, the agent's fills and its
 * thesis, and says the position itself cannot be read yet.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  describeAgentsError,
  type Agent,
  type AgentPortfolioDto,
  type AgentScheduleStatusDto,
} from '@/agents/api';
import { rulesSentence, scheduleLine, trackLayout } from '@/agents/cockpit';
import { clockTime, type LedgerEntry } from '@/agents/ledger';
import {
  heldBy,
  stoneFor,
  thesisKind,
  tradeDetail,
  tradeHeadline,
  verdictHeadline,
} from '@/agents/ledgerView';
import { levelsNote, presetLevels, stopAndTarget } from '@/agents/levels';
import {
  askChips,
  askInstruction,
  bestSince,
  chartLevels,
  composeAsk,
  entriesSince,
  fillMarkers,
  findPosition,
  fitsChart,
  latestThesis,
  levelDistances,
  moveLine,
  openedAt,
  roomToLiq,
  sizeLine,
  toggleChip,
  venueFor,
  watchLine,
  type LivePosition,
} from '@/agents/position';
import { useAgentEvents } from '@/agents/useAgentEvents';
import type { KlineInterval } from '@/markets/api';
import { useKlines } from '@/markets/hooks';
import { usePolling } from '@/markets/usePolling';
import { useSession } from '@/session';
import { Chart } from '@/ui/chart/Chart';
import { Pill, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  ButtonRow,
  Chip,
  Chips,
  Field,
  Loading,
  Notice,
  Screen,
  Section,
  Sheet,
  TopBar,
  type NoticeTone,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { AsOf, BigNumber, Levels, PerpTag, SideTag } from '@/ui/trading';

type NoticeState = { tone: NoticeTone; title: string; detail?: string };

/** The brief's live cadence: a position's numbers are worth a request every few seconds. */
const PORTFOLIO_MS = 5_000;
const SCHEDULE_MS = 60_000;

/**
 * Spot is watched on 5m candles (a range trade lives for hours), a perp on 4h
 * (a funding carry lives for days) — the two study screens' choices.
 */
const CHART: Record<'kuru' | 'perpl', { interval: KlineInterval; limit: number }> = {
  kuru: { interval: '5m', limit: 72 },
  perpl: { interval: '4h', limit: 48 },
};

/** What the ask sheet is opened for: the footer's two buttons pre-fill it differently. */
type AskIntent = 'ask' | 'close' | 'levels';

/** One ask in flight or finished: its words, where the log stood, and how it ended. */
type AskedRun = { words: string; at: number; afterSeq: number; outcome: NoticeState | null };

export default function AgentPositionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; symbol: string; venue?: string }>();
  const id = params.id;
  const symbol = decodeURIComponent(params.symbol ?? '');
  const venue = venueFor(symbol, params.venue);
  const { agents: api } = useSession();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState<NoticeState | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [asking, setAsking] = useState<AskIntent | null>(null);
  const [asked, setAsked] = useState<AskedRun | null>(null);

  const events = useAgentEvents(id);

  useFocusEffect(
    useCallback(() => {
      if (!api || !id) return;
      api.get(id).then(
        (fresh) => {
          setAgent(fresh);
          setLoadError(null);
        },
        (error: unknown) => setLoadError({ tone: 'error', ...describeAgentsError(error) }),
      );
    }, [api, id]),
  );

  // Wrapped so "the route is not deployed" (`null`) stays distinct from
  // "not read yet" (no data), which `usePolling` would otherwise conflate.
  const held = usePolling<{ dto: AgentPortfolioDto | null; asOf: number }>(
    api && id ? `agent-portfolio:${id}` : null,
    async () => {
      const dto = await api!.portfolio(id);
      return { dto, asOf: dto?.asOf ?? Date.now() };
    },
    { intervalMs: PORTFOLIO_MS },
  );
  const cadence = usePolling<{ dto: AgentScheduleStatusDto | null; asOf: number }>(
    api && id ? `agent-schedule:${id}` : null,
    async () => ({ dto: await api!.schedule(id), asOf: Date.now() }),
    { intervalMs: SCHEDULE_MS },
  );
  const { interval, limit } = CHART[venue];
  const klines = useKlines(venue, symbol, interval, { limit });

  const portfolio = held.data?.dto ?? null;
  const position = useMemo(
    () => (portfolio ? findPosition(portfolio, events.entries, agent?.preset, symbol) : null),
    [portfolio, events.entries, agent?.preset, symbol],
  );
  const candles = useMemo(() => klines.data?.klines ?? [], [klines.data]);
  const levels = useMemo(() => {
    if (!position?.entry) return [];
    const since = openedAt(events.entries, symbol, position.side);
    return presetLevels(agent?.preset, {
      entry: position.entry,
      side: position.side,
      liq: position.liq,
      extreme: bestSince(candles, since, position.side),
    });
  }, [position, agent?.preset, events.entries, symbol, candles]);
  const markers = useMemo(
    () => fillMarkers(events.entries, symbol, candles),
    [events.entries, symbol, candles],
  );
  const thesis = latestThesis(events.entries, symbol);

  const backToAgent = () =>
    router.canGoBack() ? router.back() : router.replace(`/agents/${id ?? ''}`);

  if (!agent) {
    return (
      <Screen>
        <TopBar back={{ label: 'Agent', onPress: backToAgent }} />
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
  const hasStop = levels.some((level) => level.role === 'stop');
  const scrubbed = scrub !== null ? candles[scrub]?.close : undefined;
  const mark = scrubbed ?? position?.mark ?? candles[candles.length - 1]?.close ?? null;
  const running = asked !== null && asked.outcome === null;

  return (
    <Screen
      refreshing={false}
      onRefresh={() => {
        held.refresh();
        klines.refresh();
      }}
      footer={
        active ? (
          <Footer
            hasLevels={levels.length > 0}
            hasPosition={position !== null}
            busy={running}
            agentName={agent.name}
            onAsk={setAsking}
          />
        ) : undefined
      }
    >
      <TopBar
        back={{ label: agent.name, onPress: backToAgent }}
        right={
          running ? (
            <Pill label="Running" tone="live" />
          ) : portfolio ? (
            <AsOf at={held.asOf} paused={held.stale} />
          ) : null
        }
      />

      <Header symbol={symbol} position={position} mark={mark} />

      <View style={styles.chart}>
        {candles.length > 1 ? (
          <Chart
            kind={venue === 'perpl' ? 'candles' : 'line'}
            points={venue === 'kuru' ? candles.map((kline) => kline.close) : undefined}
            klines={venue === 'perpl' ? candles : undefined}
            levels={chartLevels(position?.entry ?? null, levels, position?.liq ?? null)}
            markers={markers}
            height={venue === 'perpl' ? 190 : 218}
            fit={fitsChart(position?.mark ?? null, position?.liq ?? null)}
            // The agent's position, not the user's own: the line is purple.
            tone={venue === 'kuru' ? 'purple' : 'auto'}
            onScrub={setScrub}
            label={`${symbol} ${interval} with ${agent.name}’s levels`}
          />
        ) : (
          <Text style={text.caption}>
            {klines.unavailable
              ? 'Price history isn’t available on this server yet.'
              : klines.error
                ? 'Couldn’t read the price history.'
                : 'Reading the price history…'}
          </Text>
        )}
      </View>

      {asked ? <ThisRun asked={asked} entries={events.entries} agentName={agent.name} /> : null}

      {position ? (
        <PositionBody position={position} levels={levels} />
      ) : (
        <Text style={[text.dim, styles.block]}>
          {held.data === null
            ? held.error
              ? 'Couldn’t read its position just now.'
              : 'Reading its position…'
            : portfolio === null
              ? 'This server can’t report agent positions yet, so only the market, its fills and its words are here.'
              : `${agent.name} holds nothing on ${symbol} now.`}
        </Text>
      )}

      {thesis ? (
        <View style={[styles.why, styles.block]}>
          <Text style={text.label}>Why it’s in</Text>
          <Text style={text.voice}>{thesis.thesis}</Text>
          {thesis.invalidation ? (
            <Text style={text.caption}>Wrong if {lowerFirst(thesis.invalidation)}</Text>
          ) : null}
        </View>
      ) : null}

      {active ? (
        <View style={[styles.next, styles.block]}>
          <Icon name="bolt" size={16} color={color.textDim} />
          <Text style={[text.dim, styles.grow]}>
            {scheduleLine(cadence.data?.dto ?? null, agent.schedule, Date.now())}
            {watchLine(levels) ? ` ${watchLine(levels)}` : ''}
          </Text>
        </View>
      ) : (
        <Notice
          title="Revoked"
          detail="It won’t run again, so it can’t be asked to act on this position. Its funds can still go back to you from the agent screen."
        />
      )}

      <AskSheet
        key={asking ?? 'closed'}
        agent={agent}
        symbol={symbol}
        position={position}
        hasStop={hasStop}
        intent={asking}
        onClose={() => setAsking(null)}
        onSent={(words) => {
          setAsking(null);
          const afterSeq = events.entries[events.entries.length - 1]?.seq ?? 0;
          setAsked({ words, at: Date.now(), afterSeq, outcome: null });
        }}
        onDone={(outcome) => {
          setAsked((current) => (current ? { ...current, outcome } : current));
          held.refresh();
        }}
      />
    </Screen>
  );
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// ─── Header and body ────────────────────────────────────────────────────────

function Header({
  symbol,
  position,
  mark,
}: {
  symbol: string;
  position: LivePosition | null;
  mark: string | null;
}) {
  const move = position ? moveLine(position) : null;
  return (
    <View style={styles.header}>
      <View style={styles.between}>
        <View style={styles.grow}>
          <View style={styles.inline}>
            <Text style={text.title}>{symbol}</Text>
            {position ? <SideTag side={position.side} /> : null}
            {position?.leverage ? <PerpTag leverage={position.leverage} /> : null}
          </View>
          {position ? <Text style={[text.caption, text.num]}>{sizeLine(position)}</Text> : null}
        </View>
        {position ? (
          <View style={styles.figure}>
            <Text style={text.caption}>Unrealised</Text>
            <BigNumber
              value={position.pnl ?? '—'}
              size="md"
              style={position.tone === 'up' ? text.up : position.tone === 'down' ? text.down : null}
            />
          </View>
        ) : null}
      </View>
      <View style={styles.between}>
        <Text style={text.dim}>
          Mark <Text style={text.num}>{mark ?? '—'}</Text>
        </Text>
        {move ? (
          <Text
            style={[
              text.dim,
              text.num,
              move.tone === 'up' && text.up,
              move.tone === 'down' && text.down,
            ]}
          >
            {move.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function PositionBody({
  position,
  levels,
}: {
  position: LivePosition;
  levels: ReturnType<typeof presetLevels>;
}) {
  const pair = stopAndTarget(levels);
  const target = levels.find((level) => level.role === 'target')?.price ?? null;
  const stop = levels.find((level) => level.role === 'stop')?.price ?? null;
  const note = levelsNote(levels, position.venue);
  const track =
    pair && position.entry && position.mark
      ? trackLayout(pair, position.entry, position.mark)
      : null;
  const distances = levelDistances(levels, position.mark, position.side);
  const room = roomToLiq(position.entry, position.mark, position.liq);

  return (
    <View style={styles.block}>
      {note ? (
        <View style={styles.note}>
          <Icon name="shield" size={14} color={color.textDim} />
          <Text style={[text.caption, styles.grow]}>{note}</Text>
        </View>
      ) : null}

      <View style={styles.levels}>
        <Levels entry={position.entry} target={target} stop={stop} liq={position.liq} />
      </View>

      {track ? (
        <View style={styles.block}>
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
          <View style={styles.between}>
            {distances.map((each) => (
              <Text
                key={each.role}
                style={[text.caption, text.num, each.role === 'stop' ? text.down : text.up]}
              >
                {each.text}
              </Text>
            ))}
          </View>
        </View>
      ) : distances.length > 0 ? (
        <Text style={[text.caption, text.num, styles.block]}>
          {distances.map((each) => each.text).join(' · ')}
        </Text>
      ) : null}

      {room ? (
        <View style={styles.block}>
          <View style={styles.between}>
            <Text style={text.dim}>Room to liq. est</Text>
            <Text style={[text.strong, text.num]}>{room.room}</Text>
          </View>
          {/* Purple, not mint: it is risk, not P&L. The cap tick is berry — liquidation is a loss. */}
          <View style={styles.meter}>
            <View style={[styles.meterFill, { width: `${room.fill * 100}%` }]} />
            <View style={styles.meterCap} />
          </View>
          <View style={styles.between}>
            <Text style={[text.caption, text.num]}>mark {position.mark ?? '—'}</Text>
            <Text style={[text.caption, text.num, text.down]}>liq. est {position.liq}</Text>
          </View>
        </View>
      ) : null}

      {position.venue === 'perpl' ? (
        <View style={styles.block}>
          <View style={styles.kv}>
            <KeyValue
              label="Margin · isolated"
              value={position.margin ? `${position.margin} AUSD` : '—'}
            />
            <KeyValue
              label="Funding paid"
              value={position.fundingPaid !== null ? `${position.fundingPaid} AUSD` : '—'}
            />
          </View>
          <Text style={[text.caption, styles.block]}>
            Liq. est is ours and excludes accrued funding. Isolated margin can’t be topped up: to
            save a position the agent has to close and reopen it.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.kvCell}>
      <Text style={text.caption}>{label}</Text>
      <Text style={[text.strong, text.num]}>{value}</Text>
    </View>
  );
}

// ─── Footer and the Ask sheet ───────────────────────────────────────────────

/** No close button: asking is the only way to act on an agent's position. */
function Footer({
  hasLevels,
  hasPosition,
  busy,
  agentName,
  onAsk,
}: {
  hasLevels: boolean;
  hasPosition: boolean;
  busy: boolean;
  agentName: string;
  onAsk: (intent: AskIntent) => void;
}) {
  if (!hasPosition) {
    return (
      <Button
        label={`Ask ${agentName}`}
        kind="primary"
        icon="bolt"
        busy={busy}
        onPress={() => onAsk('ask')}
      />
    );
  }
  return (
    <ButtonRow>
      {hasLevels ? (
        <Button
          label="Change levels"
          kind="soft"
          onPress={() => onAsk('levels')}
          style={styles.grow}
        />
      ) : null}
      <Button
        label="Ask to close"
        kind="primary"
        busy={busy}
        onPress={() => onAsk('close')}
        style={styles.grow}
      />
    </ButtonRow>
  );
}

function AskSheet({
  agent,
  symbol,
  position,
  hasStop,
  intent,
  onClose,
  onSent,
  onDone,
}: {
  agent: Agent;
  symbol: string;
  position: LivePosition | null;
  hasStop: boolean;
  intent: AskIntent | null;
  onClose: () => void;
  onSent: (words: string) => void;
  onDone: (outcome: NoticeState) => void;
}) {
  const { agents: api } = useSession();
  const chips = useMemo(() => askChips(position, hasStop), [position, hasStop]);
  // The parent keys this sheet by intent, so each opening starts from its
  // button's suggestion rather than from the last ask.
  const [selected, setSelected] = useState<string[]>(() =>
    intent === 'close' ? ['close-all'] : [],
  );
  const [words, setWords] = useState(() =>
    intent === 'levels' ? 'Move your levels: ' : composeAsk(selected, chips),
  );

  const pick = (key: string) => {
    const next = toggleChip(selected, key, chips);
    setSelected(next);
    setWords(composeAsk(next, chips));
  };

  const send = () => {
    if (!api || !words.trim()) return;
    const said = words.trim();
    onSent(said);
    // The sheet closes at once: the run's entries land on the screen behind it.
    api.run(agent.id, askInstruction(position, symbol, said)).then(
      (result) =>
        onDone(
          result.kind === 'unavailable'
            ? {
                tone: 'info',
                title: 'Not available yet',
                detail: 'This server can’t run agents on demand yet.',
              }
            : {
                tone: 'ok',
                title: 'Run finished',
                detail: `${result.result.iterations} steps · stopped on ${result.result.stopReason}`,
              },
        ),
      (error: unknown) => onDone({ tone: 'error', ...describeAgentsError(error) }),
    );
  };

  const rules = rulesSentence(agent)
    .map((part) => part.text)
    .join('');

  return (
    <Sheet visible={intent !== null} title={`Ask ${agent.name}`} onClose={onClose}>
      <Text style={text.dim}>
        {position
          ? `About its ${position.side} ${position.base} · ${position.size}. `
          : `About ${symbol}. `}
        It runs now with your words as its instruction, then decides what to do.
      </Text>
      <Field
        label="Your words"
        value={words}
        onChangeText={setWords}
        multiline
        placeholder="e.g. Close half and move the stop to break-even"
      />
      <Chips>
        {chips.map((chip) => (
          <Chip
            key={chip.key}
            label={chip.label}
            selected={selected.includes(chip.key)}
            onPress={() => pick(chip.key)}
          />
        ))}
      </Chips>
      <View style={styles.reminder}>
        <Icon name="shield" size={16} color={color.purpleHi} />
        <Text style={[text.dim, styles.grow]}>
          It can only act inside its mandate. {rules} It may decline, and will say why.
        </Text>
      </View>
      <View style={styles.between}>
        <Text style={text.caption}>One run · spends model credits</Text>
        <Text style={text.caption}>Starts now</Text>
      </View>
      <Button
        label="Run it now with this"
        kind="primary"
        icon="bolt"
        disabled={!words.trim()}
        onPress={send}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

// ─── The run lands ──────────────────────────────────────────────────────────

/**
 * Your words as a bubble (Geist, you), then what the run added to the log
 * (the agent's mono voice for its thesis, it), newest last. It looks streamed but is
 * polled, so the header says how fresh it is rather than promising a socket.
 */
function ThisRun({
  asked,
  entries,
  agentName,
}: {
  asked: AskedRun;
  entries: readonly LedgerEntry[];
  agentName: string;
}) {
  const fresh = entriesSince(entries, asked.afterSeq);
  return (
    <Section label="This run">
      <View style={styles.youSaid}>
        <Text style={text.caption}>You asked · {clockTime(asked.at)}</Text>
        <Text style={text.body}>{asked.words}</Text>
      </View>
      {fresh.map((entry) => (
        <RunEntry key={entry.seq} entry={entry} />
      ))}
      {asked.outcome ? (
        <Notice
          tone={asked.outcome.tone}
          title={asked.outcome.title}
          detail={asked.outcome.detail}
        />
      ) : (
        <Text style={text.caption}>
          {fresh.length === 0 ? `${agentName} is reading the market…` : 'Still running…'}
        </Text>
      )}
    </Section>
  );
}

function RunEntry({ entry }: { entry: LedgerEntry }) {
  let head: ReactNode = null;
  let body: ReactNode = null;
  switch (entry.kind) {
    case 'thesis':
      head = <Text style={styles.kind}>{thesisKind(entry)}</Text>;
      body = entry.thesis ? <Text style={text.voice}>{entry.thesis}</Text> : null;
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
            <Text
              style={tone === 'up' ? text.up : tone === 'down' ? text.down : null}
            >{` ${pnl}`}</Text>
          ) : null}
        </Text>
      );
      break;
    }
    case 'deposit':
      return null;
  }
  return (
    <View style={styles.move}>
      <View style={styles.stone}>
        <Stone kind={stoneFor(entry)} size={14} />
      </View>
      <View style={styles.moveBody}>
        <View style={styles.between}>
          <View style={styles.grow}>{head}</View>
          <Text style={styles.time}>{clockTime(entry.at)}</Text>
        </View>
        {body}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  between: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  block: { marginTop: 14 },
  header: { gap: 6, marginTop: 4 },
  figure: { alignItems: 'flex-end' },
  chart: { marginTop: 12 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  levels: { marginTop: 2 },
  track: { height: 6, borderRadius: 3, backgroundColor: color.well, marginVertical: 8 },
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
  meter: {
    height: 6,
    borderRadius: 3,
    backgroundColor: color.well,
    marginVertical: 8,
    overflow: 'hidden',
  },
  meterFill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: color.purple },
  meterCap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 2,
    backgroundColor: color.berry,
  },
  kv: { flexDirection: 'row', gap: 10 },
  kvCell: { flex: 1, gap: 2, padding: 12, borderRadius: RADIUS.well, backgroundColor: color.well },
  why: { gap: 6 },
  next: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  reminder: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: 'rgba(131, 110, 249, 0.10)',
  },
  sheetAction: { marginTop: 16 },
  youSaid: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    gap: 2,
    padding: 12,
    marginBottom: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  move: { flexDirection: 'row', gap: 14, paddingBottom: 14 },
  stone: { marginTop: 4, width: 14, height: 14 },
  moveBody: { flex: 1, gap: 4 },
  kind: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 22,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  time: { fontFamily: font.chain, fontSize: 11, lineHeight: 22, color: color.textFaint },
});
