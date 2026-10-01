/**
 * The spot order ticket on Kuru (SEN-119, plan U-13; the study's `trade.html`
 * → "Spot ticket on Kuru" and "Results"). The asset screen's Buy/Sell and the
 * Trade button's market picker push here.
 *
 * Four stages on one route, because each hands its numbers to the next and a
 * navigation between them would only be a way to lose them:
 *
 * 1. **Ticket.** Buy/Sell, Market/Limit, a keypad, % presets. A market buy is
 *    typed in USDC and answered in the base; everything else is typed in the
 *    base. The CTA carries the reason it can't go yet.
 * 2. **Review.** The phone re-reads the book (`readMarketFacts`) and freezes
 *    the worst price it computed, because that exact number is what the order
 *    is signed with (`runTrade` refuses a different one with
 *    `TradePriceMovedError`). After 10 s the button falls back to "Refresh
 *    quote". The final confirm is a hold, in the side's colour — the only
 *    mint/berry button in the flow — or a plain press under reduced motion.
 * 3. **Execution.** `runTrade`'s phases, then each prepared step as a stone:
 *    solid once it landed, breathing while it lands, empty while it waits.
 * 4. **Result.** Filled, partly filled (said as "Filled 62% · rest
 *    cancelled", never rounded up) or resting, and where the unspent money is.
 *
 * Trading off (`useTradingEnabled`) shows the whole ticket as "coming", never
 * a half-enabled form. Perps are U-14: a Perpl market says so and offers an
 * agent instead. Every rule lives in `trade/ticket.ts`, under test.
 *
 * On the web (SEN-167) the ticket also takes the keyboard: digits, `.` and
 * Backspace drive the same `pressKey` the keypad does, Tab moves between a
 * limit's two fields, Enter is the CTA when it is enabled, and holding Enter
 * fills the hold-to-confirm. Haptics are no-ops there, so every key press
 * lights its keypad key instead. A wide window also embeds the ticket beside
 * the market's chart (`TicketPanel`); the route file only re-exports this one.
 */
import { KURU_TESTNET_MARKETS, NATIVE_TOKEN, type KuruMarketConfig } from '@sente/venues/kuru';
import * as Haptics from '@/platform/haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { erc20Abi, type Address } from 'viem';

import { formatAtoms, formatFixedAtoms } from '@/agents/amounts';
import { publicClient } from '@/chain';
import type { MarketDto, VenueId } from '@/markets/api';
import { linePoints, livePrice, parseVenue } from '@/markets/asset';
import { useKlines, useMarkets, useQuote, useTicker } from '@/markets/hooks';
import { useSession } from '@/session';
import { TradeApiError } from '@/trade/api';
import {
  describeTradeError,
  runTrade,
  TradePriceMovedError,
  type KuruTradeDraft,
  type TradeFlowState,
  type TradeOutcome,
} from '@/trade/flow';
import {
  readKuruFree,
  readMarketFacts,
  worstPriceUnits,
  type MarketFacts,
} from '@/trade/kuruMarket';
import {
  amountAsset,
  amountDecimals,
  DEFAULT_SLIPPAGE_BPS,
  evaluateTicket,
  feePpsOf,
  fundsLines,
  MON_RESERVE_ATOMS,
  presetAmount,
  PRESETS,
  pressKey,
  QUOTE_MAX_AGE_MS,
  resultView,
  reviewRows,
  shortSize,
  SLIPPAGE_CHOICES_BPS,
  slippageFraction,
  slippageText,
  spendable,
  stepCaption,
  stepState,
  stepsIntro,
  toUnits,
  unitsToDecimal,
  type Key,
  type OrderType,
  type Side,
  type StepState,
  type TicketInput,
  type TicketMarket,
} from '@/trade/ticket';
import type { PreparedTrade, TradeFunds, TradeView } from '@/trade/types';
import { useTradingEnabled } from '@/trade/useTradingEnabled';
import { Chart } from '@/ui/chart/Chart';
import { ComingNext } from '@/ui/ComingNext';
import { Pill, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  ButtonRow,
  Chip,
  Chips,
  IconButton,
  isHovered,
  Loading,
  Notice,
  Row,
  Segmented,
  Sheet,
  TopBar,
  useWide,
} from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';
import { BigNumber, ChangeText, TokenGlyph } from '@/ui/trading';
import { formatPct, pctChange } from '@/ui/tradingFormat';

/** How long the book read under the ticket is trusted before it is read again. */
const FACTS_MS = 5_000;
/** How long the confirm must be held. Long enough to be deliberate, short enough not to annoy. */
const HOLD_MS = 1_200;
const CHART_HEIGHT = 120;
/** How long a typed key lights its keypad key: the web's stand-in for a haptic tick. */
const KEY_FLASH_MS = 140;
/** The side colours: the final confirm, and the selected side segment. */
const SIDE_TONE: Record<Side, string> = { buy: color.mint, sell: color.berry };

export default function TicketRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ venue?: string; symbol?: string; side?: string }>();
  const venue = parseVenue(params.venue);
  const symbol = typeof params.symbol === 'string' ? params.symbol : '';
  const side: Side = params.side === 'sell' ? 'sell' : 'buy';
  const trading = useTradingEnabled();
  const markets = useMarkets();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/markets'));

  const market = useMemo(
    () => markets.data?.markets.find((m) => m.venue === venue && m.symbol === symbol) ?? null,
    [markets.data, venue, symbol],
  );
  const config = useMemo(() => (venue === 'kuru' ? kuruConfig(symbol) : null), [venue, symbol]);

  if (venue === 'perpl') {
    // U-14 builds the perp ticket; until then the honest route is an agent.
    return (
      <Frame onClose={close}>
        <Text style={[text.display, styles.title]}>{symbol}</Text>
        <ComingNext
          icon="trade"
          title="Perps from your wallet are coming"
          detail="Longs and shorts on Perpl, with leverage, from your own account. Until then, an agent can trade this market for you, inside limits you set."
          points={[
            'Margin, leverage and a liquidation estimate',
            'Take-profit and stop on the ticket',
            'Close from Portfolio',
          ]}
        />
        <Button
          kind="primary"
          label="Hire an agent"
          icon="agents"
          onPress={() => router.push('/agents?segment=presets')}
          style={styles.spaced}
        />
      </Frame>
    );
  }
  if (!trading) {
    return (
      <Frame onClose={close}>
        <Text style={[text.display, styles.title]}>{symbol || 'Trade'}</Text>
        <ComingNext
          icon="trade"
          title="Trading from your wallet is coming"
          detail="Your own orders from your own wallet, alongside your agents'. This server hasn't turned it on yet."
          points={[
            'Buy and sell spot on Kuru',
            'Market orders with a slippage bound you set',
            'Limit orders that rest on the book',
          ]}
        />
      </Frame>
    );
  }
  if (venue === null || config === null) {
    return (
      <Frame onClose={close}>
        <Notice tone="error" title="There's no such market" detail="Pick one from Markets." />
      </Frame>
    );
  }
  if (market === null) {
    return (
      <Frame onClose={close}>
        {markets.error ? (
          <Notice tone="error" title="Couldn't load this market" detail={markets.error.message} />
        ) : (
          <Loading />
        )}
      </Frame>
    );
  }
  return (
    <Ticket
      key={symbol}
      market={market}
      config={config}
      venue={venue}
      initialSide={side}
      onClose={close}
    />
  );
}

/** A Kuru market the phone has a config for: the only kind `TicketPanel` can embed. */
export function canEmbedTicket(market: MarketDto): boolean {
  return market.venue === 'kuru' && kuruConfig(market.symbol) !== null;
}

function kuruConfig(symbol: string): KuruMarketConfig | null {
  return KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol) ?? null;
}

/**
 * The ticket beside a market's chart on a wide web window (SEN-167): the same
 * `Ticket`, without a close button or a second market header. Whatever would
 * close the route — Done, "Keep trading", leaving an error — starts a fresh
 * ticket in place instead. The caller checks `canEmbedTicket` and that
 * trading is on; this renders nothing for a market it cannot ticket.
 */
export function TicketPanel({ market }: { market: MarketDto }) {
  const [round, setRound] = useState(0);
  const config = useMemo(() => kuruConfig(market.symbol), [market.symbol]);
  if (market.venue !== 'kuru' || config === null) return null;
  return (
    <Ticket
      key={`${market.symbol}:${round}`}
      market={market}
      config={config}
      venue="kuru"
      initialSide="buy"
      embedded
      onClose={() => setRound((n) => n + 1)}
    />
  );
}

function Frame({
  onClose,
  embedded = false,
  children,
}: {
  onClose: () => void;
  /** Inside `TicketPanel`: there is no route to close, so no close button. */
  embedded?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 40 },
      ]}
    >
      {embedded ? null : (
        <TopBar right={<IconButton icon="close" label="Close" onPress={onClose} />} />
      )}
      {children}
    </ScrollView>
  );
}

// ─── The ticket ─────────────────────────────────────────────────────────────

type Stage =
  | { kind: 'ticket' }
  | { kind: 'review'; facts: MarketFacts; at: number; moved?: boolean }
  | {
      kind: 'running';
      phase: TradeFlowState['phase'];
      /** The steps as prepared (all waiting), until the first status view replaces them. */
      prepared: PreparedTrade | null;
      view: TradeView | null;
    }
  | { kind: 'done'; outcome: TradeOutcome }
  | { kind: 'error'; title: string; detail: string };

/** What the result screen needs from the order that was sent. */
type Sent = { side: Side; orderType: OrderType; price: string; slippageBps: number };

function Ticket({
  market,
  config,
  venue,
  initialSide,
  embedded = false,
  onClose,
}: {
  market: MarketDto;
  config: KuruMarketConfig;
  venue: VenueId;
  initialSide: Side;
  /** Beside the chart (`TicketPanel`): no close button, no market header of its own. */
  embedded?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const session = useSession();
  const [side, setSide] = useState<Side>(initialSide);
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [focus, setFocus] = useState<'amount' | 'price'>('amount');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [gear, setGear] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'ticket' });
  const [sent, setSent] = useState<Sent | null>(null);

  const reviewing = stage.kind === 'review';
  const walletAddress = session.wallet.wallet?.address ?? null;
  const live = useMarketFacts(config, stage.kind === 'ticket');
  const funds = useTicketFunds(config, walletAddress);
  const ticker = useTicker(venue, market.symbol);
  const klines = useKlines(venue, market.symbol, '1h', { limit: 48 });

  // The review reads the facts it froze; the ticket reads the live ones.
  const facts = stage.kind === 'review' ? stage.facts : live.facts;
  const tm = useMemo(() => ticketMarket(config, market, facts), [config, market, facts]);
  const available = side === 'buy' ? funds.quote : funds.base;
  const worstUnits = useMemo(() => {
    if (facts === null) return undefined;
    const best = side === 'buy' ? facts.bestAsk : facts.bestBid;
    return best === null ? null : worstPriceUnits(best, slippageBps, facts.params.tickSize, side);
  }, [facts, side, slippageBps]);

  const base: TicketInput = {
    market: tm,
    side,
    orderType,
    amount,
    limitPrice,
    slippageBps,
    worstUnits,
    available,
    quote: null,
  };
  const sized = evaluateTicket(base);
  // The quote is asked for the size this ticket would place, to four
  // significant digits: close enough for an estimate, and it doesn't re-key
  // (and blank) the quote every time the best ask moves by a tick.
  const quoteInput =
    orderType === 'market' && sized.sizeUnits !== null && sized.sizeUnits > 0n
      ? {
          side,
          size: shortSize(unitsToDecimal(sized.sizeUnits, tm.sizePrecision)).replace(/,/g, ''),
          maxSlippage: slippageFraction(slippageBps),
        }
      : null;
  const quote = useQuote(venue, market.symbol, quoteInput);
  const input: TicketInput = {
    ...base,
    quote:
      quote.data && quoteInput ? { ...quote.data, stale: quote.data.stale || quote.stale } : null,
  };
  const ticket = evaluateTicket(input);

  const lastPrice = livePrice(ticker.data);
  const points = useMemo(
    () => linePoints(klines.data?.klines ?? [], lastPrice),
    [klines.data, lastPrice],
  );
  const change = ticker.data?.change24hPct != null ? Number(ticker.data.change24hPct) * 100 : null;

  const press = (key: Key) => {
    void Haptics.selectionAsync();
    if (orderType === 'limit' && focus === 'price') {
      setLimitPrice((v) => pressKey(v, key, precisionOf(tm.pricePrecision)));
    } else {
      setAmount((v) => pressKey(v, key, amountDecimals(tm, side, orderType)));
    }
  };

  const preset = (pct: (typeof PRESETS)[number]['pct']) => {
    const next = presetAmount({
      pct,
      side,
      orderType,
      available,
      limitPriceUnits: limitPrice === '' ? null : toUnits(limitPrice, tm.pricePrecision),
      market: tm,
    });
    if (next !== null) {
      void Haptics.selectionAsync();
      setAmount(next);
      setFocus('amount');
    }
  };

  // The unit the amount field holds changes with side and type, so the typed
  // number would silently change meaning: clear it instead.
  const switchSide = (next: Side) => {
    if (next === side) return;
    setSide(next);
    setAmount('');
  };
  const switchType = (next: OrderType) => {
    if (next === orderType) return;
    setOrderType(next);
    setAmount('');
    setFocus(next === 'limit' ? 'price' : 'amount');
    if (next === 'limit' && limitPrice === '' && lastPrice !== null) {
      const units = toUnits(lastPrice, tm.pricePrecision);
      if (units !== null)
        setLimitPrice(unitsToDecimal(units - (units % tm.tickSize), tm.pricePrecision));
    }
  };

  const review = useCallback(async () => {
    try {
      const fresh = await readMarketFacts(publicClient, config);
      setStage({ kind: 'review', facts: fresh, at: Date.now() });
    } catch (error) {
      setStage({ kind: 'error', ...describeTradeError(error) });
    }
  }, [config]);

  const confirm = async () => {
    const trade = session.trade;
    const wallet = session.wallet.wallet;
    if (
      ticket.sizeUnits === null ||
      ticket.priceUnits === null ||
      trade === null ||
      wallet === null
    )
      return;
    const draft: KuruTradeDraft = {
      kind: 'kuru.place',
      market: config.address,
      side,
      orderType,
      sizeAtoms: ticket.sizeUnits.toString(),
      priceUnits: ticket.priceUnits.toString(),
    };
    setSent({
      side,
      orderType,
      price: unitsToDecimal(ticket.priceUnits, tm.pricePrecision),
      slippageBps,
    });
    setStage({ kind: 'running', phase: 'reading_market', prepared: null, view: null });
    try {
      const outcome = await runTrade(
        trade,
        draft,
        { walletId: wallet.walletId, wallet: wallet.address, slippageBps },
        session.auth.signPrivyAuthorization,
        (flow) =>
          setStage((s) =>
            s.kind === 'running'
              ? {
                  kind: 'running',
                  phase: flow.phase,
                  prepared: 'prepared' in flow ? flow.prepared : s.prepared,
                  view: flow.phase === 'following' ? flow.view : s.view,
                }
              : s,
          ),
      );
      void Haptics.notificationAsync(
        outcome.status === 'completed'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      setStage({ kind: 'done', outcome });
      funds.refresh();
      void session.wallet.refresh();
    } catch (error) {
      if (error instanceof TradePriceMovedError) {
        // Never a silent retry at a price the user didn't see: back to review.
        try {
          const fresh = await readMarketFacts(publicClient, config);
          setStage({ kind: 'review', facts: fresh, at: Date.now(), moved: true });
          return;
        } catch (readError) {
          setStage({ kind: 'error', ...describeTradeError(readError) });
          return;
        }
      }
      setStage({ kind: 'error', ...describeTradeError(error) });
    }
  };

  const reset = (nextAmount = '') => {
    setAmount(nextAmount);
    setStage({ kind: 'ticket' });
  };

  // A typed key goes through `press`, like a tapped one, and lights its key.
  const [lit, setLit] = useState<Key | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (litTimer.current !== null) clearTimeout(litTimer.current);
    },
    [],
  );
  const typeKey = (key: Key) => {
    press(key);
    setLit(key);
    if (litTimer.current !== null) clearTimeout(litTimer.current);
    litTimer.current = setTimeout(() => setLit(null), KEY_FLASH_MS);
  };
  useWebKeys(stage.kind === 'ticket' && !gear, (event) => {
    if (event.type !== 'keydown') return false;
    if (/^[0-9]$/.test(event.key)) typeKey(event.key as Key);
    else if (event.key === '.' || event.key === ',') typeKey('.');
    else if (event.key === 'Backspace') typeKey('back');
    else if (event.key === 'Tab' && orderType === 'limit') {
      setFocus((f) => (f === 'amount' ? 'price' : 'amount'));
    } else if (event.key === 'Enter') {
      // Taken even when the CTA is off, so it can't press whatever has focus.
      if (ticket.cta.enabled && !event.repeat) void review();
    } else return false;
    return true;
  });

  if (stage.kind === 'running') {
    return (
      <Execution
        phase={stage.phase}
        prepared={stage.prepared}
        view={stage.view}
        heading={`${side === 'buy' ? 'Buying' : 'Selling'} ${
          ticket.sizeUnits !== null
            ? shortSize(unitsToDecimal(ticket.sizeUnits, tm.sizePrecision))
            : ''
        } ${config.base.symbol}`}
        embedded={embedded}
        onLeave={onClose}
      />
    );
  }
  if (stage.kind === 'done' && sent !== null) {
    return (
      <Result
        outcome={stage.outcome}
        sent={sent}
        config={config}
        points={points}
        embedded={embedded}
        onClose={onClose}
        onAgain={reset}
        onRetry={() => reset(amount)}
        onPortfolio={() => router.push('/portfolio')}
        onCancelled={() => {
          funds.refresh();
          void session.wallet.refresh();
        }}
      />
    );
  }
  if (stage.kind === 'error') {
    return (
      <Frame onClose={onClose} embedded={embedded}>
        <Text style={[text.display, styles.title]}>{stage.title}</Text>
        <Text style={[text.body, styles.spaced]}>{stage.detail}</Text>
        <Button
          kind="primary"
          label="Back to the ticket"
          onPress={() => reset(amount)}
          style={styles.spaced}
        />
      </Frame>
    );
  }

  const assetUnit =
    amountAsset(side, orderType) === 'quote' ? config.quote.symbol : config.base.symbol;
  const availableText =
    available === null
      ? null
      : `${balanceText(available, side === 'buy' ? config.quote : config.base)} available`;
  const bad = ticket.problem?.kind === 'insufficient';

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {embedded && !reviewing ? null : (
          <TopBar
            back={
              reviewing
                ? { label: 'Edit order', onPress: () => setStage({ kind: 'ticket' }) }
                : undefined
            }
            right={
              embedded ? undefined : <IconButton icon="close" label="Close" onPress={onClose} />
            }
          />
        )}
        {embedded ? (
          // The market's own header is beside it; this only keeps the price in view.
          <View style={[styles.identity, styles.panelHead]}>
            <Text style={[text.label, styles.grow]}>Trade {market.base}</Text>
            <Text style={[text.strong, text.num]}>{lastPrice ?? '—'}</Text>
          </View>
        ) : (
          <View style={styles.identity}>
            <TokenGlyph symbol={market.base} />
            <View style={styles.grow}>
              <Text style={text.title}>{market.base}</Text>
              <Text style={text.caption}>{market.symbol} · Kuru spot</Text>
            </View>
            <View style={styles.right}>
              <Text style={[text.strong, text.num]}>{lastPrice ?? '—'}</Text>
              <ChangeText pct={change} suffix=" today" />
            </View>
          </View>
        )}

        {stage.kind === 'review' ? (
          <Review
            input={input}
            ticket={ticket}
            at={stage.at}
            moved={stage.moved === true}
            config={config}
            keys={!gear}
            onRefresh={() => void review()}
            onConfirm={() => void confirm()}
          />
        ) : (
          <>
            <View style={styles.segs}>
              <SideSegment side={side} onChange={switchSide} />
              <View style={styles.grow}>
                <Segmented
                  options={[
                    { value: 'market', label: 'Market' },
                    { value: 'limit', label: 'Limit' },
                  ]}
                  value={orderType}
                  onChange={switchType}
                />
              </View>
            </View>

            {orderType === 'market' ? (
              <View style={styles.amount}>
                <Text
                  style={[styles.amountText, bad && text.danger]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {amount === '' ? <Text style={styles.placeholder}>0</Text> : amount}
                  <Text style={styles.amountUnit}> {assetUnit}</Text>
                </Text>
                <Text style={[text.dim, text.num]}>{ticket.sub ?? ' '}</Text>
              </View>
            ) : (
              <LimitFields
                points={points}
                limitPrice={limitPrice}
                amount={amount}
                focus={focus}
                onFocus={setFocus}
                lastPrice={lastPrice}
                config={config}
                total={ticket.sub}
                availableText={availableText}
                bad={bad}
              />
            )}

            <View style={styles.presets}>
              {PRESETS.map((p) => (
                <Pressable
                  key={p.pct}
                  accessibilityRole="button"
                  accessibilityLabel={p.pct === 100 ? 'Max' : `${p.label} of what you have`}
                  onPress={() => preset(p.pct)}
                  style={({ pressed }) => [styles.preset, pressed && styles.pressed]}
                >
                  <Text style={styles.presetText}>{p.label}</Text>
                </Pressable>
              ))}
            </View>
            {orderType === 'market' && availableText ? (
              <Text style={[text.caption, styles.center]}>{availableText}</Text>
            ) : null}

            {ticket.problem?.kind === 'insufficient' ? (
              <View style={styles.err} accessibilityRole="alert">
                <Icon name="bolt" size={14} color={color.berry} />
                <Text style={[text.dim, styles.grow]}>
                  <Text style={text.strong}>That's {ticket.problem.short} more than you have.</Text>{' '}
                  Tap Max for {ticket.problem.have}, or{' '}
                  <Text style={styles.link} onPress={() => router.push('/')}>
                    add {side === 'buy' ? config.quote.symbol : config.base.symbol}
                  </Text>
                  .
                </Text>
              </View>
            ) : null}

            <Keypad onKey={press} lit={lit} compact={wide} />

            <Button
              kind="primary"
              label={ticket.cta.label}
              disabled={!ticket.cta.enabled}
              onPress={() => void review()}
            />
            {wide ? (
              <Text style={[text.caption, styles.center, styles.spacedSm]}>
                {orderType === 'limit'
                  ? 'Type a price and an amount · Tab switches field · Enter to review'
                  : 'Type an amount · Enter to review'}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Max slippage ${slippageText(slippageBps)}. Change it`}
              onPress={() => setGear(true)}
              disabled={orderType === 'limit'}
              style={styles.disclose}
            >
              <View style={styles.grow}>
                {ticket.disclosure.map((line) => (
                  <Text key={line} style={[text.caption, styles.center]}>
                    {line}
                  </Text>
                ))}
              </View>
              {orderType === 'market' ? (
                <Icon name="more" size={14} color={color.textFaint} />
              ) : null}
            </Pressable>
          </>
        )}
      </ScrollView>

      <Sheet visible={gear} title="Max slippage" onClose={() => setGear(false)}>
        <Text style={text.dim}>
          A market order is sent as an immediate-or-cancel limit this far from the best price.
          Whatever can't fill inside it is cancelled, never filled worse.
        </Text>
        <Chips>
          {SLIPPAGE_CHOICES_BPS.map((bps) => (
            <Chip
              key={bps}
              label={slippageText(bps)}
              selected={bps === slippageBps}
              onPress={() => {
                setSlippageBps(bps);
                setGear(false);
              }}
            />
          ))}
        </Chips>
      </Sheet>
    </View>
  );
}

/** The phone's `TicketMarket`: the config's units, the chain's fees, the API's minimum. */
function ticketMarket(
  config: KuruMarketConfig,
  market: MarketDto,
  facts: MarketFacts | null,
): TicketMarket {
  return {
    symbol: config.symbol,
    base: { symbol: config.base.symbol, decimals: config.base.decimals },
    quote: { symbol: config.quote.symbol, decimals: config.quote.decimals },
    pricePrecision: config.pricePrecision,
    sizePrecision: config.sizePrecision,
    tickSize: facts?.params.tickSize ?? config.tickSize,
    // The chain's fees when read (what the verifier's deposit cap uses), else the list's.
    takerFeePps: facts?.params.takerFeePps ?? feePpsOf(market.takerFee),
    makerFeePps: facts?.params.makerFeePps ?? feePpsOf(market.makerFee),
    minNotional: market.minNotional,
  };
}

function precisionOf(precision: bigint): number {
  return precision.toString().length - 1;
}

function balanceText(atoms: bigint, token: { symbol: string; decimals: number }): string {
  const figure =
    token.symbol === 'USDC' || token.symbol === 'AUSD'
      ? formatFixedAtoms(atoms, token.decimals, { places: 2 })
      : shortSize(formatAtoms(atoms, token.decimals, { group: false }));
  return `${figure} ${token.symbol}`;
}

// ─── Data ───────────────────────────────────────────────────────────────────

/**
 * The phone's own read of the book, every few seconds while `live`. The
 * worst price a market order carries is computed from THIS, not from the
 * API's quote: it is what `runTrade` re-reads and compares.
 */
function useMarketFacts(config: KuruMarketConfig, live: boolean) {
  const [facts, setFacts] = useState<MarketFacts | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const read = () =>
      readMarketFacts(publicClient, config).then(
        (next) => {
          if (alive) setFacts(next);
        },
        () => {
          // Keep the last read; the review re-reads before anything is signed.
        },
      );
    void read();
    const timer = setInterval(() => void read(), FACTS_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [config, live]);
  return { facts };
}

/**
 * What the user can fund an order with, per asset: the wallet plus the Kuru
 * account's free balance, from the phone's RPC. MON keeps Monad's 10 MON
 * reserve back. `null` while loading, and on a failed read — an unknown
 * balance leaves the check to the server rather than claiming zero.
 */
function useTicketFunds(config: KuruMarketConfig, wallet: Address | null) {
  const [quote, setQuote] = useState<bigint | null>(null);
  const [base, setBase] = useState<bigint | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (wallet === null) return;
    let alive = true;
    const walletBalance = (token: Address) =>
      token === NATIVE_TOKEN
        ? publicClient.getBalance({ address: wallet })
        : publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet],
          });
    const read = async (token: Address, reserve: bigint) => {
      const [held, free] = await Promise.all([
        walletBalance(token),
        readKuruFree(publicClient, wallet, token),
      ]);
      return spendable(held, free, reserve);
    };
    read(config.quote.address, 0n).then(
      (v) => alive && setQuote(v),
      () => undefined,
    );
    read(config.base.address, config.base.address === NATIVE_TOKEN ? MON_RESERVE_ATOMS : 0n).then(
      (v) => alive && setBase(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [config, wallet, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { quote, base, refresh };
}

/**
 * Hardware keys on the web (SEN-167), while the screen holding the caller is
 * focused and `active`. `handle` sees keydown and keyup and returns whether it
 * took the key; a taken key goes no further. The capture phase is why: Enter
 * would otherwise also press whichever Pressable has focus. A key typed into a
 * text field, or with a modifier (a browser shortcut), is left alone. Native
 * has no hardware-key path here, so this is a no-op there.
 */
function useWebKeys(active: boolean, handle: (event: KeyboardEvent) => boolean) {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || !active) return;
      const listener = (event: KeyboardEvent) => {
        if (event.metaKey || event.ctrlKey || event.altKey || inTextField(event.target)) return;
        if (handleRef.current(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      window.addEventListener('keydown', listener, true);
      window.addEventListener('keyup', listener, true);
      return () => {
        window.removeEventListener('keydown', listener, true);
        window.removeEventListener('keyup', listener, true);
      };
    }, [active]),
  );
}

function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** Buy/Sell. The selected side takes its colour; nothing else on the ticket does until the confirm. */
function SideSegment({ side, onChange }: { side: Side; onChange: (side: Side) => void }) {
  return (
    <View style={styles.sideSeg} accessibilityRole="radiogroup">
      {(['buy', 'sell'] as const).map((s) => {
        const on = s === side;
        return (
          <Pressable
            key={s}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(s)}
            style={[styles.sideBtn, on && { backgroundColor: `${SIDE_TONE[s]}26` }]}
          >
            <Text style={[styles.sideText, on && { color: SIDE_TONE[s] }]}>
              {s === 'buy' ? 'Buy' : 'Sell'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const KEYS: readonly Key[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

function Keypad({
  onKey,
  lit,
  compact,
}: {
  onKey: (key: Key) => void;
  /** The key just typed on a keyboard, lit as if pressed. */
  lit: Key | null;
  /** Shorter keys, for a ticket that is also typed into (wide web). */
  compact: boolean;
}) {
  return (
    <View style={styles.keypad}>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={key === 'back' ? 'Delete' : key === '.' ? 'Decimal point' : key}
          onPress={() => onKey(key)}
          style={(state) => [
            styles.key,
            compact && styles.keyCompact,
            isHovered(state) && styles.keyHover,
            (state.pressed || key === lit) && styles.keyPressed,
          ]}
        >
          {key === 'back' ? (
            <Icon name="back" size={22} color={color.text} />
          ) : (
            <Text style={styles.keyText}>{key}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function LimitFields({
  points,
  limitPrice,
  amount,
  focus,
  onFocus,
  lastPrice,
  config,
  total,
  availableText,
  bad,
}: {
  points: string[];
  limitPrice: string;
  amount: string;
  focus: 'amount' | 'price';
  onFocus: (f: 'amount' | 'price') => void;
  lastPrice: string | null;
  config: KuruMarketConfig;
  total: string | null;
  availableText: string | null;
  bad: boolean;
}) {
  const vs = lastPrice !== null && limitPrice !== '' ? pctChange(lastPrice, limitPrice) : null;
  return (
    <View>
      {points.length > 1 ? (
        <View style={styles.chart}>
          <Chart
            kind="line"
            points={points}
            height={CHART_HEIGHT}
            tone="purple"
            fit={false}
            levels={
              limitPrice !== '' && Number(limitPrice) > 0
                ? [{ price: limitPrice, kind: 'limit', label: 'YOUR LIMIT' }]
                : []
            }
            label={`${config.base.symbol} price with your limit`}
          />
        </View>
      ) : null}
      <FieldBox
        label="Limit price"
        value={limitPrice}
        suffix={`${config.quote.symbol} per ${config.base.symbol}`}
        focused={focus === 'price'}
        onPress={() => onFocus('price')}
        left={
          vs !== null && lastPrice !== null ? `${formatPct(vs, 1)} vs market ${lastPrice}` : ' '
        }
      />
      <FieldBox
        label="Amount"
        value={amount}
        suffix={config.base.symbol}
        focused={focus === 'amount'}
        onPress={() => onFocus('amount')}
        left={total ?? ' '}
        right={availableText ?? undefined}
        bad={bad}
      />
      <View style={styles.well}>
        <Note icon="stop">
          Rests on the book until it fills or you cancel it. Kuru limit orders don't expire.
        </Note>
        <Note icon="shield">What it needs waits in your Kuru account while the order rests.</Note>
      </View>
    </View>
  );
}

function FieldBox({
  label,
  value,
  suffix,
  focused,
  onPress,
  left,
  right,
  bad = false,
}: {
  label: string;
  value: string;
  suffix: string;
  focused: boolean;
  onPress: () => void;
  left: string;
  right?: string;
  bad?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={text.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value || 'empty'}. Edit with the keypad`}
        onPress={onPress}
        style={[styles.fieldInput, focused && styles.fieldFocus, bad && styles.fieldBad]}
      >
        <Text style={[text.strong, text.num, styles.grow]}>
          {value === '' ? <Text style={styles.placeholder}>0</Text> : value}
        </Text>
        <Text style={text.caption}>{suffix}</Text>
      </Pressable>
      <View style={styles.helper}>
        <Text style={[text.caption, text.num]}>{left}</Text>
        {right ? <Text style={[text.caption, text.num]}>{right}</Text> : null}
      </View>
    </View>
  );
}

function Note({ icon, children }: { icon: 'stop' | 'shield'; children: ReactNode }) {
  return (
    <View style={styles.note}>
      <Icon name={icon} size={14} color={color.textDim} />
      <Text style={[text.dim, styles.grow]}>{children}</Text>
    </View>
  );
}

// ─── Review ─────────────────────────────────────────────────────────────────

function Review({
  input,
  ticket,
  at,
  moved,
  config,
  keys,
  onRefresh,
  onConfirm,
}: {
  input: TicketInput;
  ticket: ReturnType<typeof evaluateTicket>;
  at: number;
  moved: boolean;
  config: KuruMarketConfig;
  /** Enter refreshes or holds to confirm (web); off while a sheet is over it. */
  keys: boolean;
  onRefresh: () => void;
  onConfirm: () => void;
}) {
  const now = useNow(1_000);
  const age = Math.max(0, now - at);
  const old = input.orderType === 'market' && age > QUOTE_MAX_AGE_MS;
  useWebKeys(keys && ticket.cta.enabled && old, (event) => {
    if (event.key !== 'Enter') return false;
    if (event.type === 'keydown' && !event.repeat) onRefresh();
    return true;
  });
  const size =
    ticket.sizeUnits !== null ? unitsToDecimal(ticket.sizeUnits, config.sizePrecision) : '0';
  const sizeLabel = `${shortSize(size)} ${config.base.symbol}`;
  const rows = reviewRows(input, ticket);
  const paid =
    input.orderType === 'market' && input.side === 'buy'
      ? `for ${input.amount} ${config.quote.symbol}, at market`
      : input.orderType === 'market'
        ? 'at market'
        : `limit at ${input.limitPrice} ${config.quote.symbol}`;

  return (
    <View>
      <View style={styles.reviewHead}>
        <Text style={[text.title, styles.sheetTitle, styles.grow]}>Review your {input.side}</Text>
        <Pill label={`Quote ${Math.round(age / 1000)}s ago`} tone={old ? 'idle' : 'live'} />
      </View>
      {moved ? (
        <Notice
          title="The price moved — review again"
          detail="The book changed after you confirmed, so nothing was sent. These are the new numbers."
        />
      ) : null}
      <View style={styles.reviewBig}>
        <BigNumber value={size} places={Math.min(4, precisionOf(config.sizePrecision))} />
        <Text style={text.dim}>
          {config.base.symbol} {paid}
        </Text>
      </View>
      {rows.map((row) => (
        <Row key={row.label} label={row.label} value={row.value} mono={row.chain} />
      ))}
      <View style={styles.spaced}>
        {!ticket.cta.enabled ? (
          <Button kind="secondary" label={ticket.cta.label} disabled onPress={() => undefined} />
        ) : old ? (
          <Button kind="primary" label="Refresh quote" onPress={onRefresh} />
        ) : (
          <HoldToConfirm
            side={input.side}
            keys={keys}
            label={`Hold to ${input.side} ${sizeLabel}${
              input.orderType === 'limit' ? ` at ${input.limitPrice}` : ''
            }`}
            onConfirm={onConfirm}
          />
        )}
      </View>
      <View style={styles.passkey}>
        <Icon name="key" size={14} color={color.textDim} />
        <Text style={text.caption}>
          Your passkey signs this. A first Kuru trade can take a few steps.
        </Text>
      </View>
    </View>
  );
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * The final confirm: hold for {@link HOLD_MS}, in the side's colour. Letting
 * go early drains it. Under reduced motion there is no fill to watch, so it is
 * a plain press — same colour, same label.
 */
function HoldToConfirm({
  side,
  keys,
  label,
  onConfirm,
}: {
  side: Side;
  /** Holding Enter (or Space) holds the button, on the web. */
  keys: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const firedRef = useRef(false);
  const tone = SIDE_TONE[side];

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onConfirm();
  }, [onConfirm]);

  const fill = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  const hold = () => {
    void Haptics.selectionAsync();
    progress.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear }, (finished) => {
      if (finished) scheduleOnRN(fire);
    });
  };
  const letGo = () => {
    if (firedRef.current) return;
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: 180 });
  };
  useWebKeys(keys, (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    if (event.repeat) return true;
    if (event.type === 'keydown') {
      if (reduced) fire();
      else hold();
    } else if (!reduced) letGo();
    return true;
  });

  if (reduced) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={fire}
        style={({ pressed }) => [styles.hold, { backgroundColor: tone }, pressed && styles.pressed]}
      >
        <Text style={styles.holdText}>
          {label.replace(/^Hold to (\w)/, (_, c: string) => c.toUpperCase())}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Press and hold to confirm"
      onPressIn={hold}
      onPressOut={letGo}
      style={[styles.hold, { backgroundColor: `${tone}38` }]}
    >
      <Animated.View style={[styles.holdFill, { backgroundColor: tone }, fill]} />
      <Text style={styles.holdText}>{label}</Text>
    </Pressable>
  );
}

// ─── Execution ──────────────────────────────────────────────────────────────

const PHASE_CAPTION: Record<TradeFlowState['phase'], string> = {
  reading_market: 'Reading the book',
  preparing: 'Preparing the order',
  verifying: 'Checking every step against what you confirmed',
  signing: 'Signing with your passkey',
  committing: 'Sending',
  following: 'Landing',
  settled: 'Done',
};

function Execution({
  phase,
  prepared,
  view,
  heading,
  embedded,
  onLeave,
}: {
  phase: TradeFlowState['phase'];
  prepared: PreparedTrade | null;
  view: TradeView | null;
  heading: string;
  embedded: boolean;
  onLeave: () => void;
}) {
  const steps: TradeView['steps'] =
    view?.steps ??
    prepared?.steps.map((s) => ({
      index: s.index,
      kind: s.kind,
      title: s.title,
      status: 'awaiting_signature',
    })) ??
    [];

  return (
    <Frame onClose={onLeave} embedded={embedded}>
      <Text style={[text.display, styles.title]}>{heading}</Text>
      <Text style={[text.dim, styles.spacedSm]}>
        {steps.length > 0 ? stepsIntro(steps.length) : `${PHASE_CAPTION[phase]}…`}
      </Text>
      <View style={styles.steps}>
        {steps.map((step) => {
          const state = stepState(step.status);
          const tx = step.transactionHash;
          return (
            <View key={step.index} style={styles.step}>
              <StepStone state={state} />
              <View style={styles.grow}>
                <View style={styles.stepHead}>
                  <Text style={[text.strong, styles.grow]}>{step.title}</Text>
                  <Text
                    style={[
                      text.caption,
                      state === 'now' && { color: color.purpleHi },
                      state === 'failed' && text.danger,
                    ]}
                  >
                    {stepCaption(step.status)}
                  </Text>
                </View>
                {tx ? (
                  <Text style={text.mono} numberOfLines={1}>
                    {tx.slice(0, 6)}…{tx.slice(-4)}
                    {step.blockNumber
                      ? ` · block ${Number(step.blockNumber).toLocaleString('en-US')}`
                      : ''}
                  </Text>
                ) : null}
                {step.error ? <Text style={[text.caption, text.danger]}>{step.error}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>
      {steps.length > 0 && phase !== 'following' ? (
        <Text style={[text.caption, styles.spacedSm]}>{PHASE_CAPTION[phase]}…</Text>
      ) : null}
      <View style={styles.well}>
        <Note icon="shield">
          If a step fails, nothing is lost. What you deposited stays in your Kuru account; retry the
          order or withdraw it from Portfolio.
        </Note>
      </View>
      <Button
        kind="soft"
        label="Keep trading, it lands without you"
        onPress={onLeave}
        style={styles.spaced}
      />
    </Frame>
  );
}

function StepStone({ state }: { state: StepState }) {
  const reduced = useReducedMotion();
  const breath = useSharedValue(0);
  useEffect(() => {
    if (state !== 'now' || reduced) return;
    breath.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [state, reduced, breath]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.25 + 0.5 * breath.value }));
  if (state === 'done') return <Stone kind="trade" size={18} />;
  if (state === 'failed') return <Stone kind="refusal" size={18} />;
  if (state === 'now') {
    return <Animated.View style={[styles.ring, { borderColor: color.purple }, halo]} />;
  }
  return <View style={[styles.ring, { borderColor: color.lineStrong }]} />;
}

// ─── Result ─────────────────────────────────────────────────────────────────

function Result({
  outcome,
  sent,
  config,
  points,
  embedded,
  onClose,
  onAgain,
  onRetry,
  onPortfolio,
  onCancelled,
}: {
  outcome: TradeOutcome;
  sent: Sent;
  config: KuruMarketConfig;
  points: string[];
  embedded: boolean;
  onClose: () => void;
  onAgain: (amount?: string) => void;
  onRetry: () => void;
  onPortfolio: () => void;
  onCancelled: () => void;
}) {
  const session = useSession();
  const [cancel, setCancel] = useState<{ busy: boolean; done?: string; error?: string }>({
    busy: false,
  });
  const view = outcome.view;
  const money = fundsLines(view?.funds);

  if (outcome.status !== 'completed' || view?.result === undefined) {
    const failedStep = view?.steps.find((s) => stepState(s.status) === 'failed');
    const copy =
      outcome.status === 'pending'
        ? {
            title: 'Still landing',
            detail: 'It was signed and sent; it may still land. Check Portfolio in a minute.',
          }
        : outcome.status === 'expired'
          ? describeTradeError(new TradeApiError(410, 'trade_expired', 'expired'))
          : outcome.status === 'completed'
            ? { title: 'Done', detail: 'The order went through.' }
            : {
                title: 'The order didn’t go through',
                detail: failedStep
                  ? `“${failedStep.title}” ${stepCaption(failedStep.status)}${failedStep.error ? `: ${failedStep.error}` : ''}.`
                  : 'A step failed.',
              };
    return (
      <Frame onClose={onClose} embedded={embedded}>
        <Text style={[text.display, styles.title]}>{copy.title}</Text>
        <Text style={[text.body, styles.spacedSm]}>{copy.detail}</Text>
        {money.length > 0 ? <MoneyRows label="Where your money is" lines={money} /> : null}
        <ButtonRow>
          <Button kind="soft" label="Portfolio" onPress={onPortfolio} style={styles.grow} />
          <Button
            kind="primary"
            label={outcome.status === 'failed' ? 'Retry the order' : 'Done'}
            onPress={outcome.status === 'failed' ? onRetry : onClose}
            style={styles.grow}
          />
        </ButtonRow>
      </Frame>
    );
  }

  const result = view.result;
  const shown = resultView(result, {
    side: sent.side,
    orderType: sent.orderType,
    base: config.base.symbol,
    quote: config.quote.symbol,
    price: sent.price,
    slippageBps: sent.slippageBps,
  });

  const cancelOrder = async () => {
    const trade = session.trade;
    const wallet = session.wallet.wallet;
    if (!result.orderId || trade === null || wallet === null) return;
    setCancel({ busy: true });
    try {
      const done = await runTrade(
        trade,
        { kind: 'kuru.cancel', market: config.address, orderId: result.orderId },
        { walletId: wallet.walletId, wallet: wallet.address },
        session.auth.signPrivyAuthorization,
        () => undefined,
      );
      onCancelled();
      setCancel({
        busy: false,
        ...(done.status === 'completed'
          ? { done: fundsLines(done.view?.funds).join('\n') || 'Cancelled.' }
          : {
              error:
                done.status === 'pending'
                  ? 'Sent; it may still land.'
                  : 'The cancel didn’t go through.',
            }),
      });
    } catch (error) {
      setCancel({ busy: false, error: describeTradeError(error).detail });
    }
  };

  const rest = restAmount(view.funds, config, sent.side);
  const level =
    shown.mark === 'ring'
      ? [
          {
            price: sent.price,
            kind: 'limit' as const,
            label: `${sent.side.toUpperCase()} ${shortSize(result.requestedSize)} ${config.base.symbol}`,
          },
        ]
      : [];

  return (
    <Frame onClose={onClose} embedded={embedded}>
      <ResultMark mark={shown.mark} />
      <View style={styles.centerCol}>
        <Text style={text.dim}>{shown.lead}</Text>
        <View style={styles.bigRow}>
          <BigNumber
            value={shown.amount}
            places={Math.min(2, precisionOf(config.sizePrecision))}
            size="xl"
          />
          <Text style={styles.bigUnit}> {shown.unit}</Text>
        </View>
        <Text style={[text.dim, text.num]}>{shown.detail}</Text>
      </View>
      {shown.mark === 'half' ? (
        <>
          <View style={styles.fillbar}>
            <View style={[styles.fillbarOn, { width: `${shown.filledPct}%` }]} />
          </View>
          <Text style={[text.strong, styles.center]}>{shown.fillLine}</Text>
        </>
      ) : null}
      {shown.why ? <Text style={[text.dim, styles.center]}>{shown.why}</Text> : null}
      {points.length > 1 && (shown.mark === 'full' || shown.mark === 'ring') ? (
        <View style={styles.chart}>
          <Chart
            kind="line"
            points={points}
            height={150}
            fit={shown.mark !== 'ring'}
            markers={shown.mark === 'full' ? [{ index: -1, who: 'you', label: 'You' }] : undefined}
            levels={level}
          />
        </View>
      ) : null}
      {shown.fills.length > 0 ? (
        <View style={styles.spacedSm}>
          <Text style={text.label}>Fills</Text>
          {shown.fills.map((f, i) => (
            <Row key={i} label={f.label} value={f.value} />
          ))}
          {result.unfilledCancelled ? (
            <Row
              label="Cancelled"
              value={`${shortSize(result.unfilledCancelled)} ${config.base.symbol} not filled`}
            />
          ) : null}
        </View>
      ) : null}
      {shown.mark === 'ring' ? (
        <View style={styles.spacedSm}>
          <Row
            label="Filled"
            value={`${shortSize(result.filledSize)} of ${shortSize(result.requestedSize)} ${config.base.symbol}`}
          />
          <Row label="Expires" value="Never · cancel any time" />
        </View>
      ) : null}
      {money.length > 0 ? <MoneyRows label="Money" lines={money} /> : null}
      {result.orderId ? <Row label="Order" value={result.orderId} mono /> : null}
      {cancel.done ? <Notice tone="ok" title="Order cancelled" detail={cancel.done} /> : null}
      {cancel.error ? <Notice tone="error" title="Couldn't cancel" detail={cancel.error} /> : null}

      <View style={styles.spaced}>
        <ButtonRow>
          {shown.mark === 'ring' && !cancel.done ? (
            <Button
              kind="soft"
              label="Cancel order"
              busy={cancel.busy}
              onPress={() => void cancelOrder()}
              style={styles.grow}
            />
          ) : shown.mark === 'half' && shown.fillLine?.endsWith('cancelled') ? (
            <Button
              kind="soft"
              label={`${sent.side === 'buy' ? 'Buy' : 'Sell'} the rest`}
              onPress={() => onAgain(sent.orderType === 'market' ? rest : '')}
              style={styles.grow}
            />
          ) : (
            <Button kind="soft" label="Done" onPress={onClose} style={styles.grow} />
          )}
          <Button
            kind="primary"
            label={shown.mark === 'ring' ? 'Open orders' : 'View position'}
            onPress={onPortfolio}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </Frame>
  );
}

/**
 * What "Buy the rest" reopens the ticket with: the funding asset the order
 * left in the Kuru account. A fresh ticket, a fresh quote — never the old
 * bound re-sent.
 */
function restAmount(funds: TradeFunds | undefined, config: KuruMarketConfig, side: Side): string {
  const symbol = side === 'buy' ? config.quote.symbol : config.base.symbol;
  const left = funds?.find((f) => f.where === 'kuru' && f.symbol === symbol);
  if (!left) return '';
  if (side === 'sell') return left.amount;
  const cents = toUnits(left.amount, 100n);
  return cents === null ? '' : unitsToDecimal(cents, 100n);
}

function MoneyRows({ label, lines }: { label: string; lines: string[] }) {
  return (
    <View style={styles.spacedSm}>
      <Text style={text.label}>{label}</Text>
      {lines.map((line) => {
        const [amount = '', where = ''] = line.split(' · ');
        return <Row key={line} label={amount} value={where} />;
      })}
    </View>
  );
}

/** Your move in the ledger's language: white. Solid when it filled, half for a part, a ring when it rests. */
function ResultMark({ mark }: { mark: 'full' | 'half' | 'ring' | 'none' }) {
  return (
    <View style={styles.markWrap}>
      {mark === 'full' ? (
        <View style={[styles.mark, styles.markFull]}>
          <Icon name="check" size={26} color={color.ink} strokeWidth={2.6} />
        </View>
      ) : mark === 'half' ? (
        <View style={[styles.mark, styles.markRing]}>
          <View style={styles.markHalf} />
        </View>
      ) : (
        <View
          style={[
            styles.mark,
            styles.markRing,
            mark === 'none' && { borderColor: color.lineStrong },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: GUTTER },
  title: { marginTop: 4 },
  grow: { flex: 1 },
  right: { alignItems: 'flex-end' },
  center: { textAlign: 'center' },
  centerCol: { alignItems: 'center', gap: 4 },
  spaced: { marginTop: 20 },
  spacedSm: { marginTop: 12 },
  pressed: { opacity: 0.7 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  panelHead: { marginTop: 18 },
  segs: { flexDirection: 'row', gap: 10, marginTop: 18 },
  sideSeg: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: RADIUS.stone,
    backgroundColor: color.well,
  },
  sideBtn: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: RADIUS.stone },
  sideText: { fontFamily: font.semibold, fontSize: 13, color: color.textDim },
  amount: { alignItems: 'center', marginTop: 22, gap: 4 },
  amountText: {
    fontFamily: font.displaySemibold,
    fontSize: 52,
    lineHeight: 58,
    letterSpacing: -1.6,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  amountUnit: { fontSize: 22, color: color.textDim, letterSpacing: 0 },
  placeholder: { color: color.textFaint },
  presets: { flexDirection: 'row', gap: 8, marginTop: 12, justifyContent: 'center' },
  preset: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  presetText: { fontFamily: font.medium, fontSize: 13, color: color.text },
  err: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: 'rgba(240, 80, 140, 0.08)',
  },
  link: { color: color.purpleHi, fontFamily: font.medium },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 12 },
  key: {
    width: '33.33%',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.well,
  },
  keyCompact: { height: 44 },
  keyHover: { backgroundColor: color.board },
  keyPressed: { backgroundColor: color.well },
  keyText: {
    fontFamily: font.medium,
    fontSize: 24,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  disclose: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  chart: { marginTop: 14 },
  field: { marginTop: 12, gap: 6 },
  fieldInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.well,
    backgroundColor: color.well,
  },
  fieldFocus: { borderColor: color.purple },
  fieldBad: { borderColor: color.berry },
  helper: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  well: {
    marginTop: 14,
    padding: 12,
    gap: 8,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  sheetTitle: { fontSize: 22, lineHeight: 28 },
  reviewBig: { alignItems: 'center', paddingVertical: 14, gap: 4 },
  passkey: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
    marginTop: 12,
  },
  hold: {
    minHeight: 54,
    borderRadius: RADIUS.stone,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  holdText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  steps: { marginTop: 20, gap: 18 },
  step: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  stepHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 2.5, marginTop: 2 },
  markWrap: { alignItems: 'center', marginTop: 12, marginBottom: 14 },
  mark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  markFull: { backgroundColor: '#ECE8FB' },
  markRing: { borderWidth: 4, borderColor: '#ECE8FB', alignItems: 'flex-start' },
  markHalf: { width: '50%', height: '100%', backgroundColor: '#ECE8FB' },
  bigRow: { flexDirection: 'row', alignItems: 'baseline' },
  bigUnit: { fontFamily: font.displaySemibold, fontSize: 26, color: color.textDim },
  fillbar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: color.well,
    marginTop: 18,
    marginBottom: 10,
    overflow: 'hidden',
  },
  fillbarOn: { height: '100%', backgroundColor: color.text },
});
