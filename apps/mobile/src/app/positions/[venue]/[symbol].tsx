/**
 * Your own position (SEN-118, plan U-12; study `portfolio.html` → "Your
 * position"): a perp you opened on Perpl, or a spot holding on Kuru.
 *
 * A perp leads with unrealised P&L, not price — that is what you check when
 * you open a position — and its percent is on margin, so it matches what you
 * put in. Liquidation is our estimate and always says "est."; it sits under
 * the chart with its distance rather than on it, because drawing a line
 * 30 % away would squash the candles into a strip. There is no "Add margin"
 * (Perpl has none) and no stop field: stop-loss and take-profit are shown as
 * not on Perpl yet, pointing at an agent that watches levels instead.
 *
 * Close, sell and add need the trade flow and are shown only while manual
 * trading is on (`useTradingEnabled`).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { KlineInterval } from '@/markets/api';
import { useKlines, useTickers } from '@/markets/hooks';
import { useHideBalances } from '@/portfolio/hideBalances';
import { HideToggle } from '@/portfolio/parts';
import { useUserPortfolio } from '@/portfolio/usePortfolio';
import {
  amountText,
  baseOf,
  findPosition,
  holdings,
  perpDetail,
  sectionFailure,
  shown,
  type PerpRow,
  type SpotRow,
} from '@/portfolio/view';
import { Chart } from '@/ui/chart/Chart';
import { Button, ButtonRow, Card, Loading, Notice, Row, Screen, TopBar } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { AsOf, BigNumber, Levels, RangePills, SideTag, TokenGlyph } from '@/ui/trading';

const RANGES = ['15M', '1H', '4H', '1D'] as const;
type Range = (typeof RANGES)[number];
const INTERVAL: Record<Range, KlineInterval> = { '15M': '15m', '1H': '1h', '4H': '4h', '1D': '1d' };
const CANDLES = 48;

export default function PositionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ venue: string; symbol: string }>();
  const venue = params.venue === 'perpl' ? 'perpl' : 'kuru';
  const symbol = params.symbol ?? '';
  const user = useUserPortfolio();
  const tickers = useTickers();
  const [hidden, toggleHidden] = useHideBalances();
  const [range, setRange] = useState<Range>('1H');

  const held = useMemo(
    () => (user.wallet ? holdings(user.wallet, user.portfolio, tickers.data?.tickers ?? []) : null),
    [user.wallet, user.portfolio, tickers.data],
  );
  const found = held ? findPosition(held, venue, symbol) : null;
  const failure = held?.unread.includes(venue) ? sectionFailure(venue) : null;
  // The chart's market: the perp itself, or the asset's USDC book on Kuru.
  const market = venue === 'perpl' ? symbol : `${baseOf(symbol)}-USDC`;
  const klines = useKlines(venue, market, INTERVAL[range], { limit: CANDLES });

  const back = () => (router.canGoBack() ? router.back() : router.replace('/portfolio'));
  const waiting = held === null || (venue === 'perpl' && user.trading && user.portfolio === null);

  return (
    <Screen
      footer={
        found && user.trading ? (
          <Actions
            kind={found.kind}
            onAdd={() => router.push('/trade')}
            // The spot ticket's route, prefilled for a sell of this holding on
            // its USDC book (the same market the chart shows).
            onSell={() =>
              router.push({
                pathname: '/trade/[venue]/[symbol]',
                params: { venue: 'kuru', symbol: market, side: 'sell' },
              })
            }
          />
        ) : undefined
      }
    >
      <TopBar
        back={{ label: 'Portfolio', onPress: back }}
        right={<HideToggle hidden={hidden} onToggle={toggleHidden} />}
      />

      {/* This venue's section failed (SEN-123): what shows below may be partial. */}
      {failure ? (
        <View style={styles.failure}>
          <Notice tone="error" title={failure.title} detail={failure.detail} />
        </View>
      ) : null}
      {waiting && found === null ? (
        <Loading />
      ) : found === null ? (
        // Not "no open position": the venue that would list it didn't answer.
        failure ? null : (
          <Notice
            title={`No open position on ${symbol}`}
            detail="It may have closed or filled since you opened it. Pull down on Portfolio to refresh."
          />
        )
      ) : (
        <>
          {found.kind === 'perp' ? (
            <PerpHead row={found.row} hidden={hidden} asOf={user.polled.asOf} />
          ) : (
            <SpotHead row={found.row} hidden={hidden} asOf={tickers.asOf} />
          )}

          <View style={styles.chart}>
            {klines.data && klines.data.klines.length > 0 ? (
              <Chart
                kind="candles"
                klines={klines.data.klines}
                height={150}
                fit={false}
                levels={
                  found.kind === 'perp'
                    ? [{ price: found.row.position.entryPrice, kind: 'entry', label: 'ENTRY' }]
                    : []
                }
                label={`${market} ${range} candles`}
              />
            ) : klines.unavailable ? (
              <Text style={text.caption}>The chart is not available on this API yet.</Text>
            ) : (
              <Loading />
            )}
          </View>

          {found.kind === 'perp' ? (
            <PerpBody row={found.row} hidden={hidden} onAgents={() => router.push('/agents')} />
          ) : null}
          <View style={found.kind === 'perp' ? styles.rangesAfter : null}>
            <RangePills options={RANGES} value={range} onChange={setRange} />
          </View>
          {found.kind === 'spot' ? <SpotBody row={found.row} hidden={hidden} /> : null}
        </>
      )}
    </Screen>
  );
}

function PerpHead({ row, hidden, asOf }: { row: PerpRow; hidden: boolean; asOf: number | null }) {
  const { position } = row;
  const detail = perpDetail(position, hidden);
  const tone =
    detail.pnl.tone === 'up' ? color.mint : detail.pnl.tone === 'down' ? color.berry : color.text;
  const pctTone = detail.pctTone === 'up' ? text.up : detail.pctTone === 'down' ? text.down : null;
  return (
    <>
      <View style={styles.title}>
        <TokenGlyph symbol={position.symbol} />
        <View style={styles.grow}>
          <Text style={text.title}>
            {position.symbol} <SideTag side={position.side} />
            <Text style={[text.caption, text.num]}> {position.leverage}×</Text>
          </Text>
          <Text style={text.caption}>Perpl · isolated margin · AUSD</Text>
        </View>
      </View>
      <View style={styles.headline}>
        <Text style={text.label}>Unrealised P&amp;L</Text>
        <View style={styles.bigRow}>
          <BigNumber
            value={detail.pnl.magnitude.replace(/,/gu, '')}
            prefix={detail.pnl.sign}
            blurred={hidden}
            style={{ color: tone }}
          />
          <Text style={[text.strong, styles.unit]}>AUSD</Text>
        </View>
        <View style={styles.inline}>
          <Text style={[text.dim, text.num]}>
            <Text style={pctTone}>{detail.pct}</Text> on{' '}
            {shown(amountText(row.position.margin, 'AUSD'), hidden)} margin ·
          </Text>
          <AsOf at={asOf} />
        </View>
      </View>
    </>
  );
}

function PerpBody({
  row,
  hidden,
  onAgents,
}: {
  row: PerpRow;
  hidden: boolean;
  onAgents: () => void;
}) {
  const { position } = row;
  const detail = perpDetail(position, hidden);
  return (
    <>
      {detail.liq ? <Text style={styles.offchart}>{detail.liq}</Text> : null}
      <View style={styles.levels}>
        <Levels entry={position.entryPrice} liq={position.liquidationPriceEst} />
      </View>
      <Card style={styles.protect}>
        <Text style={text.strong}>Protect this position</Text>
        <View style={styles.protectOff}>
          <Text style={text.dim}>Stop-loss · take-profit</Text>
          <Text style={text.caption}>Not on Perpl yet</Text>
        </View>
        <Text style={text.caption}>
          Agents can watch a stop on their own trades. It's checked every run, not a venue order.{' '}
          <Text style={styles.link} onPress={onAgents} accessibilityRole="link">
            Trade it with an agent
          </Text>
        </Text>
      </Card>
      <View style={styles.rows}>
        <Row label="Size" value={detail.size} />
        <Row label="Margin" value={detail.margin} />
        <Row label="Mark" value={position.markPrice} />
        {detail.funding ? <Row label="Funding paid" value={detail.funding} /> : null}
      </View>
    </>
  );
}

function SpotHead({ row, hidden, asOf }: { row: SpotRow; hidden: boolean; asOf: number | null }) {
  return (
    <>
      <View style={styles.title}>
        <TokenGlyph symbol={row.asset} />
        <View style={styles.grow}>
          <Text style={text.title}>{row.asset}</Text>
          <Text style={text.caption}>Kuru spot · USDC</Text>
        </View>
      </View>
      <View style={styles.headline}>
        <Text style={text.label}>Value</Text>
        <View style={styles.bigRow}>
          <BigNumber value={row.value ?? '—'} blurred={hidden} />
          <Text style={[text.strong, styles.unit]}>USDC</Text>
        </View>
        <View style={styles.inline}>
          <Text style={[text.dim, text.num]}>
            {shown(amountText(row.amount, row.asset), hidden)} {row.asset}
            {row.price !== null ? ` at ${row.price}` : ', no Kuru price'} ·
          </Text>
          <AsOf at={asOf} />
        </View>
      </View>
    </>
  );
}

function SpotBody({ row, hidden }: { row: SpotRow; hidden: boolean }) {
  return (
    <View style={styles.rows}>
      <Row
        label="Holding"
        value={`${shown(amountText(row.amount, row.asset), hidden)} ${row.asset}`}
      />
      <Row label="Price" value={row.price ?? '—'} />
      <Text style={[text.caption, styles.note]}>
        Wallet and Kuru account together.
        {row.asset === 'MON' ? ' Your MON also pays for gas.' : ''} No entry price yet: the
        portfolio route does not track what you paid.
      </Text>
    </View>
  );
}

/**
 * Close / sell and add. Add opens the ticket. Sell opens the spot ticket
 * (SEN-119) on a sell (SEN-144) rather than selling from here: the ticket owns
 * size, price and review, and runs `runTrade` itself. Close is a reduce-only
 * market order on Perpl, which arrives with the perp ticket (U-14).
 */
function Actions({
  kind,
  onAdd,
  onSell,
}: {
  kind: 'perp' | 'spot';
  onAdd: () => void;
  onSell: () => void;
}) {
  return (
    <>
      <ButtonRow>
        <Button
          label={kind === 'perp' ? 'Add to position' : 'Buy more'}
          kind="soft"
          onPress={onAdd}
        />
        <Button
          label={kind === 'perp' ? 'Close position' : 'Sell'}
          kind="primary"
          disabled={kind === 'perp'}
          onPress={onSell}
          style={styles.grow}
        />
      </ButtonRow>
      {kind === 'perp' ? (
        <Text style={[text.caption, styles.pending]}>
          Closing from here arrives with the perp ticket.
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  failure: { marginBottom: 12 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headline: { marginTop: 14, gap: 4 },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  unit: { color: color.textDim },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chart: { marginTop: 14, minHeight: 150 },
  offchart: {
    marginTop: 6,
    fontFamily: font.chain,
    fontSize: 11,
    lineHeight: 16,
    color: color.berry,
  },
  rangesAfter: { marginTop: 4 },
  levels: { marginTop: 14 },
  protect: { marginTop: 14, gap: 8 },
  protectOff: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
  },
  link: { color: color.purpleHi },
  rows: { marginTop: 8 },
  note: { marginTop: 10 },
  pending: { textAlign: 'center' },
});
