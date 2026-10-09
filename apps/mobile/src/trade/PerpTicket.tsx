/**
 * The perp ticket on Perpl (SEN-120, plan U-14; the study's `trade.html` →
 * "ETH long"). Reached from a perp market's Long/Short, the Trade picker, a
 * position's "Add", and beside the chart on a wide web window.
 *
 * Long or short, a value in AUSD, leverage chips capped at the market's
 * maximum, then a review and a hold to confirm in the side's colour — the
 * spot ticket's grammar (`TicketScreen.tsx`), with its keyboard (SEN-167).
 * MARKET orders only, bounded at 1% of Perpl's fresh mark
 * (`perplTrader.placeMarket` computes the bound itself; nothing on screen is
 * a price the order carries). Rules and copy live in `perpTicket.ts`.
 *
 * The order is signed by this device's Perpl trading key, derived from the
 * passkey session (`auth/perplKey.ts`) and enrolled once by
 * `app/trade/perpl-setup.tsx`; until then the ticket is a "Set up perps" card.
 * On the web it goes through Sente's Perpl proxy (`createAppPerplTrader`,
 * SEN-175).
 */
import type { Order } from '@sente/venues';
import * as Haptics from '@/platform/haptics';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MarketDto } from '@/markets/api';
import { useTicker } from '@/markets/hooks';
import { useUserPortfolio } from '@/portfolio/usePortfolio';
import { useSession } from '@/session';
import { createAppPerplTrader } from '@/trade/appPerplTrader';
import {
  evaluatePerpTicket,
  leverageChoices,
  PERP_MAX_SLIPPAGE,
  perplFreeAusd,
  type PerpMarket,
  type PerpSide,
} from '@/trade/perpTicket';
import { pressKey, QUOTE_MAX_AGE_MS, shortSize, type Key } from '@/trade/ticket';
import {
  Frame,
  HoldToConfirm,
  Keypad,
  Note,
  SIDE_TONE,
  TxLink,
  useLitKey,
  useNow,
  useWebKeys,
} from '@/trade/ticketKit';
import { usePerplSetup, type PerplSetup } from '@/trade/usePerplSetup';
import { Pill } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import {
  Button,
  ButtonRow,
  Card,
  Chip,
  Chips,
  IconButton,
  Loading,
  Notice,
  Row,
  TopBar,
  useWide,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { BigNumber, PerpTag, SideTag, TokenGlyph } from '@/ui/trading';

const TONE: Record<PerpSide, string> = { long: SIDE_TONE.buy, short: SIDE_TONE.sell };
const DEFAULT_LEVERAGE = 2;

type Stage =
  | { kind: 'ticket' }
  | { kind: 'review'; mark: string; at: number }
  | { kind: 'running' }
  | { kind: 'done'; order: Order }
  | { kind: 'error'; title: string; detail: string };

/** The ticket for one Perpl market, behind the setup gate. */
export function PerpTicket({
  market,
  initialSide,
  embedded = false,
  onClose,
}: {
  market: MarketDto;
  initialSide: PerpSide;
  /** Beside the chart on a wide window: no close button, no market header. */
  embedded?: boolean;
  onClose: () => void;
}) {
  const setup = usePerplSetup(true);
  if (setup.kind === 'ready') {
    return (
      <Ticket
        market={market}
        initialSide={initialSide}
        apiKey={setup.apiKey}
        embedded={embedded}
        onClose={onClose}
      />
    );
  }
  return (
    <Frame onClose={onClose} embedded={embedded}>
      {embedded ? null : <MarketHead market={market} mark={null} />}
      <SetupGate setup={setup} symbol={market.symbol} />
    </Frame>
  );
}

/**
 * What a perp market shows until this device can trade it: one card that says
 * what setting up does and opens it, or why it can't be read.
 */
export function SetupGate({ setup, symbol }: { setup: PerplSetup; symbol?: string }) {
  const router = useRouter();
  if (setup.kind === 'loading' || setup.kind === 'off') return <Loading />;
  if (setup.kind === 'error') {
    return (
      <View style={styles.spaced}>
        <Notice
          tone="error"
          title="Couldn’t read your Perpl account"
          detail={`${setup.message}. Try again in a moment.`}
        />
      </View>
    );
  }
  if (setup.kind === 'ready') return null;
  const open = setup.needs.open;
  return (
    <Card style={styles.gate}>
      <Text style={text.label}>Perps from your wallet</Text>
      <Text style={text.title}>{open ? 'Set up perps once' : 'Finish setting up perps'}</Text>
      <Text style={text.dim}>
        {open
          ? 'Perpl keeps your margin in an account your wallet owns. Open it with 100 AUSD or more, then add this device’s trading key. About 20–40 s, a few confirmations.'
          : 'Your Perpl account is open. This device still needs its trading key: one signature, nothing sent on chain.'}
      </Text>
      <Button
        kind="primary"
        label={open ? 'Set up perps' : 'Finish setup'}
        icon="key"
        onPress={() =>
          router.push({
            pathname: '/trade/perpl-setup',
            params: symbol ? { symbol } : {},
          })
        }
      />
    </Card>
  );
}

function MarketHead({ market, mark }: { market: MarketDto; mark: string | null }) {
  return (
    <View style={styles.identity}>
      <TokenGlyph symbol={market.base} />
      <View style={styles.grow}>
        <Text style={text.title}>
          {market.symbol} <PerpTag leverage={market.maxLeverage} />
        </Text>
        <Text style={text.caption}>Perpl perp · isolated margin · AUSD</Text>
      </View>
      {mark !== null ? (
        <View style={styles.right}>
          <Text style={[text.strong, text.num]}>{mark}</Text>
          <Text style={text.caption}>mark</Text>
        </View>
      ) : null}
    </View>
  );
}

function Ticket({
  market,
  initialSide,
  apiKey,
  embedded,
  onClose,
}: {
  market: MarketDto;
  initialSide: PerpSide;
  apiKey: string;
  embedded: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const session = useSession();
  const user = useUserPortfolio();
  const ticker = useTicker('perpl', market.symbol);
  const [side, setSide] = useState<PerpSide>(initialSide);
  const [value, setValue] = useState('');
  const choices = useMemo(() => leverageChoices(market.maxLeverage), [market.maxLeverage]);
  const [leverage, setLeverage] = useState(() =>
    choices.includes(DEFAULT_LEVERAGE) ? DEFAULT_LEVERAGE : choices[0]!,
  );
  const [stage, setStage] = useState<Stage>({ kind: 'ticket' });

  const pm: PerpMarket = {
    symbol: market.symbol,
    base: market.base,
    stepSize: market.stepSize,
    maxLeverage: market.maxLeverage,
  };
  const liveMark = ticker.data?.mark ?? ticker.data?.last ?? null;
  // The review freezes the mark it computed the size from.
  const mark = stage.kind === 'review' ? stage.mark : liveMark;
  const perpl = user.portfolio?.perpl;
  const available = perpl?.ok && perpl.status === 'ok' ? perplFreeAusd(perpl.balances) : null;
  const ticket = evaluatePerpTicket({ market: pm, side, value, leverage, mark, available });

  const press = (key: Key) => {
    void Haptics.selectionAsync();
    setValue((v) => pressKey(v, key, 2));
  };
  const { lit, typeKey } = useLitKey(press);
  const stepLeverage = (by: 1 | -1) => {
    const i = choices.indexOf(leverage);
    const next = choices[Math.min(choices.length - 1, Math.max(0, i + by))];
    if (next !== undefined) setLeverage(next);
  };

  const review = useCallback(() => {
    if (liveMark === null) return;
    setStage({ kind: 'review', mark: liveMark, at: Date.now() });
  }, [liveMark]);

  useWebKeys(stage.kind === 'ticket', (event) => {
    if (event.type !== 'keydown') return false;
    if (/^[0-9]$/.test(event.key)) typeKey(event.key as Key);
    else if (event.key === '.' || event.key === ',') typeKey('.');
    else if (event.key === 'Backspace') typeKey('back');
    else if (event.key === 'l' || event.key === 'L') setSide('long');
    else if (event.key === 's' || event.key === 'S') setSide('short');
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') stepLeverage(1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') stepLeverage(-1);
    else if (event.key === 'Enter') {
      if (ticket.cta.enabled && !event.repeat) review();
    } else return false;
    return true;
  });

  const confirm = async () => {
    const size = ticket.size;
    const derive = session.auth.perplTradeKey;
    const wallet = session.wallet.wallet;
    if (size === null || derive === null || wallet === null) {
      setStage({
        kind: 'error',
        title: 'Sign in first',
        detail: 'Sign in with your passkey before trading.',
      });
      return;
    }
    setStage({ kind: 'running' });
    let trader: ReturnType<typeof createAppPerplTrader> | null = null;
    try {
      const key = derive(wallet.address);
      // The trader keeps its own copy; this one goes now.
      trader = createAppPerplTrader({ credentials: { apiKey, secretKey: key.secretKey } });
      key.secretKey.fill(0);
      const order = await trader.placeMarket({
        symbol: market.symbol,
        side: side === 'long' ? 'buy' : 'sell',
        size,
        leverage,
        maxSlippage: PERP_MAX_SLIPPAGE,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStage({ kind: 'done', order });
      user.polled.refresh();
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setStage({
        kind: 'error',
        title: 'The order didn’t go through',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      trader?.release();
    }
  };

  if (stage.kind === 'running') {
    return (
      <Frame onClose={onClose} embedded={embedded}>
        <Text style={[text.display, styles.title]}>
          {side === 'long' ? 'Opening your long' : 'Opening your short'}
        </Text>
        <View style={styles.running}>
          <ActivityIndicator color={color.purpleHi} />
          <Text style={text.dim}>
            Signing in to Perpl with this device’s key, then placing a market order. A few seconds.
          </Text>
        </View>
      </Frame>
    );
  }
  if (stage.kind === 'done') {
    return (
      <Filled
        order={stage.order}
        market={market}
        side={side}
        embedded={embedded}
        onClose={onClose}
        onPosition={() =>
          router.push({
            pathname: '/positions/[venue]/[symbol]',
            params: { venue: 'perpl', symbol: market.symbol },
          })
        }
        onAgain={() => {
          setValue('');
          setStage({ kind: 'ticket' });
        }}
      />
    );
  }
  if (stage.kind === 'error') {
    return (
      <Frame onClose={onClose} embedded={embedded}>
        <Text style={[text.display, styles.title]}>{stage.title}</Text>
        <Text style={[text.body, styles.spaced]}>{stage.detail}</Text>
        <Text style={[text.caption, styles.spacedSm]}>
          Nothing fills outside 1% of the mark. Check Portfolio before you try again.
        </Text>
        <Button
          kind="primary"
          label="Back to the ticket"
          onPress={() => setStage({ kind: 'ticket' })}
          style={styles.spaced}
        />
      </Frame>
    );
  }

  const reviewing = stage.kind === 'review';
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
          <View style={[styles.identity, styles.panelHead]}>
            <Text style={[text.label, styles.grow]}>Trade {market.symbol}</Text>
            <Text style={[text.strong, text.num]}>{liveMark ?? '—'}</Text>
          </View>
        ) : (
          <MarketHead market={market} mark={liveMark} />
        )}

        {stage.kind === 'review' ? (
          <Review
            market={market}
            side={side}
            leverage={leverage}
            ticket={ticket}
            mark={stage.mark}
            at={stage.at}
            onRefresh={review}
            onConfirm={() => void confirm()}
          />
        ) : (
          <>
            <View style={styles.sideRow}>
              <View style={styles.sideSeg} accessibilityRole="radiogroup">
                {(['long', 'short'] as const).map((s) => {
                  const on = s === side;
                  return (
                    <Pressable
                      key={s}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      onPress={() => setSide(s)}
                      style={[styles.sideBtn, on && { backgroundColor: `${TONE[s]}26` }]}
                    >
                      <Text style={[styles.sideText, on && { color: TONE[s] }]}>
                        {s === 'long' ? 'Long' : 'Short'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[text.caption, styles.grow, styles.sideHint]}>
                {side === 'long' ? 'Gains if the price rises' : 'Gains if the price falls'}
              </Text>
            </View>

            <View style={styles.amount}>
              <Text
                style={[styles.amountText, ticket.short && text.danger]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {value === '' ? <Text style={styles.placeholder}>0</Text> : value}
                <Text style={styles.amountUnit}> AUSD</Text>
              </Text>
              <Text style={[text.dim, text.num]}>{ticket.sub ?? 'Position value'}</Text>
            </View>

            <View style={styles.levHead}>
              <Text style={text.label}>Leverage</Text>
              <Text style={text.caption}>
                up to {market.maxLeverage ?? 1}× on {market.base}
              </Text>
            </View>
            <Chips>
              {choices.map((x) => (
                <Chip
                  key={x}
                  label={`${x}×`}
                  selected={x === leverage}
                  onPress={() => setLeverage(x)}
                />
              ))}
            </Chips>

            {available !== null ? (
              <Text style={[text.caption, styles.center, styles.spacedSm]}>
                {available} AUSD free in your Perpl account
              </Text>
            ) : null}
            {ticket.short ? (
              <View style={styles.err} accessibilityRole="alert">
                <Icon name="bolt" size={14} color={color.berry} />
                <Text style={[text.dim, styles.grow]}>
                  <Text style={text.strong}>
                    Margin {ticket.margin} AUSD is more than you have free.
                  </Text>{' '}
                  Lower the value, raise the leverage, or add AUSD to Perpl from Portfolio.
                </Text>
              </View>
            ) : null}

            <Keypad onKey={press} lit={lit} compact={wide} />

            <Button
              kind="primary"
              label={ticket.cta.label}
              disabled={!ticket.cta.enabled}
              onPress={review}
            />
            {wide ? (
              <Text style={[text.caption, styles.center, styles.spacedSm]}>
                Type a value · L / S picks the side · ← → leverage · Enter to review
              </Text>
            ) : null}
            <Text style={[text.caption, styles.center, styles.spacedSm]}>
              Market order · fills within 1% of the mark, or not at all
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Review({
  market,
  side,
  leverage,
  ticket,
  mark,
  at,
  onRefresh,
  onConfirm,
}: {
  market: MarketDto;
  side: PerpSide;
  leverage: number;
  ticket: ReturnType<typeof evaluatePerpTicket>;
  mark: string;
  at: number;
  onRefresh: () => void;
  onConfirm: () => void;
}) {
  const now = useNow(1_000);
  const age = Math.max(0, now - at);
  const old = age > QUOTE_MAX_AGE_MS;
  useWebKeys(ticket.cta.enabled && old, (event) => {
    if (event.key !== 'Enter') return false;
    if (event.type === 'keydown' && !event.repeat) onRefresh();
    return true;
  });
  const size = ticket.size ?? '0';
  const verb = side === 'long' ? 'long' : 'short';
  return (
    <View>
      <View style={styles.reviewHead}>
        <Text style={[text.title, styles.sheetTitle, styles.grow]}>Review your {verb}</Text>
        <Pill label={`Mark ${Math.round(age / 1000)}s ago`} tone={old ? 'idle' : 'live'} />
      </View>
      <View style={styles.reviewBig}>
        <BigNumber value={size} places={Math.min(5, (size.split('.')[1] ?? '').length)} />
        <Text style={text.dim}>
          {market.base} <SideTag side={side} /> at market, {leverage}×
        </Text>
      </View>
      <Row label="Value at the mark" value={`≈ ${ticket.notional ?? '—'} AUSD`} />
      <Row label="Margin it locks" value={`≈ ${ticket.margin ?? '—'} AUSD`} />
      <Row label="Mark" value={mark} />
      <Row label="Fills" value="Within 1% of the mark, or not at all" />
      <Row label="Liquidation" value="Shown on your position once it opens" />
      <View style={styles.spaced}>
        {!ticket.cta.enabled ? (
          <Button kind="secondary" label={ticket.cta.label} disabled onPress={() => undefined} />
        ) : old ? (
          <Button kind="primary" label="Refresh the mark" onPress={onRefresh} />
        ) : (
          <HoldToConfirm
            tone={TONE[side]}
            keys
            label={`Hold to ${verb} ${shortSize(size)} ${market.base}`}
            onConfirm={onConfirm}
          />
        )}
      </View>
      <View style={styles.passkey}>
        <Icon name="key" size={14} color={color.textDim} />
        <Text style={text.caption}>
          This device’s trading key signs it. It can trade, never withdraw.
        </Text>
      </View>
    </View>
  );
}

function Filled({
  order,
  market,
  side,
  embedded,
  onClose,
  onPosition,
  onAgain,
}: {
  order: Order;
  market: MarketDto;
  side: PerpSide;
  embedded: boolean;
  onClose: () => void;
  onPosition: () => void;
  onAgain: () => void;
}) {
  const filled = Number(order.filledSize) > 0;
  return (
    <Frame onClose={onClose} embedded={embedded}>
      <View style={styles.mark}>
        <View style={[styles.markStone, { backgroundColor: filled ? TONE[side] : color.well }]}>
          <Icon name={filled ? 'check' : 'close'} size={24} color={color.ink} strokeWidth={2.6} />
        </View>
      </View>
      <View style={styles.centerCol}>
        <Text style={text.dim}>
          {filled ? `${side === 'long' ? 'Long' : 'Short'} opened` : 'Nothing filled'}
        </Text>
        <View style={styles.bigRow}>
          <BigNumber value={order.filledSize} places={5} size="xl" />
          <Text style={styles.bigUnit}> {market.base}</Text>
        </View>
        {order.averageFillPrice ? (
          <Text style={[text.dim, text.num]}>
            at {order.averageFillPrice} · {order.leverage ?? ''}×
          </Text>
        ) : null}
      </View>
      {!filled ? (
        <Text style={[text.dim, styles.center, styles.spacedSm]}>
          The book couldn’t fill it within 1% of the mark, so the order was cancelled. Nothing
          moved.
        </Text>
      ) : null}
      <View style={styles.spacedSm}>
        <Row label="Order" value={`${order.status} · ${order.id}`} />
        {order.fee ? <Row label="Fee" value={`${order.fee} ${order.feeAsset ?? 'AUSD'}`} /> : null}
        {order.blockNumber ? (
          <Row label="Block" value={order.blockNumber.toLocaleString('en-US')} />
        ) : null}
        {order.txHash ? (
          <View style={styles.txRow}>
            <Text style={text.dim}>Transaction</Text>
            <TxLink hash={order.txHash} />
          </View>
        ) : null}
      </View>
      <View style={styles.spaced}>
        <ButtonRow>
          <Button kind="soft" label="Trade again" onPress={onAgain} style={styles.grow} />
          <Button
            kind="primary"
            label={filled ? 'View position' : 'Done'}
            onPress={filled ? onPosition : onClose}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
      <Note icon="shield">
        Your position is in your Perpl account. Portfolio shows it within about 30 s.
      </Note>
    </Frame>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: 20 },
  title: { marginTop: 4 },
  grow: { flex: 1 },
  right: { alignItems: 'flex-end' },
  center: { textAlign: 'center' },
  centerCol: { alignItems: 'center', gap: 4 },
  spaced: { marginTop: 20 },
  spacedSm: { marginTop: 12 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  panelHead: { marginTop: 18 },
  gate: { marginTop: 18, gap: 10 },
  sideRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  sideSeg: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: RADIUS.stone,
    backgroundColor: color.well,
  },
  sideBtn: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: RADIUS.stone },
  sideText: { fontFamily: font.semibold, fontSize: 13, color: color.textDim },
  sideHint: { textAlign: 'right' },
  amount: { alignItems: 'center', marginTop: 18, gap: 4 },
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
  levHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 18,
    marginBottom: 8,
  },
  err: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: 'rgba(240, 80, 140, 0.08)',
  },
  running: { flexDirection: 'row', gap: 12, alignItems: 'center', marginTop: 20 },
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
  mark: { alignItems: 'center', marginTop: 12, marginBottom: 14 },
  markStone: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigRow: { flexDirection: 'row', alignItems: 'baseline' },
  bigUnit: { fontFamily: font.displaySemibold, fontSize: 26, color: color.textDim },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
});
