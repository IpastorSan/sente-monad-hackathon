/**
 * Home, trading-first (SEN-113, plan U-7; the study's `markets.html` → Home).
 * The balance, then the board: a total-value hero, the markets strip, your
 * agents at work, your watchlist, what your agents trade, the day's biggest
 * moves and, when cash sits idle, one quiet nudge. It grew out of SEN-57's
 * Home and keeps what still fits: the wallet balances, the Add funds sheet
 * and the latest move with its consensus ramp.
 *
 * With manual trading on, the total is the Portfolio tab's own total (SEN-155):
 * cash, spot at Kuru prices and perps (margin + unrealised P&L) from `GET
 * /portfolio`, plus the capital with your agents, valued by the same
 * `portfolio/view.ts` functions so the two tabs agree. A venue or section
 * that did not answer is named under the figure, never counted as zero.
 * With trading off it is wallet cash (USDC + AUSD) plus the capital with your
 * agents, and says it leaves your own positions out. Either way it reads
 * "≈ $" (different dollars added up) and the line under it says exactly
 * what it counts. An agent's capital comes from `GET /agents/:id/portfolio`
 * and, while that route is not deployed, from the stablecoins in the agent's
 * wallet, which the sentence then names as missing its open trades.
 *
 * The chart under the total is the agents' realised P&L over the day, not the
 * total's history — there is no equity history on the wire — and it is
 * captioned as such.
 *
 * The eye hides every figure for trading in public; the choice is kept on the
 * device and shared with Portfolio (`portfolio/hideBalances.ts`). Account lives behind
 * the avatar, which since SEN-172 is the user's own face and name (`profile/`).
 * The address to fund left the header then: it is in Add funds. The bell opens Alerts (SEN-156) and carries the count of alerts
 * this device has not seen; with none it carries nothing, because a purple
 * badge is an event and cannot be decoration.
 *
 * The address is the user's PRIVY WALLET (SEN-40), not the passkey EOA and not
 * the old Kernel account: it is the address to fund. "Add funds" is a sheet
 * with the whole address and the system share sheet, not a copy button: the
 * app has no clipboard module, and adding one is a native dependency.
 *
 * Every choice — what the total counts, which markets make each list, how a
 * card is worded — is `agents/home.ts`, under test. This file only lays out.
 *
 * A wide web window (SEN-167) reads in two columns under the header and the
 * ticker: your money and the markets on the left (the total and its chart,
 * the watchlist, the biggest moves), your agents on the right (at work, what
 * they trade, the latest move, the nudge). A phone keeps the single column in
 * the order above.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { Address } from 'viem';

import type { Agent, AgentSummary } from '@/agents/api';
import { readBalance } from '@/agents/balances';
import { FUNDING_TOKENS } from '@/agents/fund';
import {
  agentMarkets,
  atWork,
  biggestMoves,
  greeting,
  homeAgents,
  idleCash,
  latestMove,
  ownHoldings,
  realisedSeries,
  realisedToday,
  sinceLabel,
  stableAmount,
  tickerItems,
  totalValue,
  tradingTotal,
  watchlist,
  type AgentCapital,
  type AgentMarket,
  type LatestMove,
  type OwnHoldings,
} from '@/agents/home';
import { useAgentsOverview } from '@/agents/useAgentsOverview';
import type { ActivityEvent } from '@/agents/api';
import { useAlerts } from '@/agents/useAlerts';
import type { MarketDto, TickerDto } from '@/markets/api';
import { useMarkets, useTickers } from '@/markets/hooks';
import { readFavourites } from '@/markets/localLists';
import { asPercent, priceOf, sparkPoints, venueLine } from '@/markets/marketsView';
import {
  changeOf,
  indexTickers,
  marketKey,
  type MarketKey,
  type TickerIndex,
} from '@/markets/select';
import { useSparklines } from '@/markets/useSparklines';
import { useHideBalances } from '@/portfolio/hideBalances';
import { useUserPortfolio } from '@/portfolio/usePortfolio';
import { useSession } from '@/session';
import { Chart } from '@/ui/chart/Chart';
import { ConsensusFeed, ConsensusRamp } from '@/ui/ConsensusRamp';
import { formatBalance, shortAddress } from '@/ui/format';
import { Avatar } from '@/ui/Avatar';
import { Sigil, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  ButtonRow,
  Card,
  Loading,
  Notice,
  Screen,
  Section,
  SectionLink,
  Sheet,
  useWide,
  WIDE_MAX,
} from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';
import {
  AsOf,
  BigNumber,
  ChangeText,
  MarketRow,
  PerpTag,
  TickerMarquee,
  TokenGlyph,
} from '@/ui/trading';
import { maskDigits } from '@/ui/tradingFormat';
import { balanceOf, type UseUserWallet } from '@/wallet';

/** What an agent's wallet counts toward the total: its stablecoins. */
const STABLES = FUNDING_TOKENS.filter(
  (token) => token.symbol === 'USDC' || token.symbol === 'AUSD',
);

export default function Home() {
  const router = useRouter();
  const wide = useWide();
  // The session lives in <SessionProvider> so the agent screens share it. The
  // tabs layout only renders this once it is signed in.
  const { wallet, profile } = useSession();
  const identity = profile.identity;
  const overview = useAgentsOverview();
  // One poll of `/agents/activity` feeds the bell, the latest move and the chart.
  const feed = useAlerts();
  const activity = useActivity(feed.events);
  const markets = useMarkets();
  const tickers = useTickers();
  // The same preference as Portfolio's eye (SEN-144): hide here, hidden there.
  const [hidden, toggleHidden] = useHideBalances();
  const [favourites, setFavourites] = useState<ReadonlySet<MarketKey>>(new Set());
  const [fundOpen, setFundOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped by a pull, so the agent capital re-reads with everything else. */
  const [pulls, setPulls] = useState(0);

  // Balances move while the user is elsewhere in the app — an agent trades, a
  // faucet lands — and the Markets tab can star a market. Re-read on focus.
  useFocusEffect(
    useCallback(() => {
      void wallet.refresh();
      void readFavourites().then(setFavourites);
    }, [wallet.refresh]),
  );

  const agents = overview.state.kind === 'loaded' ? overview.state.agents : null;
  const summaries: ReadonlyMap<string, AgentSummary> =
    overview.state.kind === 'loaded' ? overview.state.summaries : EMPTY_SUMMARIES;
  const read = useAgentCapital(agents, pulls);
  // With no roster there is nothing to add, and the agents section below says
  // why; the hero still shows the cash rather than a spinner forever.
  const capital = overview.state.kind === 'failed' ? NO_CAPITAL : read;
  // SEN-155: with trading on, the total counts your own positions too, read
  // and valued exactly as the Portfolio tab reads and values them.
  const user = useUserPortfolio();
  const tickersFailed = tickers.error !== null || tickers.unavailable;
  const tickerList = tickers.data?.tickers ?? (tickersFailed ? NO_TICKERS : null);
  const { data: portfolio, error: portfolioError, unavailable } = user.polled;
  const own = useMemo(
    () =>
      user.trading
        ? ownHoldings(
            { data: portfolio, error: portfolioError, unavailable },
            user.wallet,
            tickerList,
          )
        : null,
    [user.trading, portfolio, portfolioError, unavailable, user.wallet, tickerList],
  );

  const refresh = async () => {
    setRefreshing(true);
    setPulls((n) => n + 1);
    markets.refresh();
    tickers.refresh();
    if (user.trading) user.polled.refresh();
    feed.polled.refresh();
    await Promise.all([wallet.refresh(), overview.refresh()]);
    setRefreshing(false);
  };

  const address = wallet.wallet?.address ?? null;
  const share = () => {
    if (address !== null) void Share.share({ message: address });
  };

  const list = markets.data?.markets ?? null;
  const index = useMemo(() => indexTickers(tickers.data?.tickers ?? []), [tickers.data]);
  const watched = useMemo(() => (list ? watchlist(list, favourites) : []), [list, favourites]);
  const movers = useMemo(() => (list ? biggestMoves(list, index) : []), [list, index]);
  const traded = useMemo(() => (list && agents ? agentMarkets(agents, list) : []), [list, agents]);
  // Sparklines only for the rows Home draws, not the whole list.
  const lined = useMemo(() => uniqueMarkets([...watched, ...movers]), [watched, movers]);
  const klines = useSparklines(list === null ? null : lined);

  const idle = idleCash(wallet.wallet?.balances ?? null);
  const move = activity.move;
  // An API that predates `/markets` is not an error on Home: the market
  // sections simply are not there (the Markets tab explains why).
  const showMarkets = list !== null && !markets.unavailable;
  // Empty hides the strip: an API without tickers leaves no blank band.
  const strip = useMemo(
    () => (showMarkets && list ? tickerItems(list, index) : []),
    [showMarkets, list, index],
  );

  const rowFor = (market: MarketDto, i: number, count: number) => {
    const price = priceOf(market, index);
    return (
      <MarketRow
        key={marketKey(market)}
        symbol={market.base}
        subline={venueLine(market)}
        price={price ?? ''}
        tick={market.tickSize}
        changePct={asPercent(changeOf(market, index))}
        points={sparkPoints(klines.get(marketKey(market)) ?? [], price)}
        perp={market.kind === 'perp' ? { leverage: market.maxLeverage } : undefined}
        divider={i < count - 1}
        onPress={() => openMarket(router, market)}
      />
    );
  };

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Account"
        hitSlop={8}
        onPress={() => router.push('/account')}
        style={({ pressed }) => [styles.me, pressed && styles.pressed]}
      >
        {identity !== null ? (
          <Avatar seed={identity.avatarSeed} size={38} />
        ) : (
          <View style={styles.avatar} />
        )}
        <View style={styles.meText}>
          <Text style={[text.caption, styles.hello]} numberOfLines={1}>
            {`${greeting(new Date().getHours())} · testnet`}
          </Text>
          <Text style={styles.name} numberOfLines={1}>
            {identity?.name ?? 'Account'}
          </Text>
        </View>
      </Pressable>
      <View style={styles.aside}>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: hidden }}
          accessibilityLabel="Hide balances"
          hitSlop={8}
          onPress={toggleHidden}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <EyeIcon off={hidden} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={feed.badge !== null ? `Alerts, ${feed.badge} unread` : 'Alerts'}
          hitSlop={8}
          onPress={() => router.push('/alerts')}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Icon name="bell" size={18} color={color.textDim} />
          {feed.badge !== null ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{feed.badge}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>
    </View>
  );

  const hero = (
    <Hero
      wallet={wallet}
      capital={capital}
      trading={user.trading}
      own={own}
      summaries={summaries}
      events={activity.events}
      hidden={hidden}
      chartHeight={wide ? HERO_CHART_WIDE : HERO_CHART}
      onAddFunds={() => setFundOpen(true)}
      onShare={share}
    />
  );

  const ticker =
    strip.length > 0 ? (
      <View style={styles.ticker}>
        <TickerMarquee items={strip} />
      </View>
    ) : null;

  const agentsAtWork = <AgentsAtWork overview={overview.state} hidden={hidden} />;

  const watchlistSection = showMarkets ? (
    <Section
      label="Watchlist"
      aside={
        <View style={styles.aside}>
          <AsOf at={tickers.asOf} paused={tickers.stale} />
          <SectionLink label="Edit" onPress={() => router.push('/markets')} />
        </View>
      }
    >
      {watched.length === 0 ? (
        <Text style={[text.dim, styles.empty]}>
          Nothing starred yet. Long-press a market in Markets to add it here.
        </Text>
      ) : (
        watched.map((market, i) => rowFor(market, i, watched.length))
      )}
    </Section>
  ) : null;

  const tradedSection =
    showMarkets && traded.length > 0 ? (
      <Section label="What your agents are trading">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.strip}
          contentContainerStyle={styles.stripContent}
        >
          {traded.map((row) => (
            <MoverCard
              key={marketKey(row.market)}
              row={row}
              index={index}
              onPress={() => openMarket(router, row.market)}
            />
          ))}
        </ScrollView>
      </Section>
    ) : null;

  const moversSection =
    showMarkets && movers.length > 0 ? (
      <Section
        label="Biggest moves today"
        aside={<SectionLink label="Markets" onPress={() => router.push('/markets')} />}
      >
        {movers.map((market, i) => rowFor(market, i, movers.length))}
      </Section>
    ) : null;

  const moveSection =
    move !== null ? (
      <Section
        label="Latest move"
        aside={
          <SectionLink
            label="Ledger"
            onPress={() =>
              router.push({
                pathname: '/agents/[id]/ledger',
                params: { id: move.agentId },
              })
            }
          />
        }
      >
        <Move move={move} />
      </Section>
    ) : null;

  const nudge =
    idle !== null ? (
      <Card goban style={styles.nudge}>
        <Text style={text.label}>Put cash to work</Text>
        <Text style={[text.dim, styles.nudgeText]}>{hidden ? maskDigits(idle) : idle}</Text>
        <ButtonRow>
          <Button
            label="Hire an agent"
            kind="soft"
            size="sm"
            onPress={() => router.push('/agents/new')}
            style={styles.grow}
          />
          <Button
            label="Trade"
            kind="primary"
            size="sm"
            onPress={() => router.push('/trade')}
            style={styles.grow}
          />
        </ButtonRow>
      </Card>
    ) : null;

  return (
    <Screen tabbed refreshing={refreshing} onRefresh={() => void refresh()} maxWidth={WIDE_MAX}>
      {header}
      {wide ? (
        <>
          {ticker}
          <View style={styles.columns}>
            <View style={styles.column}>
              {hero}
              {watchlistSection}
              {moversSection}
            </View>
            <View style={[styles.column, styles.columnRight]}>
              {agentsAtWork}
              {tradedSection}
              {moveSection}
              {nudge}
            </View>
          </View>
        </>
      ) : (
        <>
          {hero}
          {ticker}
          {agentsAtWork}
          {watchlistSection}
          {tradedSection}
          {moversSection}
          {moveSection}
          {nudge}
        </>
      )}

      <Text style={styles.testnet}>MONAD TESTNET</Text>

      {address !== null ? (
        <FundSheet
          visible={fundOpen}
          address={address}
          onShare={share}
          onClose={() => setFundOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** The agents' P&L under the total: a strip on a phone, room to read on a wide window. */
const HERO_CHART = 64;
const HERO_CHART_WIDE = 140;

const EMPTY_SUMMARIES: ReadonlyMap<string, AgentSummary> = new Map();
const NO_CAPITAL: readonly AgentCapital[] = [];
const NO_TICKERS: readonly TickerDto[] = [];

type Router = ReturnType<typeof useRouter>;

function openMarket(router: Router, market: MarketDto) {
  router.push({
    pathname: '/markets/[venue]/[symbol]',
    params: { venue: market.venue, symbol: market.symbol },
  });
}

function uniqueMarkets(markets: readonly MarketDto[]): MarketDto[] {
  const seen = new Set<MarketKey>();
  return markets.filter((market) => {
    const key = marketKey(market);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── The hero ───────────────────────────────────────────────────────────────

/** Total value, what it counts, the agents' day, the cash line and the two ways to add to it. */
function Hero({
  wallet,
  capital,
  trading,
  own,
  summaries,
  events,
  hidden,
  chartHeight,
  onAddFunds,
  onShare,
}: {
  wallet: UseUserWallet;
  capital: readonly AgentCapital[] | null;
  /** Manual trading is on: the total takes your own positions (SEN-155). */
  trading: boolean;
  /** `null` until `/portfolio` and the tickers have answered, or with trading off. */
  own: OwnHoldings | null;
  summaries: ReadonlyMap<string, AgentSummary>;
  events: readonly ActivityEvent[];
  hidden: boolean;
  chartHeight: number;
  onAddFunds: () => void;
  onShare: () => void;
}) {
  const held = wallet.wallet;
  const total =
    capital === null
      ? null
      : trading
        ? tradingTotal(own, capital)
        : totalValue(held?.balances ?? null, capital);
  const day = realisedToday(summaries);
  const series = useMemo(
    () => realisedSeries(events, day?.value ?? null, Date.now()),
    [events, day?.value],
  );
  const mask = (figure: string) => (hidden ? maskDigits(figure) : figure);

  return (
    <View style={styles.hero}>
      <Text style={text.label}>Total value</Text>
      {wallet.status === 'registering' || (held === null && wallet.status !== 'error') ? (
        <>
          <Loading />
          <Text style={text.caption}>Claiming the wallet your device key owns…</Text>
        </>
      ) : held === null ? (
        <Notice
          tone="error"
          title="Could not reach your wallet"
          detail={wallet.error?.message ?? 'The API did not answer. Pull to try again.'}
        />
      ) : (
        <>
          {total !== null ? (
            <BigNumber
              value={total.total}
              prefix="$"
              approx
              size="xl"
              blurred={hidden}
              style={styles.heroFigure}
            />
          ) : (
            <Loading />
          )}
          {day !== null ? (
            <Text
              style={[
                styles.heroChange,
                day.tone === 'up' && text.up,
                day.tone === 'down' && text.down,
              ]}
            >
              {mask(day.label)}
            </Text>
          ) : null}
          {total !== null ? (
            <Text style={[text.caption, styles.includes]}>{total.includes}</Text>
          ) : null}
          <Text style={[text.dim, text.num, styles.cash]}>
            {mask(
              `Cash ${formatBalance(balanceOf(held, 'AUSD'))} AUSD · ${formatBalance(
                balanceOf(held, 'USDC'),
              )} USDC · ${formatBalance(balanceOf(held, 'MON'))} MON`,
            )}
          </Text>
          {held.starterKit?.status === 'pending' ? (
            <Text style={text.caption}>Starter funds on the way</Text>
          ) : null}
          {wallet.status === 'error' && wallet.error ? (
            <Notice tone="error" title="Balances may be stale" detail={wallet.error.message} />
          ) : null}
        </>
      )}

      {series !== null ? (
        <View style={styles.chart}>
          <Chart
            kind="area"
            points={series}
            height={chartHeight}
            label="Your agents' realised profit and loss over the last 24 hours"
          />
          <Text style={[text.caption, styles.chartCaption]}>Agents’ realised P&L, last 24h</Text>
        </View>
      ) : null}

      <View style={styles.walletButtons}>
        <ButtonRow>
          <Button
            label="Add funds"
            kind="primary"
            size="sm"
            icon="plus"
            onPress={onAddFunds}
            disabled={held === null}
            style={styles.grow}
          />
          <Button
            label={held !== null ? shortAddress(held.address) : '—'}
            kind="soft"
            size="sm"
            icon="share"
            onPress={onShare}
            disabled={held === null}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </View>
  );
}

/** The study's eye: open shows balances, struck through hides them. */
function EyeIcon({ off }: { off: boolean }) {
  return <Icon name={off ? 'balancesHidden' : 'balances'} size={18} color={color.textDim} />;
}

/**
 * Each agent's capital for the total: its portfolio's `≈ $` total when the
 * route answers, else its wallet's stablecoins read from the chain, else
 * unread. `null` until the roster is known, so the hero does not flash a
 * cash-only total and then jump.
 */
function useAgentCapital(agents: readonly Agent[] | null, pulls: number): AgentCapital[] | null {
  const { agents: api } = useSession();
  const [capital, setCapital] = useState<AgentCapital[] | null>(null);
  // Keyed on the ids and addresses, not the array: the overview hands back a
  // new array on every focus, and that alone must not re-read the chain.
  const key = agents === null ? null : agents.map((a) => `${a.id}:${a.address}`).join(',');
  const targets = useMemo(
    () => (agents === null ? null : agents.map((a) => ({ id: a.id, address: a.address }))),
    [key],
  );

  useEffect(() => {
    if (targets === null || api === null) return;
    let live = true;
    void Promise.all(
      targets.map(async ({ id, address }): Promise<AgentCapital> => {
        try {
          const portfolio = await api.portfolio(id);
          if (portfolio !== null) return { source: 'portfolio', value: portfolio.totals.approxUsd };
        } catch {
          // Fall through to the wallet: a figure with a caveat beats none.
        }
        try {
          return { source: 'wallet', value: stableAmount(await readStables(address), STABLES) };
        } catch {
          return { source: 'unread' };
        }
      }),
    ).then((read) => {
      if (live) setCapital(read);
    });
    return () => {
      live = false;
    };
  }, [targets, api, pulls]);

  return capital;
}

async function readStables(owner: Address): Promise<Record<string, bigint>> {
  const entries = await Promise.all(
    STABLES.map(async (token) => [token.symbol, await readBalance(token, owner)] as const),
  );
  return Object.fromEntries(entries);
}

/** Where to send money, whole and selectable, and a way to send it elsewhere. */
function FundSheet({
  visible,
  address,
  onShare,
  onClose,
}: {
  visible: boolean;
  address: string;
  onShare: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Add funds" onClose={onClose}>
      <Text style={text.dim}>
        Send AUSD or USDC on Monad testnet to your wallet. That is what you and your agents trade
        with; gas is sponsored, so you never need MON.
      </Text>
      <View style={styles.addressWell}>
        <Text style={[text.mono, styles.address]} selectable>
          {address}
        </Text>
      </View>
      <Text style={text.caption}>Only send on Monad testnet. Other networks will not arrive.</Text>
      <Button
        label="Share address"
        kind="primary"
        icon="share"
        onPress={onShare}
        style={styles.sheetButton}
      />
    </Sheet>
  );
}

// ─── Agents ─────────────────────────────────────────────────────────────────

function AgentsAtWork({
  overview,
  hidden,
}: {
  overview: ReturnType<typeof useAgentsOverview>['state'];
  hidden: boolean;
}) {
  const router = useRouter();
  const label = 'Your agents at work';

  if (overview.kind === 'loading') {
    return (
      <Section label={label}>
        <Loading />
      </Section>
    );
  }
  if (overview.kind === 'failed') {
    return (
      <Section label={label}>
        <Notice tone="error" title={overview.title} detail={overview.detail} />
      </Section>
    );
  }
  if (overview.agents.length === 0) {
    return (
      <Section label={label}>
        <Card>
          <Text style={text.title}>Put an agent to work</Text>
          <Text style={[text.dim, styles.inviteText]}>
            An agent trades for you inside a mandate you set: which markets, how much, and until
            when. The enclave refuses anything outside it.
          </Text>
          <Button
            label="Hire your first agent"
            kind="primary"
            icon="plus"
            onPress={() => router.push('/agents/new')}
            style={styles.inviteButton}
          />
        </Card>
      </Section>
    );
  }

  const shown = homeAgents(overview.agents, overview.summaries);
  // Pairs, so an odd last card keeps half the width instead of stretching.
  const rows: Agent[][] = [];
  for (let i = 0; i < shown.length; i += 2) rows.push(shown.slice(i, i + 2));
  return (
    <Section
      label={label}
      aside={
        <SectionLink
          label={`All ${overview.agents.length}`}
          onPress={() => router.push('/agents')}
        />
      }
    >
      <View style={styles.grid}>
        {rows.map((pair) => (
          <View key={pair.map((a) => a.id).join()} style={styles.gridRow}>
            {pair.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                summary={overview.summaries.get(agent.id)}
                hidden={hidden}
              />
            ))}
            {pair.length === 1 ? <View style={styles.grow} /> : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

/** One agent: its face and name, its last stone and line, its day. Tap opens the cockpit. */
function AgentCard({
  agent,
  summary,
  hidden,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  hidden: boolean;
}) {
  const router = useRouter();
  const { move, pnl } = atWork(agent, summary);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
      style={({ pressed }) => [styles.mini, pressed && styles.pressed]}
    >
      <View style={styles.miniHead}>
        <Sigil seed={agent.id} size={28} dimmed={agent.status === 'revoked'} />
        <Text style={[text.strong, styles.miniName]} numberOfLines={1}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.miniMove}>
        {move !== null ? (
          <>
            <View style={styles.miniStone}>
              <Stone kind={move.stone} size={10} />
            </View>
            <Text style={[styles.miniLine, styles.grow]} numberOfLines={2}>
              {move.line}
            </Text>
          </>
        ) : (
          <Text style={styles.miniLine} numberOfLines={2}>
            {agent.status === 'revoked' ? 'Revoked' : 'No moves yet'}
          </Text>
        )}
      </View>
      <View style={styles.between}>
        <Text style={text.caption}>24h</Text>
        {pnl !== null ? (
          <Text
            style={[
              text.num,
              styles.miniPnl,
              pnl.tone === 'up' && text.up,
              pnl.tone === 'down' && text.down,
            ]}
            numberOfLines={1}
          >
            {hidden ? maskDigits(pnl.label) : pnl.label}
          </Text>
        ) : (
          <Text style={[text.caption, styles.miniPnl]}>—</Text>
        )}
      </View>
    </Pressable>
  );
}

/** A market your agents trade: its stone, how many of them, the symbol and its day. */
function MoverCard({
  row,
  index,
  onPress,
}: {
  row: AgentMarket;
  index: TickerIndex;
  onPress: () => void;
}) {
  const { market } = row;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${market.symbol}, traded by ${row.caption}`}
      onPress={onPress}
      style={({ pressed }) => [styles.mover, pressed && styles.pressed]}
    >
      <View style={styles.between}>
        <TokenGlyph symbol={market.base} size="sm" />
        <Text style={text.caption}>{row.caption}</Text>
      </View>
      <Text style={text.strong} numberOfLines={1}>
        {market.base}
        {market.kind === 'perp' ? ' ' : null}
        {market.kind === 'perp' ? <PerpTag /> : null}
      </Text>
      <ChangeText pct={asPercent(changeOf(market, index))} style={styles.moverChange} />
    </Pressable>
  );
}

// ─── Activity ───────────────────────────────────────────────────────────────

/**
 * The latest events across every agent, from the Alerts poll (SEN-156): the
 * newest one Home can word is the latest move, and the whole page feeds the
 * realised-P&L chart. The route is from SEN-56 and may not be deployed, so a
 * failure reads as "no activity": both are left out, never shown as an error
 * on the home screen.
 */
function useActivity(events: ActivityEvent[]): {
  events: ActivityEvent[];
  move: LatestMove | null;
} {
  const move = useMemo(() => {
    for (const event of events) {
      const found = latestMove(event);
      if (found !== null) return found;
    }
    return null;
  }, [events]);

  return { events, move };
}

/** One ledger event as a sentence, with its stone, and the ramp if it landed in a block. */
function Move({ move }: { move: LatestMove }) {
  return (
    <View style={styles.move}>
      <View style={styles.moveStone}>
        <Stone kind={move.stone} />
      </View>
      <View style={styles.grow}>
        <View style={styles.moveHead}>
          <Text style={[text.strong, styles.grow]}>{move.title}</Text>
          <Text style={[text.mono, styles.moveTime]}>{sinceLabel(move.at, Date.now())}</Text>
        </View>
        {move.detail !== null ? (
          <Text style={text.dim} numberOfLines={2}>
            {move.detail}
          </Text>
        ) : null}
        {move.block !== null ? (
          // The ramp polls through a feed; Home has exactly one ramp, so one feed.
          <ConsensusFeed>
            <ConsensusRamp blockNumber={move.block.number} consensus={move.block.consensus} />
          </ConsensusFeed>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  me: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  // Before sign-in settles: the study's `.me`, a white stone, because the avatar is you.
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#ECE8FB',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  meText: { flexShrink: 1 },
  hello: { lineHeight: 15 },
  // The user's name: the app raising its voice a little, so Bricolage.
  name: {
    fontFamily: font.displaySemibold,
    fontSize: 17,
    lineHeight: 21,
    letterSpacing: -0.2,
    color: color.text,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grow: { flex: 1 },
  aside: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hero: { marginTop: 14 },
  // Wide (SEN-167): two columns under the ticker, tops level with each other.
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 48 },
  column: { flex: 1, minWidth: 0 },
  // A Section opens with 28 of margin where the hero opens with 14.
  columnRight: { marginTop: -14 },
  heroFigure: { marginTop: 6 },
  heroChange: { marginTop: 4, fontFamily: font.medium, fontSize: 13, color: color.textDim },
  includes: { marginTop: 6 },
  cash: { marginTop: 8 },
  // The study's `.chart--flat`: the area runs to the screen edges.
  chart: { marginTop: 4, marginHorizontal: -GUTTER },
  chartCaption: { paddingHorizontal: GUTTER, marginTop: 2 },
  walletButtons: { marginTop: 16 },
  ticker: { marginTop: 20 },
  empty: { paddingVertical: 12 },
  grid: { gap: 10 },
  gridRow: { flexDirection: 'row', gap: 10 },
  mini: {
    flex: 1,
    minWidth: 0,
    gap: 8,
    padding: 12,
    backgroundColor: color.board,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: RADIUS.well,
  },
  miniHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniName: { flexShrink: 1, fontSize: 14 },
  miniMove: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, minHeight: 32 },
  miniStone: { marginTop: 3 },
  miniLine: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: color.textDim },
  // SEN-177: a flat day is the readable dim, not the default ink on a dark card.
  miniPnl: {
    fontFamily: font.medium,
    fontSize: 13,
    color: color.textDim,
    flexShrink: 1,
    marginLeft: 8,
  },
  // The strip bleeds to the screen edge, as in the study, so the next card
  // peeks out and says the row scrolls.
  strip: { marginHorizontal: -GUTTER, flexGrow: 0 },
  stripContent: { paddingHorizontal: GUTTER, gap: 10 },
  mover: {
    width: 112,
    gap: 6,
    padding: 10,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  moverChange: { fontSize: 13 },
  nudge: { marginTop: 24 },
  nudgeText: { marginTop: 8, marginBottom: 12 },
  testnet: {
    marginTop: 14,
    textAlign: 'center',
    fontFamily: font.chain,
    fontSize: 10,
    letterSpacing: 0.4,
    color: color.textFaint,
  },
  addressWell: {
    marginVertical: 16,
    padding: 14,
    borderRadius: 14,
    backgroundColor: color.well,
  },
  address: { fontSize: 14, lineHeight: 22, color: color.text },
  sheetButton: { marginTop: 20 },
  inviteText: { marginTop: 6 },
  inviteButton: { marginTop: 16 },
  move: { flexDirection: 'row', gap: 14 },
  moveStone: { marginTop: 4 },
  moveHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  moveTime: { fontSize: 11, color: color.textFaint },
  // The count on the bell: purple, because an unseen alert is an event.
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: color.purple,
    borderWidth: 2,
    borderColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: font.semibold, fontSize: 10, lineHeight: 12, color: color.text },
});
