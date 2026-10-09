/**
 * Markets (SEN-111, plan U-5; the study's `markets.html` → "Markets tab"):
 * every market Sente lists — Kuru's spot pairs and Perpl's perps — in one row
 * style, with chip filters, theme cards and a search box that opens `/search`.
 *
 * The list is short on purpose (four Kuru pairs, a handful of perps), so
 * there is no "all tokens" anywhere: the header count is `/markets`' own, and
 * themes only group markets that exist.
 *
 * Three states kept apart: an API that predates `/markets` gets an honest
 * "not on this server yet" (it is not an error); a venue that is down is
 * named above the half of the list that is left; a failed first load is an
 * error with a retry.
 *
 * Favourites are local to the device. A favourite's row leads its subline
 * with a filled star; on a phone a long press toggles it, and on the web
 * (SEN-179), where there is a pointer, the star is a button of its own that
 * shows on hover. The asset page (U-6) has the same star. Choices with a rule behind them are in `markets/select.ts` and
 * `markets/marketsView.ts`, under test.
 */
import * as Haptics from '@/platform/haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { MarketDto } from '@/markets/api';
import { useMarkets, useTickers } from '@/markets/hooks';
import { addRecent, flipFavourite, readFavourites } from '@/markets/localLists';
import {
  asPercent,
  downVenues,
  priceOf,
  sparkPoints,
  themeSymbols,
  venueLine,
} from '@/markets/marketsView';
import {
  changeOf,
  filterMarkets,
  indexTickers,
  inTheme,
  MARKET_FILTERS,
  marketKey,
  sortMarkets,
  themesFor,
  type MarketFilter,
  type MarketKey,
  type MarketSort,
  type Theme,
  type ThemeId,
} from '@/markets/select';
import { useSparklines } from '@/markets/useSparklines';
import { Icon } from '@/ui/icons';
import { Button, Chip, isHovered, Loading, Notice, Screen, Section, useWide } from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';
import { AsOf, ChangeText, MarketRow, TokenGlyph } from '@/ui/trading';

const SORTS: readonly { id: MarketSort; label: string }[] = [
  { id: 'change', label: '24h change ▾' },
  { id: 'volume', label: '24h volume ▾' },
  { id: 'symbol', label: 'A–Z' },
];

/** The heading over the list: what it holds right now. */
const LIST_LABEL: Record<MarketFilter, string> = {
  all: 'All markets',
  favourites: 'Favourites',
  spot: 'Spot',
  perps: 'Perps',
  gainers: 'Gainers',
  losers: 'Losers',
};

/** Said instead of an empty list, so a short list never reads as broken. */
const EMPTY: Record<MarketFilter, string> = {
  all: 'No markets are listed right now.',
  favourites: 'No favourites yet. Long-press a market to star it.',
  spot: 'No Kuru spot markets are listed right now.',
  perps: 'No Perpl perps are listed right now.',
  gainers: 'Nothing is up over the last 24 hours.',
  losers: 'Nothing is down over the last 24 hours.',
};

export default function MarketsScreen() {
  const router = useRouter();
  const markets = useMarkets();
  const wide = useWide();
  const tickers = useTickers();
  const [filter, setFilter] = useState<MarketFilter>('all');
  const [theme, setTheme] = useState<ThemeId | null>(null);
  const [sort, setSort] = useState<MarketSort>('change');
  const [favourites, setFavourites] = useState<ReadonlySet<MarketKey>>(new Set());

  // Re-read on focus: the asset page (U-6) can star a market too.
  useFocusEffect(
    useCallback(() => {
      void readFavourites().then(setFavourites);
    }, []),
  );

  const list = markets.data?.markets ?? null;
  const index = useMemo(() => indexTickers(tickers.data?.tickers ?? []), [tickers.data]);
  const klines = useSparklines(list);
  const themes = useMemo(() => (list ? themesFor(list, index) : []), [list, index]);

  const shown = useMemo(() => {
    if (list === null) return [];
    const inScope = theme === null ? list : list.filter((market) => inTheme(market, theme));
    const filtered = filterMarkets(inScope, filter, { tickers: index, favourites });
    // Gainers and losers come back ordered by the size of the move — the
    // question the chip asks — so the sort control stands aside for them.
    return filter === 'gainers' || filter === 'losers'
      ? filtered
      : sortMarkets(filtered, sort, index);
  }, [list, theme, filter, index, favourites, sort]);

  const open = (market: MarketDto) => {
    void addRecent({
      kind: 'market',
      venue: market.venue,
      symbol: market.symbol,
      label: market.kind === 'perp' ? market.symbol : market.base,
    });
    router.push({
      pathname: '/markets/[venue]/[symbol]',
      params: { venue: market.venue, symbol: market.symbol },
    });
  };

  const star = (market: MarketDto) => {
    void Haptics.selectionAsync();
    void flipFavourite(marketKey(market)).then(setFavourites);
  };

  const refresh = () => {
    markets.refresh();
    tickers.refresh();
  };

  const down = markets.data ? downVenues(markets.data) : [];
  const themeName = themes.find((t) => t.id === theme)?.name;
  const label = `${themeName ?? LIST_LABEL[filter]}${
    themeName && filter !== 'all' ? ` · ${LIST_LABEL[filter]}` : ''
  } · ${shown.length}`;
  const sortable = filter !== 'gainers' && filter !== 'losers';

  return (
    <Screen tabbed refreshing={false} onRefresh={refresh}>
      <View style={styles.head}>
        <Text style={text.display}>Markets</Text>
        {list !== null ? <AsOf at={tickers.asOf} paused={tickers.stale} /> : null}
      </View>

      <Pressable
        accessibilityRole="search"
        accessibilityLabel="Search markets and agents"
        onPress={() => router.push('/search')}
        style={({ pressed }) => [styles.search, pressed && styles.pressed]}
      >
        <Text style={styles.searchPlaceholder}>Markets and agents</Text>
      </Pressable>

      {markets.unavailable ? (
        <View style={styles.block}>
          <Notice
            title="Markets aren't on this server yet"
            detail="The API this app is talking to predates the markets list. Your agents keep trading; this tab fills in once the server is updated."
          />
        </View>
      ) : list === null ? (
        markets.error ? (
          <View style={styles.block}>
            <Notice tone="error" title="Couldn't load the markets" detail={markets.error.message} />
            <Button label="Try again" onPress={refresh} />
          </View>
        ) : (
          <Loading />
        )
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
            contentContainerStyle={styles.stripContent}
          >
            {MARKET_FILTERS.map(({ id, label: chip }) => (
              <Chip
                key={id}
                label={id === 'favourites' ? 'Favourites' : chip}
                icon={id === 'favourites' ? 'star' : undefined}
                selected={filter === id}
                onPress={() => setFilter(id)}
              />
            ))}
          </ScrollView>

          {themes.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.strip}
              contentContainerStyle={styles.themes}
            >
              {themes.map((t) => (
                <ThemeCard
                  key={t.id}
                  theme={t}
                  selected={theme === t.id}
                  onPress={() => setTheme(theme === t.id ? null : t.id)}
                />
              ))}
            </ScrollView>
          ) : null}

          {down.length > 0 ? (
            <View style={styles.block}>
              <Notice
                title={`${down.join(' and ')} isn't answering`}
                detail="Its markets are missing from this list until it is back."
              />
            </View>
          ) : null}

          <Section
            label={label}
            aside={
              sortable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Sorted by ${SORTS.find((s) => s.id === sort)?.label}. Change sort`}
                  hitSlop={10}
                  onPress={() => setSort(nextSort(sort))}
                >
                  <Text style={text.caption}>{SORTS.find((s) => s.id === sort)?.label}</Text>
                </Pressable>
              ) : null
            }
          >
            {shown.length === 0 ? (
              <Text style={[text.dim, styles.empty]}>{EMPTY[filter]}</Text>
            ) : (
              shown.map((market, i) => {
                const key = marketKey(market);
                const price = priceOf(market, index);
                const starred = favourites.has(key);
                return (
                  // The row itself has no long press, so this wrapper takes
                  // both gestures and the row stays a plain layout.
                  <Pressable
                    key={key}
                    onPress={() => open(market)}
                    onLongPress={() => star(market)}
                    accessibilityRole="button"
                    accessibilityHint={
                      starred ? 'Long-press to remove from favourites' : 'Long-press to star'
                    }
                    accessibilityActions={[
                      { name: 'longpress', label: starred ? 'Unstar' : 'Star' },
                    ]}
                    onAccessibilityAction={() => star(market)}
                    style={({ pressed }) => [styles.rowLine, pressed && styles.pressed]}
                  >
                    {(state) => (
                      <>
                        {Platform.OS === 'web' ? (
                          <RowStar
                            starred={starred}
                            visible={starred || isHovered(state)}
                            symbol={market.symbol}
                            hang={wide}
                            onPress={() => star(market)}
                          />
                        ) : null}
                        <View style={styles.rowMain}>
                          <MarketRow
                            symbol={market.base}
                            subline={venueLine(market)}
                            starred={starred && Platform.OS !== 'web'}
                            price={price ?? ''}
                            tick={market.tickSize}
                            changePct={asPercent(changeOf(market, index))}
                            points={sparkPoints(klines.get(key) ?? [], price)}
                            perp={
                              market.kind === 'perp' ? { leverage: market.maxLeverage } : undefined
                            }
                            divider={i < shown.length - 1}
                          />
                        </View>
                      </>
                    )}
                  </Pressable>
                );
              })
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}

/**
 * The web row's star (SEN-179): a button in the row's leading gutter, shown on
 * hover and kept when the market is a favourite, so a pointer can toggle what
 * a phone toggles with a long press. Its own press never opens the market.
 */
function RowStar({
  starred,
  visible,
  symbol,
  hang,
  onPress,
}: {
  starred: boolean;
  visible: boolean;
  symbol: string;
  /** Hung in the margin left of the column (wide), so the rows stay aligned with the header. */
  hang: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        starred ? `Remove ${symbol} from favourites` : `Add ${symbol} to favourites`
      }
      accessibilityState={{ selected: starred }}
      onPress={onPress}
      style={(state) => [
        styles.rowStar,
        hang && styles.rowStarHung,
        !visible && styles.rowStarIdle,
        isHovered(state) && styles.rowStarHover,
      ]}
    >
      {(state) => (
        <Icon
          name="star"
          size={16}
          color={starred || isHovered(state) ? color.purpleHi : color.textFaint}
          fill={starred ? color.purpleHi : undefined}
        />
      )}
    </Pressable>
  );
}

function nextSort(sort: MarketSort): MarketSort {
  const at = SORTS.findIndex((s) => s.id === sort);
  return SORTS[(at + 1) % SORTS.length]!.id;
}

/** A theme: its stones, its name, how many markets and their mean 24h move. */
function ThemeCard({
  theme,
  selected,
  onPress,
}: {
  theme: Theme;
  selected: boolean;
  onPress: () => void;
}) {
  const count = theme.markets.length;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.theme, selected && styles.themeOn, pressed && styles.pressed]}
    >
      <View style={styles.stack}>
        {themeSymbols(theme.markets).map((symbol, i) => (
          <View key={symbol} style={[styles.stackStone, i > 0 && styles.stackOverlap]}>
            <TokenGlyph symbol={symbol} size="sm" />
          </View>
        ))}
      </View>
      <View>
        <Text style={text.strong} numberOfLines={1}>
          {theme.name}
        </Text>
        <Text style={text.caption} numberOfLines={1}>
          {count} {count === 1 ? 'market' : 'markets'}
          {theme.change !== null ? ' · ' : ''}
          {theme.change !== null ? (
            <ChangeText pct={asPercent(theme.change)} style={styles.themeChange} />
          ) : null}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: {
    height: 48,
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  search: {
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
    borderWidth: 1,
    borderColor: color.line,
  },
  searchPlaceholder: { fontFamily: font.regular, fontSize: 15, color: color.textFaint },
  pressed: { opacity: 0.7 },
  block: { marginTop: 20, gap: 12 },
  // The strips bleed to the screen edge, as in the study, so the next chip
  // peeks out and says the row scrolls.
  strip: { marginHorizontal: -GUTTER, marginTop: 12, flexGrow: 0 },
  stripContent: { paddingHorizontal: GUTTER, gap: 6 },
  themes: { paddingHorizontal: GUTTER, gap: 10 },
  theme: {
    width: 132,
    gap: 10,
    padding: 12,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.board,
  },
  themeOn: { borderColor: color.purple },
  stack: { flexDirection: 'row' },
  stackStone: { borderRadius: 14, borderWidth: 2, borderColor: color.board },
  stackOverlap: { marginLeft: -7 },
  themeChange: { fontSize: 12, lineHeight: 17 },
  empty: { paddingVertical: 16 },
  rowLine: { flexDirection: 'row', alignItems: 'center' },
  rowMain: { flex: 1, minWidth: 0 },
  rowStar: {
    width: 28,
    height: 28,
    marginLeft: -6,
    marginRight: 4,
    borderRadius: RADIUS.stone,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowStarHung: { marginLeft: -36, marginRight: 8 },
  // Invisible but still there, so a keyboard can reach it and the rows never shift.
  rowStarIdle: { opacity: 0 },
  rowStarHover: { backgroundColor: color.well },
});
