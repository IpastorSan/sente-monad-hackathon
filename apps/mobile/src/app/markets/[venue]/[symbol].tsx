/**
 * One market (SEN-112, plan U-6; the study's `markets.html` → "Spot asset:
 * MON on Kuru", "Perp asset: ETH-PERP on Perpl" and "Edge: prices stop
 * updating"). Markets rows and search push here.
 *
 * Top to bottom: the price, written by the chart's scrub so the two can't
 * disagree; the chart with its ranges and a line/candles toggle; the change
 * grid; your position; the agents of yours allowed to trade this market; the
 * market's stats (and funding, for a perp); the book's pressure; the latest
 * fills here, yours and your agents', which are also the chart's stones
 * (SEN-157). Sell/Buy
 * (Short/Long) stay pinned at the bottom, and once the hero scrolls away the
 * price condenses into a header so Buy is never pressed blind.
 *
 * "Your position" waits on `GET /portfolio` (M-T19) and says so in code
 * rather than faking it; Sell/Buy open the ticket only when
 * `useTradingEnabled` says trading is on (SEN-119). Every choice with a rule
 * behind it is in `markets/asset.ts`, under test; this file only lays out.
 */
import * as Haptics from '@/platform/haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Agent } from '@/agents/api';
import type { KlineDto, MarketDto, VenueId } from '@/markets/api';
import {
  agentsFills,
  agentsFor,
  agentStake,
  assetHeader,
  bookSums,
  changeGrid,
  compactAmount,
  defaultView,
  fillLine,
  fillMarkers,
  fillWhen,
  fundingView,
  GRID_QUERY,
  headline,
  linePoints,
  livePrice,
  mergeFills,
  parseVenue,
  placesFor,
  PRESSURE_LEVELS,
  rangeQuery,
  rangesFor,
  signedAmount,
  statRows,
  windowBase,
  yourFills,
  type AgentStake,
  type AssetRange,
  type ChartKind,
  type MarketFill,
} from '@/markets/asset';
import { useDepth, useKlines, useMarkets, useTicker } from '@/markets/hooks';
import { flipFavourite, readFavourites } from '@/markets/localLists';
import { marketKey } from '@/markets/select';
import { usePolling } from '@/markets/usePolling';
import { useSession } from '@/session';
import { isUnavailable, TradeApiError } from '@/trade/api';
import { useTradingEnabled } from '@/trade/useTradingEnabled';
import { Chart } from '@/ui/chart/Chart';
import { Sigil, Stone } from '@/ui/goban';
import { Button, Card, Loading, Notice, Section, Sheet, TopBar } from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';
import {
  AsOf,
  BigNumber,
  ChangeText,
  PerpTag,
  PressureBar,
  RangePills,
  TokenGlyph,
} from '@/ui/trading';
import { formatPrice, pctDirection, pressureSplit } from '@/ui/tradingFormat';

/** Past this scroll offset the hero is gone and the condensed header takes over. */
const HERO_HEIGHT = 170;
const CHART_HEIGHT = 210;
const CTA_HEIGHT = 50;
/** A stable empty series, so the line's memo holds before the first answer. */
const NO_BARS: readonly KlineDto[] = [];

export default function AssetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ venue?: string; symbol?: string }>();
  const venue = parseVenue(params.venue);
  const symbol = typeof params.symbol === 'string' ? params.symbol : '';
  const markets = useMarkets();

  const market = useMemo(
    () => markets.data?.markets.find((m) => m.venue === venue && m.symbol === symbol) ?? null,
    [markets.data, venue, symbol],
  );
  const back = () => (router.canGoBack() ? router.back() : router.replace('/markets'));

  if (venue === null || symbol === '') {
    return <Missing onBack={back} title="There's no such market" />;
  }
  if (market === null) {
    if (markets.unavailable) {
      return (
        <Missing
          onBack={back}
          title="Markets aren't on this server yet"
          detail="The API this app is talking to predates the markets list."
        />
      );
    }
    if (markets.data !== null) {
      return (
        <Missing
          onBack={back}
          title={`${symbol} isn't listed`}
          detail="It may have been delisted, or its venue isn't answering right now."
        />
      );
    }
    if (markets.error) {
      return (
        <Missing onBack={back} title="Couldn't load this market" detail={markets.error.message} />
      );
    }
    return <Missing onBack={back} loading />;
  }
  // Keyed on the market so ranges, scrub and favourites never leak from one market to the next.
  return <Asset key={marketKey(market)} market={market} venue={venue} onBack={back} />;
}

function Asset({
  market,
  venue,
  onBack,
}: {
  market: MarketDto;
  venue: VenueId;
  onBack: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const header = assetHeader(market);
  const initial = defaultView(market);
  const [range, setRange] = useState<AssetRange>(initial.range);
  const [kind, setKind] = useState<ChartKind>(initial.kind);
  const [scrub, setScrub] = useState<number | null>(null);
  const [condensed, setCondensed] = useState(false);
  const [gated, setGated] = useState(false);

  const ticker = useTicker(venue, market.symbol);
  const klines = useKlines(venue, market.symbol, rangeQuery(range).interval, {
    limit: rangeQuery(range).limit,
  });
  const grid = useKlines(venue, market.symbol, GRID_QUERY.interval, { limit: GRID_QUERY.limit });
  const depth = useDepth(venue, market.symbol, PRESSURE_LEVELS);
  const [starred, toggleStar] = useFavourite(marketKey(market));
  const agents = useAgentsTrading(market);
  const position = useYourPositionUntilPortfolio(market);
  const trading = useTradingEnabled();
  const fills = useMarketFills(market, trading);

  const bars = klines.data?.klines ?? NO_BARS;
  const markers = useMemo(() => fillMarkers(fills.all, bars), [fills.all, bars]);
  const recentFills = useMemo(
    () => mergeFills(fills.yours, fills.agents),
    [fills.yours, fills.agents],
  );
  const live = livePrice(ticker.data);
  const head = headline(bars, live, range, scrub);
  const places = placesFor(market, head.price);
  const points = useMemo(() => linePoints(bars, live), [bars, live]);
  const cells = changeGrid(grid.data?.klines ?? [], live, ticker.data);
  const stats = statRows(market, ticker.data);
  const funding = header.perp && ticker.data ? fundingView(ticker.data.funding, Date.now()) : null;
  const sums = depth.data ? bookSums(depth.data) : null;
  const prevClose = windowBase(bars) ?? undefined;

  const refresh = () => {
    ticker.refresh();
    klines.refresh();
    grid.refresh();
    depth.refresh();
    fills.refresh();
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const past = e.nativeEvent.contentOffset.y > HERO_HEIGHT;
    if (past !== condensed) setCondensed(past);
  };

  const trade = (side: 'sell' | 'buy') => {
    if (!trading) {
      setGated(true);
      return;
    }
    // The ticket (SEN-119) opens only once the capability says so.
    router.push({
      pathname: '/trade/[venue]/[symbol]',
      params: { venue, symbol: market.symbol, side },
    });
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + CTA_HEIGHT + 40 }]}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refresh}
            tintColor={color.purpleHi}
            colors={[color.purple]}
            progressBackgroundColor={color.board}
          />
        }
      >
        <TopBar
          back={{ label: 'Markets', onPress: onBack }}
          right={<StarButton starred={starred} onPress={toggleStar} symbol={market.symbol} />}
        />

        <View style={styles.identity}>
          <TokenGlyph symbol={market.base} />
          <View style={styles.grow}>
            <Text style={text.title} numberOfLines={1}>
              {header.title}
              {header.perp ? ' ' : null}
              {header.perp ? <PerpTag leverage={market.maxLeverage} /> : null}
            </Text>
            <Text style={text.caption}>{header.caption}</Text>
          </View>
          <AsOf at={ticker.asOf} paused={ticker.stale} />
        </View>

        {ticker.stale && ticker.data ? (
          <View style={styles.banner}>
            <Notice
              title={`${venue === 'kuru' ? 'Kuru' : 'Perpl'} prices paused`}
              detail="Showing the last ones we got and retrying. A ticket re-quotes before you confirm, so a stale price can't fill you."
            />
          </View>
        ) : null}

        <View style={styles.priceLine}>
          <BigNumber value={head.price ?? '—'} places={places} />
          <Text style={styles.unit}>{header.unit}</Text>
        </View>
        <ChangeText pct={head.pct} suffix={head.suffix} />
        {header.perp && ticker.data ? (
          <View style={styles.markIndex}>
            <MarkIndex label="Mark" value={ticker.data.mark} tick={market.tickSize} />
            <MarkIndex label="Index" value={ticker.data.index} tick={market.tickSize} />
          </View>
        ) : null}

        <View style={styles.chart}>
          {bars.length > 1 ? (
            <Chart
              kind={kind}
              points={kind === 'line' ? points : undefined}
              klines={kind === 'candles' ? bars : undefined}
              levels={position?.levels}
              markers={markers}
              prevClose={kind === 'line' ? prevClose : undefined}
              height={CHART_HEIGHT}
              // A perp's liquidation line sits far from the price; with `fit`
              // it would squash the candles into a strip, so it becomes an
              // edge chip instead.
              fit={!header.perp}
              onScrub={setScrub}
              label={`${market.symbol} price, ${range}`}
            />
          ) : (
            <View style={[styles.chartEmpty, { height: CHART_HEIGHT }]}>
              {klines.unavailable ? (
                <Text style={text.caption}>Charts aren't on this server yet.</Text>
              ) : klines.error && !klines.data ? (
                <Text style={text.caption}>Couldn't load the chart. Pull to retry.</Text>
              ) : klines.data ? (
                <Text style={text.caption}>No trades in this range yet.</Text>
              ) : (
                <Loading />
              )}
            </View>
          )}
        </View>
        <RangePills
          options={rangesFor(market)}
          value={range}
          onChange={(next) => {
            // A scrub index belongs to the series it was taken on.
            setScrub(null);
            setRange(next);
          }}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={kind === 'line' ? 'Show candles' : 'Show line'}
              onPress={() => {
                setScrub(null);
                setKind(kind === 'line' ? 'candles' : 'line');
              }}
              hitSlop={6}
              style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
            >
              <Text style={styles.toggleText}>{kind === 'line' ? 'Candles' : 'Line'}</Text>
            </Pressable>
          }
        />

        <View style={styles.tfGrid}>
          {cells.map((cell) => (
            <View key={cell.label} style={[styles.tf, cell.primary && styles.tfOn]}>
              <Text style={text.caption}>{cell.label}</Text>
              <ChangeText pct={cell.pct} style={styles.tfValue} />
            </View>
          ))}
        </View>

        {funding ? (
          <View style={styles.funding}>
            <View>
              <Text style={text.caption}>Funding · {funding.payer}</Text>
              <Text style={[text.strong, text.num]}>{funding.rate}</Text>
            </View>
            {funding.nextIn ? (
              <View style={styles.right}>
                <Text style={text.caption}>Next in</Text>
                <Text style={[text.strong, text.num]}>{funding.nextIn}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {agents !== null && agents.length > 0 ? (
          <Section
            label={`Agents trading ${header.title}`}
            aside={<Text style={text.caption}>{agents.length} of yours</Text>}
          >
            <View style={styles.agents}>
              {agents.map(({ agent, stake }) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  stake={stake}
                  unit={header.unit}
                  onPress={() =>
                    router.push({ pathname: '/agents/[id]', params: { id: agent.id } })
                  }
                />
              ))}
            </View>
          </Section>
        ) : null}

        {stats.length > 0 ? (
          <Section label="Market">
            {stats.map((row, i) => (
              <View key={row.label} style={[styles.stat, i < stats.length - 1 && styles.divider]}>
                <Text style={text.dim}>{row.label}</Text>
                <Text style={[text.body, text.num]}>{row.value}</Text>
              </View>
            ))}
          </Section>
        ) : null}

        {sums && !depth.unavailable ? (
          <Section
            label="Order book pressure"
            aside={<Text style={styles.asofText}>top {PRESSURE_LEVELS} levels</Text>}
          >
            <PressureBar bids={sums.bids} asks={sums.asks} legend={false} />
            <View style={styles.pressureLegend}>
              <PressureSide side="Bids" sums={sums} unit={market.base} />
              <PressureSide side="Asks" sums={sums} />
            </View>
          </Section>
        ) : null}

        {recentFills.length > 0 ? (
          <Section label={`Fills on ${header.title}`}>
            {recentFills.map((fill, i) => (
              <FillRow
                key={fill.key}
                fill={fill}
                tick={market.tickSize}
                divider={i < recentFills.length - 1}
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>

      {condensed ? (
        <View style={[styles.minihead, { top: insets.top }]}>
          <Pressable hitSlop={12} onPress={onBack} accessibilityLabel="Back to Markets">
            <Text style={styles.miniBack}>‹</Text>
          </Pressable>
          <TokenGlyph symbol={market.base} size="sm" />
          <Text style={[text.strong, styles.grow]} numberOfLines={1}>
            {header.perp ? market.symbol : header.title}
          </Text>
          <Text style={[text.strong, text.num]}>
            {formatPrice(live ?? '', market.tickSize) ?? '—'}
          </Text>
          <ChangeText pct={cells.find((c) => c.primary)?.pct ?? null} style={styles.miniChange} />
        </View>
      ) : null}

      <View style={[styles.cta, { paddingBottom: insets.bottom + 12 }]}>
        <SideButton label={header.actions[0]} tone="short" onPress={() => trade('sell')} />
        <SideButton label={header.actions[1]} tone="long" onPress={() => trade('buy')} />
      </View>

      <Sheet
        visible={gated}
        title="Trading from your wallet is coming"
        onClose={() => setGated(false)}
      >
        <Text style={text.body}>
          Soon you'll {header.perp ? 'go long or short' : 'buy and sell'} {header.title} here
          yourself, from your own wallet. Until then, an agent can trade {market.symbol} for you,
          inside a mandate the enclave enforces.
        </Text>
        <Button
          label={`Hire an agent for ${header.title}`}
          kind="primary"
          onPress={() => {
            setGated(false);
            router.push('/agents?segment=presets');
          }}
        />
      </Sheet>
    </View>
  );
}

// ─── Stubs for routes that don't exist yet ─────────────────────────────────

/**
 * STUB (SEN-112) until `GET /portfolio` (plan M-T19) is built: the user's own
 * position, open orders and fills in this market, and the levels they put on
 * the chart. It returns `null`, which hides "Your position" entirely — an
 * empty card would claim you hold nothing, which we don't know.
 */
function useYourPositionUntilPortfolio(
  _market: MarketDto,
): { levels: { price: string; kind: 'entry' | 'liq' | 'limit'; label: string }[] } | null {
  return null;
}

// ─── Data hooks ─────────────────────────────────────────────────────────────

/** The star: the device-local favourites the Markets tab filters on. */
function useFavourite(key: ReturnType<typeof marketKey>): [boolean, () => void] {
  const [starred, setStarred] = useState(false);
  useFocusEffect(
    useCallback(() => {
      void readFavourites().then((set) => setStarred(set.has(key)));
    }, [key]),
  );
  const toggle = useCallback(() => {
    void Haptics.selectionAsync();
    void flipFavourite(key).then((set) => setStarred(set.has(key)));
  }, [key]);
  return [starred, toggle];
}

type AgentRow = { agent: Agent; stake: AgentStake };

/**
 * Your agents allowed to trade this market, each with its stake from its own
 * portfolio (B-T10). Kept cheap: only agents whose mandate names the market
 * are asked for a portfolio, once per visit, not polled. `null` until read;
 * a failed list is an empty section, not an error — this page is about the
 * market, and the Agents tab owns agent errors.
 */
function useAgentsTrading(market: MarketDto): AgentRow[] | null {
  const { agents: api } = useSession();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  // Read through a ref: `/markets` re-polls and hands back a new object for the
  // same market, which must not refetch every agent's portfolio.
  const marketRef = useRef(market);
  marketRef.current = market;
  const key = marketKey(market);

  useFocusEffect(
    useCallback(() => {
      if (!api) return;
      let live = true;
      void (async () => {
        const current = marketRef.current;
        let all: Agent[];
        try {
          all = await api.list();
        } catch {
          if (live) setRows([]);
          return;
        }
        const mine = agentsFor(all, current);
        const portfolios = await Promise.all(
          mine.map((agent) => api.portfolio(agent.id).catch(() => null)),
        );
        if (live) {
          setRows(
            mine.map((agent, i) => ({ agent, stake: agentStake(portfolios[i] ?? null, current) })),
          );
        }
      })();
      return () => {
        live = false;
      };
    }, [api, key]),
  );
  return rows;
}

/** A fills read is re-asked this often: a glance at recent moves, not a live tape. */
const FILLS_MS = 30_000;
const FILLS_LIMIT = 50;
const NO_FILLS: readonly MarketFill[] = [];

type MarketFills = {
  /** `NO_FILLS` also when unknown: nothing is drawn rather than a claim of none. */
  yours: readonly MarketFill[];
  agents: readonly MarketFill[];
  all: readonly MarketFill[];
  refresh: () => void;
};

/**
 * This market's fills, yours and your agents' (SEN-157). Each source is shown
 * only once it has answered, and hidden when it can't: yours need manual
 * trading on (`/portfolio/fills` is behind the flag), and an API without the
 * route, or a Perpl account with no read key linked, is "not available here",
 * not "you never traded". Your agents' fills are theirs, so they show whether
 * or not you may trade by hand.
 */
function useMarketFills(market: MarketDto, trading: boolean): MarketFills {
  const { trade, agents: api } = useSession();
  const key = marketKey(market);
  const { venue, symbol } = market;

  const yoursPolled = usePolling(
    trading && trade ? `fills:you:${key}` : null,
    () =>
      trade!.fills({ venue, symbol, limit: FILLS_LIMIT }).then(
        (page) => page.fills,
        (error: unknown) => {
          // Answers that mean "there is nothing to show here", not "retry".
          if (isUnavailable(error) || isFillsGap(error)) return null;
          throw error;
        },
      ),
    { intervalMs: FILLS_MS },
  );
  const agentsPolled = usePolling(
    api ? `fills:agents:${key}` : null,
    () => api!.fills({ venue, symbol, limit: FILLS_LIMIT }),
    { intervalMs: FILLS_MS },
  );

  const rawYours = trading ? yoursPolled.data : null;
  const rawAgents = agentsPolled.data;
  const yours = useMemo(
    () => (rawYours ? yourFills(rawYours, symbol) : NO_FILLS),
    [rawYours, symbol],
  );
  const agents = useMemo(
    () => (rawAgents ? agentsFills(rawAgents, symbol) : NO_FILLS),
    [rawAgents, symbol],
  );
  const all = useMemo(() => [...yours, ...agents], [yours, agents]);
  const { refresh: refreshYours } = yoursPolled;
  const { refresh: refreshAgents } = agentsPolled;
  const refresh = useCallback(() => {
    refreshYours();
    refreshAgents();
  }, [refreshYours, refreshAgents]);
  return { yours, agents, all, refresh };
}

/**
 * `/portfolio/fills` refusals that are a state, not a failure: trading
 * switched off since the flag was read, or Perpl with no read key (SEN-151).
 * `perpl_unavailable` is a real failure and keeps the last answer on screen.
 */
function isFillsGap(error: unknown): boolean {
  return (
    error instanceof TradeApiError &&
    (error.reason === 'trading_disabled' || error.reason === 'perpl_unlinked')
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** One line of "Fills on MON": your white stone or the agent's purple one, what, and when. */
function FillRow({ fill, tick, divider }: { fill: MarketFill; tick: string; divider: boolean }) {
  return (
    <View style={[styles.fill, divider && styles.divider]}>
      <Stone kind={fill.who === 'you' ? 'deposit' : 'trade'} />
      <Text style={[text.body, styles.grow]} numberOfLines={1}>
        {fillLine(fill, tick)}
      </Text>
      <Text style={styles.asofText}>{fillWhen(fill.at, Date.now())}</Text>
    </View>
  );
}

function Missing({
  onBack,
  title,
  detail,
  loading = false,
}: {
  onBack: () => void;
  title?: string;
  detail?: string;
  loading?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, styles.content, { paddingTop: insets.top }]}>
      <TopBar back={{ label: 'Markets', onPress: onBack }} />
      {loading ? (
        <Loading />
      ) : (
        <View style={styles.banner}>
          <Notice title={title ?? ''} detail={detail} />
        </View>
      )}
    </View>
  );
}

function StarButton({
  starred,
  onPress,
  symbol,
}: {
  starred: boolean;
  onPress: () => void;
  symbol: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        starred ? `Remove ${symbol} from favourites` : `Add ${symbol} to favourites`
      }
      accessibilityState={{ selected: starred }}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.star, starred && styles.starOn, pressed && styles.pressed]}
    >
      <Text style={[styles.starGlyph, starred && { color: color.purpleHi }]}>
        {starred ? '★' : '☆'}
      </Text>
    </Pressable>
  );
}

function MarkIndex({ label, value, tick }: { label: string; value: string | null; tick: string }) {
  return (
    <Text style={text.caption}>
      {label}{' '}
      <Text style={[text.num, { color: color.textDim }]}>
        {value ? (formatPrice(value, tick) ?? '—') : '—'}
      </Text>
    </Text>
  );
}

function PressureSide({
  side,
  sums,
  unit,
}: {
  side: 'Bids' | 'Asks';
  sums: { bids: string; asks: string };
  unit?: string;
}) {
  const split = pressureSplit(sums.bids, sums.asks);
  if (split === null) return null;
  const share = side === 'Bids' ? split.bid : split.ask;
  const mine = Number(side === 'Bids' ? sums.bids : sums.asks);
  const size = compactAmount(String(Math.round(mine)));
  return (
    <Text style={[text.caption, side === 'Bids' ? text.up : text.down]}>
      {side} {share}%{size ? ` · ${size}` : ''}
      {unit ? ` ${unit}` : ''}
    </Text>
  );
}

function AgentCard({
  agent,
  stake,
  unit,
  onPress,
}: {
  agent: Agent;
  stake: AgentStake;
  unit: string;
  onPress: () => void;
}) {
  const pnl = stake.pnl !== null ? signedAmount(stake.pnl) : null;
  const direction = stake.pnl !== null ? pctDirection(Number(stake.pnl)) : 'flat';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${stake.line}${pnl ? `, ${pnl} ${unit}` : ''}. Open cockpit`}
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card>
        <View style={styles.agentRow}>
          <Sigil seed={agent.id} />
          <View style={styles.grow}>
            <Text style={text.strong} numberOfLines={1}>
              {agent.name}
            </Text>
            <Text style={text.caption} numberOfLines={1}>
              {stake.line}
            </Text>
          </View>
          {pnl ? (
            <View style={styles.right}>
              <Text
                style={[
                  text.strong,
                  text.num,
                  direction === 'up' && text.up,
                  direction === 'down' && text.down,
                ]}
              >
                {pnl}
              </Text>
              <Text style={text.caption}>{unit}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[text.caption, styles.cockpit]}>Open cockpit ›</Text>
      </Card>
    </Pressable>
  );
}

function SideButton({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: 'long' | 'short';
  onPress: () => void;
}) {
  // Mint and berry here are the side, which is the one other thing they may mean.
  const ink = tone === 'long' ? color.mint : color.berry;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.side,
        { borderColor: ink, backgroundColor: tone === 'long' ? MINT_WASH : BERRY_WASH },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.sideText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

const MINT_WASH = 'rgba(95, 227, 179, 0.12)';
const BERRY_WASH = 'rgba(240, 80, 140, 0.12)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: GUTTER, paddingTop: 8 },
  grow: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end' },
  pressed: { opacity: 0.7 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  banner: { marginTop: 14 },
  priceLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 14 },
  unit: { fontFamily: font.medium, fontSize: 14, color: color.textFaint },
  markIndex: { flexDirection: 'row', gap: 16, marginTop: 4 },
  chart: { marginTop: 14, marginHorizontal: -4 },
  chartEmpty: { alignItems: 'center', justifyContent: 'center' },
  toggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
  },
  toggleText: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textDim },
  tfGrid: { flexDirection: 'row', gap: 6, marginTop: 12 },
  tf: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
    borderWidth: 1,
    borderColor: color.well,
  },
  // The number used everywhere else, outlined so the eye finds it.
  tfOn: { borderColor: color.lineStrong },
  tfValue: { fontSize: 13, lineHeight: 18 },
  funding: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: color.board,
    borderWidth: 1,
    borderColor: color.line,
  },
  agents: { gap: 10 },
  agentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cockpit: { marginTop: 10, textAlign: 'right', color: color.purpleHi },
  stat: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  fill: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  asofText: { fontFamily: font.chain, fontSize: 11, lineHeight: 14, color: color.textFaint },
  pressureLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  minihead: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: GUTTER,
    paddingVertical: 10,
    backgroundColor: color.ink,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  miniBack: { fontFamily: font.medium, fontSize: 22, lineHeight: 24, color: color.textDim },
  miniChange: { fontSize: 13, lineHeight: 18 },
  star: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starOn: { borderColor: color.purple },
  starGlyph: { fontSize: 17, lineHeight: 20, color: color.textDim },
  cta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: GUTTER,
    paddingTop: 12,
    backgroundColor: color.ink,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  side: {
    flex: 1,
    height: CTA_HEIGHT,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideText: { fontFamily: font.semibold, fontSize: 16 },
});
