/**
 * Portfolio (SEN-118, plan U-12): where your money is and what it is doing.
 * The total, a bar splitting it into cash, capital with agents, spot and
 * perps, the cash card, then two clearly titled sections (SEN-215): "Your
 * trades" (open and closed positions, orders and fills from your own wallet)
 * and "Agents" (each agent's balance and status, their open positions, and
 * the round trips they closed). Spec: `docs/design/trading/portfolio.html`.
 *
 * Your own positions and orders come from `GET /portfolio`, which only
 * answers while manual trading is on (the same flag as `/trade`). With it
 * off the tab still shows the wallet session's cash and everything your
 * agents hold, plus an honest "trading from your wallet is coming" card —
 * never an empty tab and never an error for a feature that is simply off.
 *
 * Your agents' positions sit in their own section and are read-only: an
 * agent's funds are the agent's, so a row opens its cockpit.
 *
 * The total is computed on the phone and printed as one dollar figure with
 * its breakdown by coin (SEN-215, `portfolio/valuation.ts`): USDC and AUSD at
 * $1 and anything else at its Kuru last price — the same prices the bar and
 * the line use — and a coin with no price listed, not counted. The
 * line under it is the server's recorded history over 1D / 1W / 1M / ALL
 * (SEN-152, `portfolio/ValueHero.tsx`); until that has a point, it is what
 * this phone observed since the app opened, and the caption says exactly that.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { useAgentsOverview } from '@/agents/useAgentsOverview';
import { agentBook, type AgentBook } from '@/portfolio/agentBook';
import { closedList } from '@/portfolio/closed';
import { ClosedPositions } from '@/portfolio/ClosedPositions';
import { useTickers } from '@/markets/hooks';
import { useHideBalances } from '@/portfolio/hideBalances';
import { EXTERNAL_WITHDRAW_ENABLED } from '@/portfolio/withdraw';
import { KuruWithdrawSheet, WithdrawSheet } from '@/portfolio/WithdrawSheets';
import {
  AgentBalanceLine,
  AgentClosedLine,
  AgentPositionLine,
  AllocationBar,
  CashCard,
  FillLine,
  HideToggle,
  OrderCard,
  PerpPositionRow,
  SpotPositionRow,
} from '@/portfolio/parts';
import {
  useAgentEntries,
  useAgentPortfolios,
  useFills,
  useUserPortfolio,
} from '@/portfolio/usePortfolio';
import { dollars, unpricedNote, valuation } from '@/portfolio/valuation';
import { ValueHero } from '@/portfolio/ValueHero';
import {
  allocation,
  allocationParts,
  amountText,
  fillDays,
  holdings,
  orderRows,
  perplFillsNote,
  sectionFailure,
  shown,
  type Holdings,
  type OrderRow,
  type PortfolioSection,
} from '@/portfolio/view';
import { useSession } from '@/session';
import { createAppPerplTrader } from '@/trade/appPerplTrader';
import { describeTradeError, kuruCancelDraft, runTrade, type TradeFlowState } from '@/trade/flow';
import { usePerplSetup } from '@/trade/usePerplSetup';
import { useTradingCapabilities } from '@/trade/useTradingEnabled';
import { Button, Card, Loading, Notice, Row, Screen, Section, Segmented, Sheet } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { AsOf } from '@/ui/trading';

type Tab = 'open' | 'closed' | 'orders' | 'history';

/** How many of the agents' closed trades show before "Show all". */
const CLOSED_PREVIEW = 5;

export default function PortfolioScreen() {
  const router = useRouter();
  const { wallet: walletSession } = useSession();
  const user = useUserPortfolio();
  const tickers = useTickers();
  const overview = useAgentsOverview();
  const [pulls, setPulls] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const agents = overview.state.kind === 'loaded' ? overview.state.agents : null;
  const agentPortfolios = useAgentPortfolios(agents, pulls);
  const agentEntries = useAgentEntries(agents, pulls);
  const fills = useFills(user.trading);
  const [hidden, toggleHidden] = useHideBalances();
  const [tab, setTab] = useState<Tab>('open');
  const [fundOpen, setFundOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [kuruWithdrawOpen, setKuruWithdrawOpen] = useState(false);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  // SEN-120: a wallet with no Perpl account (or no trading key here) is
  // offered the setup where its perps would be listed.
  const { perps } = useTradingCapabilities();
  const perplSetup = usePerplSetup(perps);

  // With trading off the cash comes from the wallet session; re-read it on
  // focus the way Home does, since balances move while you are elsewhere.
  useFocusEffect(
    useCallback(() => {
      if (!user.trading) void walletSession.refresh();
    }, [user.trading, walletSession.refresh]),
  );

  const tickerList = useMemo(() => tickers.data?.tickers ?? [], [tickers.data]);
  const held = useMemo(
    () => (user.wallet ? holdings(user.wallet, user.portfolio, tickerList) : null),
    [user.wallet, user.portfolio, tickerList],
  );
  const book = useMemo(
    () =>
      agents && agentPortfolios
        ? agentBook(
            agents.map((agent) => ({
              agent,
              portfolio: agentPortfolios.get(agent.id) ?? null,
              entries: agentEntries ? (agentEntries.get(agent.id) ?? null) : null,
            })),
            tickerList,
            Date.now(),
          )
        : null,
    [agents, agentPortfolios, agentEntries, tickerList],
  );
  const split = useMemo(
    () => (held ? allocation(allocationParts(held, book?.total ?? null)) : null),
    [held, book],
  );
  // One dollar figure and its breakdown by coin, at the bar's prices (SEN-215).
  const value = useMemo(
    () => (split ? valuation(split.amounts, tickerList) : null),
    [split, tickerList],
  );
  // The hero stamps its live point with the newest data time behind it, so
  // the line only moves when a read lands, never on a re-render.
  const at = Math.max(user.portfolio?.asOf ?? 0, tickers.asOf ?? 0) || null;
  const now = Date.now();
  const orders = user.trading ? orderRows(user.portfolio, tickerList, now) : [];
  const openCount = held ? held.spot.length + held.perps.length : 0;

  const refresh = async () => {
    setRefreshing(true);
    setPulls((n) => n + 1);
    user.polled.refresh();
    tickers.refresh();
    await Promise.all([walletSession.refresh(), overview.refresh()]);
    setRefreshing(false);
  };

  const address = walletSession.wallet?.address ?? null;
  const openPosition = (venue: 'kuru' | 'perpl', symbol: string) =>
    router.push({ pathname: '/positions/[venue]/[symbol]', params: { venue, symbol } });
  const openAgent = (id: string) => router.push({ pathname: '/agents/[id]', params: { id } });

  return (
    <Screen tabbed refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={styles.head}>
        <Text style={text.display}>Portfolio</Text>
        <View style={styles.tools}>
          <Text style={styles.net}>Monad testnet</Text>
          <HideToggle hidden={hidden} onToggle={toggleHidden} />
        </View>
      </View>

      {held === null || split === null ? (
        walletSession.status === 'error' ? (
          <Notice
            tone="error"
            title="Could not reach your wallet"
            detail={walletSession.error?.message ?? 'Pull to try again.'}
          />
        ) : (
          <Loading />
        )
      ) : (
        <>
          <ValueHero
            value={value ?? valuation([], [])}
            at={at}
            trading={user.trading}
            hidden={hidden}
            note={totalNote(held, value?.unpriced ?? [], agentPortfolios === null)}
          />

          <AllocationBar split={split} hidden={hidden} />

          <CashCard
            cash={held.cash}
            venueCash={held.venueCash}
            hidden={hidden}
            onAddFunds={() => setFundOpen(true)}
            // SEN-153: hidden until the API allows outside recipients (see the flag).
            onWithdraw={EXTERNAL_WITHDRAW_ENABLED ? () => setWithdrawOpen(true) : undefined}
            // SEN-153: the Kuru withdrawal is a `/trade` intent, so it is only
            // offered while manual trading is on and Kuru actually answered.
            onKuruWithdraw={
              user.trading && user.portfolio?.kuru.ok ? () => setKuruWithdrawOpen(true) : undefined
            }
          />

          <Section
            label="Your trades"
            aside={
              user.portfolio ? <AsOf at={user.polled.asOf} paused={user.polled.stale} /> : null
            }
          >
            <Text style={text.caption}>What you trade yourself, from your own wallet.</Text>
            {user.trading && user.portfolio ? (
              <View style={styles.tabs}>
                <Segmented
                  options={[
                    { value: 'open', label: openCount ? `Open ${openCount}` : 'Open' },
                    { value: 'closed', label: 'Closed' },
                    {
                      value: 'orders',
                      label: orders.length ? `Orders ${orders.length}` : 'Orders',
                    },
                    { value: 'history', label: 'History' },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
              </View>
            ) : (
              <ComingCard trading={user.trading} failed={user.polled.error !== null} />
            )}

            {tab === 'open' || !user.portfolio ? (
              <View>
                <SubHead title="Open positions" />
                <Unread sections={held.unread} />
                {perplSetup.kind === 'needed' ? (
                  <PerpsSetupCard
                    open={perplSetup.needs.open}
                    onSetup={() => router.push('/trade/perpl-setup')}
                  />
                ) : null}
                {held.spot.length + held.perps.length === 0 && held.unread.length === 0 ? (
                  <Text style={[text.dim, styles.empty]}>
                    {user.portfolio
                      ? 'No open positions. Open Trade to place your first order.'
                      : 'Nothing but cash in your wallet yet.'}
                  </Text>
                ) : null}
                {held.perps.map((p, i) => (
                  <PerpPositionRow
                    key={`perpl:${p.position.symbol}`}
                    symbol={p.position.symbol}
                    side={p.position.side}
                    leverage={p.position.leverage}
                    size={p.position.size}
                    entry={p.position.entryPrice}
                    value={p.value}
                    pnl={p.position.unrealizedPnl}
                    pct={p.pctOnMargin}
                    hidden={hidden}
                    onPress={() => openPosition('perpl', p.position.symbol)}
                    last={i === held.perps.length - 1 && held.spot.length === 0}
                  />
                ))}
                {held.spot.map((s, i) => (
                  <SpotPositionRow
                    key={`kuru:${s.asset}`}
                    {...s}
                    hidden={hidden}
                    onPress={() => openPosition('kuru', s.asset)}
                    last={i === held.spot.length - 1}
                  />
                ))}
              </View>
            ) : tab === 'closed' ? (
              // SEN-154: closed positions come from your fills, which only
              // exist with trading on, so the tab does too.
              <View>
                <SubHead title="Closed positions" />
                <ClosedPositions fills={fills} hidden={hidden} />
              </View>
            ) : tab === 'orders' ? (
              <View>
                <SubHead title="Open orders" />
                {/* Both venues carry orders; the wallet does not (SEN-123). */}
                <Unread sections={held.unread.filter((s) => s !== 'wallet')} />
                {orders.length === 0 && !held.unread.some((s) => s !== 'wallet') ? (
                  <Text style={[text.dim, styles.empty]}>
                    No open orders. Limit orders you place rest here until they fill.
                  </Text>
                ) : (
                  orders.map((row) => (
                    <OrderCard
                      key={row.key}
                      row={row}
                      hidden={hidden}
                      onCancel={user.trading ? () => setCancelling(row) : undefined}
                    />
                  ))
                )}
              </View>
            ) : (
              <History fills={fills} hidden={hidden} now={now} />
            )}
          </Section>

          <Agents
            state={overview.state}
            book={book}
            hidden={hidden}
            onOpen={openAgent}
            onHire={() => router.push('/agents')}
          />
        </>
      )}

      {address !== null ? (
        <FundSheet
          visible={fundOpen}
          address={address}
          onClose={() => setFundOpen(false)}
          onShare={() => void Share.share({ message: address })}
        />
      ) : null}
      {EXTERNAL_WITHDRAW_ENABLED ? (
        <WithdrawSheet
          visible={withdrawOpen}
          agents={agents}
          onClose={() => setWithdrawOpen(false)}
          onSettled={() => void refresh()}
        />
      ) : null}
      {user.trading ? (
        <KuruWithdrawSheet
          visible={kuruWithdrawOpen}
          balances={user.portfolio?.kuru.ok ? user.portfolio.kuru.balances : null}
          onClose={() => setKuruWithdrawOpen(false)}
          onSettled={() => void refresh()}
        />
      ) : null}
      <CancelSheet
        row={cancelling}
        hidden={hidden}
        trading={user.trading}
        perplApiKey={perplSetup.kind === 'ready' ? perplSetup.apiKey : null}
        onClose={() => setCancelling(null)}
        onSettled={user.polled.refresh}
      />
    </Screen>
  );
}

/** How the total is counted and what it leaves out, said under it rather than folded into the number. */
function totalNote(held: Holdings, unpriced: readonly string[], agentsLoading: boolean) {
  const parts = ['USDC and AUSD count at $1, other tokens at their Kuru price.'];
  const left = unpricedNote(unpriced);
  if (left !== null) parts.push(left);
  const unread = held.unread.filter((s) => s !== 'wallet').map((s) => VENUE_NAME[s]);
  if (unread.length > 0) parts.push(`Leaves out ${unread.join(' and ')}: it didn’t answer.`);
  if (held.perpsUnknown) parts.push('Perp positions are not readable until Perpl is linked.');
  if (agentsLoading) parts.push('Still reading your agents.');
  return parts.join(' ');
}

const VENUE_NAME = { kuru: 'Kuru', perpl: 'Perpl' } as const;

/** Perps are on but this wallet can't trade them from here yet: say what setting up does. */
function PerpsSetupCard({ open, onSetup }: { open: boolean; onSetup: () => void }) {
  return (
    <Card style={styles.perpsCard}>
      <Text style={text.label}>Perps on Perpl</Text>
      <Text style={text.title}>
        {open ? 'Trade perps from your wallet' : 'Finish setting up perps'}
      </Text>
      <Text style={text.dim}>
        {open
          ? 'Open a Perpl account with 100 AUSD or more, and this device gets a key that can trade it, never withdraw. About 20–40 s.'
          : 'Your Perpl account is open. This device still needs its trading key.'}
      </Text>
      <Button
        label={open ? 'Set up perps' : 'Finish setup'}
        kind="soft"
        size="sm"
        icon="key"
        onPress={onSetup}
      />
    </Card>
  );
}

/** One notice per `/portfolio` section that failed: unknown, never drawn as empty (SEN-123). */
function Unread({ sections }: { sections: readonly PortfolioSection[] }) {
  return sections.map((section) => (
    <View key={section} style={styles.unread}>
      <Notice tone="error" {...sectionFailure(section)} />
    </View>
  ));
}

/**
 * Manual trading is off (or its route refused): say what is coming instead
 * of hiding the fact that orders and history are missing.
 */
function ComingCard({ trading, failed }: { trading: boolean; failed: boolean }) {
  return (
    <Card style={styles.coming}>
      <Text style={text.title}>Trading from your wallet is coming</Text>
      <Text style={[text.dim, styles.comingText]}>
        {trading && failed
          ? 'Your own orders and positions could not be read just now. Pull to try again.'
          : 'Buying and selling on Kuru and opening perps on Perpl from this wallet. Until then, your agents trade for you and their positions are below.'}
      </Text>
    </Card>
  );
}

/** A titled block inside a section: `Agent balances`, `Open positions`. */
function SubHead({ title, aside }: { title: string; aside?: string | null }) {
  return (
    <View style={styles.subHead}>
      <Text style={styles.subTitle}>{title}</Text>
      {aside ? <Text style={[text.dim, text.num]}>{aside}</Text> : null}
    </View>
  );
}

/**
 * Your agents (SEN-215): what each holds and where it stands, their open
 * positions, and the round trips they closed — three titled lists, so none is
 * mistaken for another. Every row opens the agent.
 */
function Agents({
  state,
  book,
  hidden,
  onOpen,
  onHire,
}: {
  state: ReturnType<typeof useAgentsOverview>['state'];
  book: AgentBook | null;
  hidden: boolean;
  onOpen: (id: string) => void;
  onHire: () => void;
}) {
  const [allClosed, setAllClosed] = useState(false);
  const label = 'Agents';
  if (state.kind === 'failed') {
    return (
      <Section label={label}>
        <Notice tone="error" title={state.title} detail={state.detail} />
      </Section>
    );
  }
  if (state.kind === 'loading' || book === null) {
    return (
      <Section label={label}>
        <Loading />
      </Section>
    );
  }
  if (state.agents.length === 0) {
    return (
      <Section label={label}>
        <View style={styles.hire}>
          <Text style={text.dim}>
            No agents yet. An agent trades for you inside a mandate you set.
          </Text>
          <Button label="Browse agents" kind="soft" size="sm" onPress={onHire} />
        </View>
      </Section>
    );
  }
  const closed = allClosed ? book.closed : book.closed.slice(0, CLOSED_PREVIEW);
  return (
    <Section label={label}>
      <Text style={text.caption}>
        Their funds, their trades. Open one to ask it to close, amend or revoke.
      </Text>

      <SubHead
        title="Agent balances"
        aside={book.total !== null ? shown(dollars(book.total.usd), hidden) : null}
      />
      {book.balances.length === 0 ? (
        <Text style={[text.dim, styles.empty]}>No agent holds anything right now.</Text>
      ) : (
        book.balances.map((row, i) => (
          <AgentBalanceLine
            key={row.key}
            row={row}
            hidden={hidden}
            onPress={() => onOpen(row.agentId)}
            last={i === book.balances.length - 1}
          />
        ))
      )}

      <SubHead title="Open positions" aside={book.open.length ? `${book.open.length}` : null} />
      {book.open.length === 0 ? (
        <Text style={[text.dim, styles.empty]}>No agent has a position open.</Text>
      ) : (
        book.open.map((row, i) => (
          <AgentPositionLine
            key={row.key}
            row={row}
            hidden={hidden}
            onPress={() => onOpen(row.agentId)}
            last={i === book.open.length - 1}
          />
        ))
      )}

      <SubHead
        title="Closed positions"
        aside={book.closed.length ? `${book.closed.length}` : null}
      />
      {book.closed.length === 0 ? (
        book.closedPending ? (
          <Loading />
        ) : (
          <Text style={[text.dim, styles.empty]}>No agent has closed a trade yet.</Text>
        )
      ) : (
        closed.map((row, i) => (
          <AgentClosedLine
            key={row.key}
            row={row}
            hidden={hidden}
            onPress={() => onOpen(row.agentId)}
            last={i === closed.length - 1}
          />
        ))
      )}
      {book.closed.length > CLOSED_PREVIEW ? (
        <Button
          label={allClosed ? 'Show fewer' : `Show all ${book.closed.length}`}
          kind="soft"
          size="sm"
          onPress={() => setAllClosed((all) => !all)}
          style={styles.more}
        />
      ) : null}
    </Section>
  );
}

function History({
  fills,
  hidden,
  now,
}: {
  fills: ReturnType<typeof useFills>;
  hidden: boolean;
  now: number;
}) {
  // SEN-179: a fill that closed a round trip carries what the trip realised,
  // from the same replay as Positions → Closed (only over complete histories).
  const realised = useMemo(() => {
    const list = closedList(fills.fills, fills.coverage);
    return new Map(
      list.positions.map((p) => [p.closedBy, { pnl: p.realisedPnl, asset: p.pnlAsset }]),
    );
  }, [fills.fills, fills.coverage]);
  const days = fillDays(fills.fills, now, realised);
  const perplNote = perplFillsNote(fills.perplGap);
  return (
    <View>
      <SubHead title="Fills" />
      <Text style={[text.caption, styles.historyNote]}>
        Only what you traded. Your agents' fills stay in their own ledgers.
        {perplNote ? ` ${perplNote}` : ''}
      </Text>
      {days.length === 0 ? (
        <Text style={[text.dim, styles.empty]}>No fills yet.</Text>
      ) : (
        days.map((day) => (
          <View key={day.key}>
            <Text style={[text.label, styles.day]}>{day.label}</Text>
            {day.fills.map((fill) => (
              <FillLine key={fill.key} fill={fill} hidden={hidden} />
            ))}
          </View>
        ))
      )}
      {fills.hasMore ? (
        <Button
          label="Older fills"
          kind="soft"
          size="sm"
          busy={fills.loadingMore}
          onPress={fills.loadMore}
          style={styles.more}
        />
      ) : null}
    </View>
  );
}

/** The same sheet Home opens: the whole address, and the system share sheet. */
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
        Send USDC (for spot on Kuru) or AUSD (for perps on Perpl) on Monad testnet to your wallet.
        Gas is sponsored, so you never need MON.
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

type SheetNotice = { tone: 'info' | 'error'; title: string; detail?: string };

/**
 * The cancel confirmation: what comes off the book, what goes back to cash,
 * and the race a partial fill can win. Neither venue can amend, so the sheet
 * says how to change a price instead of offering an Edit.
 *
 * A Kuru cancel runs through `runTrade` (SEN-144): the phone builds the
 * `kuru.cancel` intent from its own market table, the server prepares it, the
 * verifier checks it cancels exactly this order's slot, and only then does the
 * passkey sign. Perpl cancels wait for U-14, so their confirm stays disabled.
 */
function CancelSheet({
  row,
  hidden,
  trading,
  perplApiKey,
  onClose,
  onSettled,
}: {
  row: OrderRow | null;
  hidden: boolean;
  trading: boolean;
  /** This device's enrolled Perpl key (SEN-179): a Perpl order is cancelled with it. */
  perplApiKey: string | null;
  onClose: () => void;
  /** A cancel reached the server (whatever its outcome): re-read the orders. */
  onSettled: () => void;
}) {
  const { trade, wallet, auth } = useSession();
  const [phase, setPhase] = useState<TradeFlowState['phase'] | null>(null);
  const [notice, setNotice] = useState<SheetNotice | null>(null);
  const order = row?.order;
  const spot = order?.venue === 'kuru';
  const side = order?.side === 'buy' ? 'buy' : 'sell';
  const draft = order ? kuruCancelDraft(order) : null;
  const busy = phase !== null;

  // A notice belongs to the order it was about; a new row starts clean.
  useEffect(() => setNotice(null), [row?.key]);

  /**
   * A Perpl order (SEN-179) is cancelled the way the perp ticket places one:
   * this device's trading key signs in on a socket of its own and sends the
   * cancel. No passkey prompt, and nothing the server could do for you.
   */
  const cancelPerpl = async () => {
    const derive = auth.perplTradeKey;
    const address = wallet.wallet?.address;
    if (!order || perplApiKey === null || derive === null || address === undefined) {
      setNotice({
        tone: 'error',
        title: 'Perps aren’t set up on this device',
        detail: 'Finish perps setup from Portfolio, then cancel it here.',
      });
      return;
    }
    setNotice(null);
    setPhase('committing');
    let trader: ReturnType<typeof createAppPerplTrader> | null = null;
    try {
      const key = derive(address);
      trader = createAppPerplTrader({
        credentials: { apiKey: perplApiKey, secretKey: key.secretKey },
      });
      key.secretKey.fill(0);
      const result = await trader.cancel({ symbol: order.symbol, orderId: order.id });
      onSettled();
      if (result.status === 'cancelled' || result.status === 'filled') {
        onClose();
      } else {
        setNotice({
          tone: 'info',
          title: 'Cancel sent, not confirmed yet',
          detail: 'The order leaves the list once Perpl confirms it.',
        });
      }
    } catch (caught) {
      setNotice({
        tone: 'error',
        title: 'The cancel didn’t go through',
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      trader?.release();
      setPhase(null);
    }
  };

  const confirm = async () => {
    if (!spot) {
      await cancelPerpl();
      return;
    }
    const walletId = wallet.wallet?.walletId;
    const address = wallet.wallet?.address;
    if (draft === null || trade === null || walletId === undefined || address === undefined) {
      setNotice({
        tone: 'error',
        title: 'Your wallet isn’t ready',
        detail: 'Try again in a moment.',
      });
      return;
    }
    setNotice(null);
    setPhase('preparing');
    try {
      const outcome = await runTrade(
        trade,
        draft,
        { walletId, wallet: address },
        auth.signPrivyAuthorization,
        (state) => setPhase(state.phase),
      );
      onSettled();
      if (outcome.status === 'completed') {
        onClose();
      } else if (outcome.status === 'pending') {
        // Signed and sent, so never reported as failed (flow.ts `follow`).
        setNotice({
          tone: 'info',
          title: 'Cancel sent, not confirmed yet',
          detail: 'The order leaves the list once the cancel lands.',
        });
      } else {
        setNotice({
          tone: 'error',
          title:
            outcome.status === 'expired' ? 'The cancel expired' : 'The cancel didn’t go through',
          detail: 'The order may still be on the book. Pull to refresh and try again.',
        });
      }
    } catch (caught) {
      setNotice({ tone: 'error', ...describeTradeError(caught) });
    } finally {
      setPhase(null);
    }
  };
  return (
    <Sheet
      visible={row !== null}
      title={row ? `Cancel your ${row.base} ${side}?` : ''}
      onClose={onClose}
    >
      {row && order ? (
        <>
          <Text style={[text.dim, styles.sheetLead]}>
            {spot
              ? `It comes off the Kuru book and what it reserved goes back to your cash.`
              : 'It comes off the Perpl book and its margin goes back to your Perpl account.'}
          </Text>
          <Row
            label="Order"
            value={`${side === 'buy' ? 'Buy' : 'Sell'} ${shown(
              amountText(row.remaining, row.base),
              hidden,
            )} ${row.base}${order.price !== null ? ` at ${order.price}` : ''}`}
          />
          {row.backToCash ? (
            <Row label="Back to cash" value={shown(row.backToCash, hidden)} />
          ) : null}
          <Row label="Placed" value={row.placed} />
          <Text style={[text.caption, styles.sheetLead]}>
            {spot ? 'Kuru' : 'Perpl'} can't amend an order: to change the price, cancel and place a
            new one. If part fills before the cancel lands, you keep what filled.
          </Text>
          {notice ? (
            <View style={styles.sheetLead}>
              <Notice tone={notice.tone} title={notice.title} detail={notice.detail} />
            </View>
          ) : null}
          <Button
            label={busy ? phaseLabel(phase) : spot ? 'Cancel order with passkey' : 'Cancel order'}
            kind="primary"
            disabled={(spot ? draft === null : perplApiKey === null) || !trading}
            busy={busy}
            onPress={() => void confirm()}
            style={styles.sheetButton}
          />
          {!spot && perplApiKey === null ? (
            <Text style={[text.caption, styles.pending]}>
              Set up perps on this device to cancel Perpl orders from here.
            </Text>
          ) : null}
          <Button label="Keep it on the book" onPress={onClose} style={styles.keep} />
        </>
      ) : null}
    </Sheet>
  );
}

/** The confirm button's label while the flow runs, so a slow step reads as progress. */
function phaseLabel(phase: TradeFlowState['phase'] | null): string {
  switch (phase) {
    case 'verifying':
    case 'signing':
      return 'Checking and signing';
    case 'committing':
    case 'following':
    case 'settled':
      return 'Cancelling';
    default:
      return 'Preparing the cancel';
  }
}

const styles = StyleSheet.create({
  perpsCard: { marginBottom: 12, gap: 8 },
  head: {
    height: 48,
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  net: {
    fontFamily: font.chain,
    fontSize: 10,
    color: color.textFaint,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: RADIUS.stone,
  },
  tabs: { marginTop: 12 },
  subHead: {
    marginTop: 20,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  subTitle: { fontFamily: font.semibold, fontSize: 15, lineHeight: 22, color: color.text },
  empty: { marginTop: 6 },
  unread: { marginTop: 10 },
  coming: { marginTop: 20 },
  comingText: { marginTop: 6 },
  hire: { gap: 10, alignItems: 'flex-start' },
  historyNote: { marginTop: 2 },
  day: { marginTop: 18, marginBottom: 2 },
  more: { marginTop: 12, alignSelf: 'flex-start' },
  addressWell: {
    marginVertical: 16,
    padding: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  address: { fontSize: 14, lineHeight: 22, color: color.text },
  sheetLead: { marginVertical: 8 },
  sheetButton: { marginTop: 14 },
  pending: { marginTop: 6, textAlign: 'center' },
  keep: { marginTop: 8, borderWidth: 0 },
});
