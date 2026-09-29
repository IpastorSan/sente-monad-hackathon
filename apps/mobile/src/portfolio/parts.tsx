/**
 * The Portfolio tab's pieces (SEN-118): the allocation bar, the cash card,
 * position rows (yours and your agents'), the order card and a fill line.
 * The visual spec is `docs/design/trading/portfolio.html` (`.alloc`,
 * `.cash-line`, `.pos`, `.agents-group`, `.order`, `.dist`, `.move`); every
 * figure arrives formatted from `view.ts`, so these only lay out.
 *
 * The allocation uses neutral and purple tones only: mint and berry stay
 * reserved for direction (a P&L, a side), never for "what kind of money".
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Sigil, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { Button, ButtonRow, Card } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { SideTag, TokenGlyph } from '@/ui/trading';
import { formatPct, pctDirection, type Direction } from '@/ui/tradingFormat';

import type { ClosedRow } from './closed';
import {
  amountText,
  approxUsd,
  legendValue,
  shown,
  signedMoney,
  toneOf,
  type AgentGroupRow,
  type Allocation,
  type AllocationKey,
  type CashLine,
  type FillRow,
  type OrderRow,
  type VenueCash,
} from './view';

const TONE: Record<Direction, string> = {
  up: color.mint,
  down: color.berry,
  flat: color.textDim,
};

const SEGMENT_TONE: Record<AllocationKey, string> = {
  cash: color.textDim,
  agents: color.purple,
  spot: color.purpleSoft,
  perps: color.purpleHi,
};

// ─── Hide balances ──────────────────────────────────────────────────────────

/** The eye. Purple while on: the numbers are hidden, and the toggle says so. */
export function HideToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={hidden ? 'Show balances' : 'Hide balances'}
      accessibilityState={{ checked: hidden }}
      hitSlop={8}
      onPress={onToggle}
      style={[styles.eye, hidden && styles.eyeOn]}
    >
      <Icon
        name={hidden ? 'eyeOff' : 'eye'}
        size={18}
        color={hidden ? color.purpleHi : color.textDim}
      />
    </Pressable>
  );
}

// ─── Allocation ─────────────────────────────────────────────────────────────

export function AllocationBar({ split, hidden }: { split: Allocation; hidden: boolean }) {
  if (split.segments.length === 0) return null;
  return (
    <View style={styles.alloc}>
      <View
        style={styles.allocBar}
        accessibilityLabel={`Allocation: ${split.segments
          .map((s) => `${s.label} ${s.share} percent`)
          .join(', ')}`}
      >
        {split.segments.map((s) => (
          <View
            key={s.key}
            style={{ flexGrow: Math.max(s.share, 1), backgroundColor: SEGMENT_TONE[s.key] }}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {split.segments.map((s) => (
          <View key={s.key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: SEGMENT_TONE[s.key] }]} />
            <Text style={[text.dim, styles.grow]}>{s.label}</Text>
            <Text style={[text.dim, text.num, styles.legendValue]}>{legendValue(s, hidden)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Cash ───────────────────────────────────────────────────────────────────

const VENUE_PLACE = { kuru: 'in your Kuru account', perpl: 'in your Perpl account' } as const;

/**
 * Cash, never merged: each currency sits next to what it's for. Stablecoins
 * already inside a venue account are listed under the wallet's, since they
 * count toward the total but are not in the wallet.
 */
export function CashCard({
  cash,
  venueCash,
  hidden,
  onAddFunds,
  onWithdraw,
  onKuruWithdraw,
}: {
  cash: readonly CashLine[];
  venueCash: readonly VenueCash[];
  hidden: boolean;
  onAddFunds: () => void;
  /** Opens wallet → typed address (SEN-153); absent while `EXTERNAL_WITHDRAW_ENABLED` is off. */
  onWithdraw?: (() => void) | undefined;
  /**
   * Opens Kuru account → wallet (SEN-153). Absent while manual trading is off,
   * since the withdrawal runs through `/trade`: the line then stays plain text.
   */
  onKuruWithdraw?: (() => void) | undefined;
}) {
  return (
    <Card style={styles.cash}>
      <View style={styles.between}>
        <Text style={text.label}>Cash</Text>
        <Text style={text.caption}>in your wallet</Text>
      </View>
      {cash.map((line) => (
        <View key={line.symbol} style={styles.cashLine}>
          <TokenGlyph symbol={line.symbol} size="sm" />
          <Text style={[text.strong, text.num, styles.grow]}>
            {shown(amountText(line.amount, line.symbol), hidden)}{' '}
            <Text style={text.dim}>{line.symbol}</Text>
          </Text>
          <Text style={text.caption}>{line.purpose}</Text>
        </View>
      ))}
      {venueCash.map((line) => {
        const figure = (
          <Text style={[text.caption, text.num]}>
            + {shown(amountText(line.amount, line.asset), hidden)} {line.asset}{' '}
            {VENUE_PLACE[line.venue]}
          </Text>
        );
        const key = `${line.venue}:${line.asset}`;
        return line.venue === 'kuru' && onKuruWithdraw ? (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`Move ${line.asset} from your Kuru account to your wallet`}
            onPress={onKuruWithdraw}
            style={styles.venueLine}
          >
            {figure}
            <Text style={[text.caption, styles.venueAction]}>Move to wallet</Text>
          </Pressable>
        ) : (
          <View key={key}>{figure}</View>
        );
      })}
      <View style={styles.cashButtons}>
        <ButtonRow>
          {onWithdraw ? (
            <Button
              label="Withdraw"
              kind="soft"
              size="sm"
              onPress={onWithdraw}
              style={styles.grow}
            />
          ) : null}
          <Button
            label="Add funds"
            kind="primary"
            size="sm"
            icon="plus"
            onPress={onAddFunds}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </Card>
  );
}

// ─── Position rows ──────────────────────────────────────────────────────────

/** `SPOT`, quiet beside the symbol; PERP rows carry the side instead. */
function SpotTag() {
  return <Text style={styles.spotTag}>{'\u2009SPOT\u2009'}</Text>;
}

function Leverage({ n }: { n: number | null }) {
  return n !== null ? <Text style={[text.caption, text.num]}> {n}×</Text> : null;
}

/** P&L amount and percent in the direction colour; hidden keeps only the percent. */
function PnlLine({
  pnl,
  pct,
  hidden,
}: {
  pnl: string | null;
  pct: number | null;
  hidden: boolean;
}) {
  if (pnl === null && pct === null) return null;
  const tone = pct !== null ? pctDirection(pct) : toneOf(pnl);
  return (
    <Text style={[text.dim, text.num, { color: TONE[tone] }]}>
      {pnl !== null && !hidden ? `${signedMoney(pnl)} · ` : ''}
      {pct !== null ? formatPct(pct) : ''}
    </Text>
  );
}

function PosRow({
  lead,
  title,
  caption,
  value,
  under,
  onPress,
  chevron = false,
  dimmed = false,
  last = false,
}: {
  lead: ReactNode;
  title: ReactNode;
  caption: string;
  value: ReactNode;
  under?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  dimmed?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pos,
        !last && styles.posDivider,
        dimmed && styles.dimmed,
        pressed && styles.pressed,
      ]}
    >
      {lead}
      <View style={styles.posMain}>
        <Text style={text.strong} numberOfLines={1}>
          {title}
        </Text>
        <Text style={text.caption} numberOfLines={1}>
          {caption}
        </Text>
      </View>
      <View style={styles.posPx}>
        <Text style={[text.strong, text.num]} numberOfLines={1}>
          {value}
        </Text>
        {under}
      </View>
      {chevron ? <Icon name="chevron" size={12} color={color.textFaint} /> : null}
    </Pressable>
  );
}

export function SpotPositionRow({
  asset,
  amount,
  value,
  price,
  hidden,
  onPress,
  last,
}: {
  asset: string;
  amount: string;
  value: string | null;
  price: string | null;
  hidden: boolean;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <PosRow
      lead={<TokenGlyph symbol={asset} />}
      title={
        <>
          {asset} <SpotTag />
        </>
      }
      caption={[
        `${shown(amountText(amount, asset), hidden)} · Kuru`,
        price !== null ? `at ${price}` : 'no Kuru price',
        // Why: the wallet's MON pays for gas too; the row must not read as a trade.
        asset === 'MON' ? 'incl. gas' : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      value={
        <>
          {value !== null ? shown(amountText(value, 'USDC'), hidden) : '—'}{' '}
          <Text style={text.dim}>USDC</Text>
        </>
      }
      onPress={onPress}
      last={last}
    />
  );
}

export function PerpPositionRow({
  symbol,
  side,
  leverage,
  size,
  entry,
  value,
  pnl,
  pct,
  hidden,
  onPress,
  last,
}: {
  symbol: string;
  side: 'long' | 'short';
  leverage: number;
  size: string;
  entry: string;
  value: string;
  pnl: string;
  pct: number | null;
  hidden: boolean;
  onPress: () => void;
  last?: boolean;
}) {
  const base = symbol.split('-')[0] ?? symbol;
  return (
    <PosRow
      lead={<TokenGlyph symbol={symbol} />}
      title={
        <>
          {symbol} <SideTag side={side} />
          <Leverage n={leverage} />
        </>
      }
      caption={`${shown(size, hidden)} ${base} · entry ${entry} · Perpl`}
      value={
        <>
          {shown(amountText(value, 'AUSD'), hidden)} <Text style={text.dim}>AUSD</Text>
        </>
      }
      under={<PnlLine pnl={pnl} pct={pct} hidden={hidden} />}
      onPress={onPress}
      last={last}
    />
  );
}

/**
 * A closed round trip (SEN-154): the same row as an open one, with the
 * realised P&L where the value was and the percent and dates under it. Not
 * pressable: the position page is about what you hold now.
 */
export function ClosedPositionRow({ row, last }: { row: ClosedRow; last?: boolean }) {
  return (
    <PosRow
      lead={<TokenGlyph symbol={row.title} />}
      title={
        row.spot ? (
          <>
            {row.title} <SpotTag />
          </>
        ) : (
          <>
            {row.title} <SideTag side={row.direction} />
          </>
        )
      }
      caption={row.caption}
      value={
        <>
          <Text style={{ color: TONE[row.tone] }}>{row.pnl}</Text>{' '}
          <Text style={text.dim}>{row.pnlAsset}</Text>
        </>
      }
      under={<Text style={[text.dim, text.num]}>{row.under}</Text>}
      last={last}
    />
  );
}

/**
 * The dashed "With your agents" group: read-only, because an agent's funds
 * are the agent's. Every row opens that agent's cockpit, where you can ask it
 * to close, amend its mandate or revoke it.
 */
export function AgentsGroup({
  rows,
  total,
  hidden,
  onOpen,
}: {
  rows: readonly AgentGroupRow[];
  total: string | null;
  hidden: boolean;
  onOpen: (agentId: string) => void;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.between}>
        <Text style={text.label}>With your agents</Text>
        <Text style={[text.caption, text.num]}>{shown(approxUsd(total), hidden)}</Text>
      </View>
      <Text style={[text.caption, styles.groupNote]}>
        Their funds, their trades. Open one to ask it to close, amend or revoke.
      </Text>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        if (row.kind === 'position') {
          return (
            <PosRow
              key={row.key}
              lead={<Sigil seed={row.agentId} size={36} />}
              title={
                <>
                  {row.symbol} <SideTag side={row.side} />
                  <Leverage n={row.leverage} />
                </>
              }
              caption={row.caption}
              value={
                <>
                  {row.value !== null ? shown(amountText(row.value, row.unit), hidden) : '—'}{' '}
                  <Text style={text.dim}>{row.unit}</Text>
                </>
              }
              under={<PnlLine pnl={row.pnl} pct={row.pct} hidden={hidden} />}
              onPress={() => onOpen(row.agentId)}
              chevron
              last={last}
            />
          );
        }
        return (
          <PosRow
            key={row.key}
            lead={<Sigil seed={row.agentId} size={36} dimmed={row.revoked} />}
            title={<Text style={row.revoked ? { color: color.textDim } : null}>{row.name}</Text>}
            caption={row.caption}
            value={shown(approxUsd(row.value), hidden)}
            under={row.aside ? <Text style={text.caption}>{row.aside}</Text> : undefined}
            onPress={() => onOpen(row.agentId)}
            chevron
            dimmed={row.revoked}
            last={last}
          />
        );
      })}
    </View>
  );
}

// ─── Orders ─────────────────────────────────────────────────────────────────

/** Buy / Sell, in the direction colour, as the study's `.side` pill. */
export function SideWord({ side }: { side: 'Buy' | 'Sell' }) {
  const buy = side === 'Buy';
  return (
    <Text
      style={[
        styles.side,
        buy
          ? { color: color.mint, backgroundColor: 'rgba(95, 227, 179, 0.12)' }
          : { color: color.berry, backgroundColor: 'rgba(240, 80, 140, 0.12)' },
      ]}
    >
      {`\u2009${side.toUpperCase()}\u2009`}
    </Text>
  );
}

/**
 * A resting order and how far it is from the market: the limit as a hollow
 * stone (planned, not yet played), the market as a solid dot. There is no
 * Edit: neither venue can amend an order.
 */
export function OrderCard({
  row,
  hidden,
  onCancel,
}: {
  row: OrderRow;
  hidden: boolean;
  /** Absent while manual trading is off: nothing to cancel with. */
  onCancel?: () => void;
}) {
  const { order } = row;
  return (
    <Card style={styles.order}>
      <View style={styles.orderHead}>
        <TokenGlyph symbol={row.base} />
        <View style={styles.posMain}>
          <Text style={text.strong} numberOfLines={1}>
            <SideWord side={order.side === 'buy' ? 'Buy' : 'Sell'} />{' '}
            {shown(amountText(row.remaining, row.base), hidden)} {row.base}
          </Text>
          <Text style={text.caption} numberOfLines={1}>
            {row.kind}
          </Text>
        </View>
        <Text style={styles.pill}>Resting</Text>
      </View>
      {row.track && order.price !== null && row.market !== null ? (
        <View style={styles.dist} accessibilityLabel={row.distance ?? undefined}>
          <View style={styles.distLine} />
          <View style={[styles.distPoint, { left: `${row.track.limit * 100}%` }]}>
            <View style={styles.distLimit} />
            <Text style={[styles.distLabel, { color: color.purpleSoft }]}>{order.price}</Text>
          </View>
          <View style={[styles.distPoint, { left: `${row.track.market * 100}%` }]}>
            <View style={styles.distMarket} />
            <Text style={styles.distLabel}>{row.market} now</Text>
          </View>
        </View>
      ) : null}
      <Text style={[text.dim, styles.orderNote]}>
        {[row.distance, shown(row.filledLine, hidden)].filter(Boolean).join(' ')}
      </Text>
      {onCancel ? (
        <Button
          label="Cancel order"
          kind="soft"
          size="sm"
          onPress={onCancel}
          style={styles.orderCancel}
        />
      ) : null}
    </Card>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

/** One fill on the spine: a purple stone (a move), the tx hash in the chain's mono. */
export function FillLine({ fill, hidden }: { fill: FillRow; hidden: boolean }) {
  return (
    <View style={styles.move}>
      <View style={styles.moveStone}>
        <Stone kind="trade" />
      </View>
      <View style={styles.grow}>
        <View style={styles.between}>
          <Text style={[text.strong, styles.grow]} numberOfLines={1}>
            {fill.side ? <SideWord side={fill.side} /> : null}
            {fill.side ? ' ' : null}
            {shown(fill.title, hidden)}
          </Text>
          <Text style={text.mono}>{fill.time}</Text>
        </View>
        <Text style={text.dim}>{fill.detail}</Text>
        {fill.tx ? <Text style={text.mono}>{fill.tx}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pressed: { opacity: 0.7 },
  dimmed: { opacity: 0.7 },
  eye: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeOn: { borderColor: color.purple, backgroundColor: 'rgba(131, 110, 249, 0.16)' },
  alloc: { marginTop: 20 },
  allocBar: { flexDirection: 'row', gap: 2, height: 8, borderRadius: 8, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, columnGap: 18, marginTop: 12 },
  legendItem: { width: '46%', flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendValue: { color: color.text },
  cash: { marginTop: 18, paddingTop: 12 },
  cashLine: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  cashButtons: { marginTop: 8 },
  venueLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  venueAction: { color: color.purple },
  pos: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  posDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  posMain: { flex: 1, minWidth: 0, gap: 2 },
  posPx: { alignItems: 'flex-end', gap: 1 },
  spotTag: {
    fontFamily: font.semibold,
    fontSize: 9.5,
    lineHeight: 15,
    letterSpacing: 0.6,
    color: color.textDim,
    backgroundColor: color.well,
  },
  group: {
    marginTop: 22,
    marginHorizontal: -8,
    paddingTop: 12,
    paddingHorizontal: 10,
    paddingBottom: 2,
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
  },
  groupNote: { marginTop: 4, marginBottom: 2 },
  side: {
    fontFamily: font.semibold,
    fontSize: 10,
    lineHeight: 16,
    letterSpacing: 0.8,
  },
  order: { marginTop: 16 },
  orderHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderNote: { marginTop: 6 },
  orderCancel: { marginTop: 12, alignSelf: 'flex-start' },
  pill: {
    fontFamily: font.medium,
    fontSize: 11,
    color: color.textDim,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: RADIUS.stone,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dist: { height: 44, marginTop: 14, marginHorizontal: 30 },
  distLine: {
    position: 'absolute',
    top: 7,
    left: 0,
    right: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: color.well,
  },
  distPoint: { position: 'absolute', top: 0, width: 80, marginLeft: -40, alignItems: 'center' },
  distLimit: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: color.purpleSoft,
    backgroundColor: color.board,
  },
  distMarket: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 3,
    marginBottom: 3,
    backgroundColor: color.text,
  },
  distLabel: {
    marginTop: 4,
    fontFamily: font.chain,
    fontSize: 10,
    lineHeight: 14,
    color: color.textDim,
  },
  move: { flexDirection: 'row', gap: 12, paddingVertical: 10 },
  moveStone: { paddingTop: 4 },
});
