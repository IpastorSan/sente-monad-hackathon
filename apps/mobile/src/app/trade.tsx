/**
 * Trade (SEN-109, SEN-119): what the dock's round button opens, as a modal
 * over whichever tab you were on (`presentation: 'modal'` in
 * `app/_layout.tsx`). A quick market picker (the study's `trade.html` → "Pick
 * a market"): recents first, then what you hold, then every market. Picking
 * one replaces the sheet with that market's page (SEN-179), so an order is
 * never placed blind: on a wide window the page has the ticket beside the
 * chart, ready for keys; on a phone the chart, with Sell/Buy pinned below. A
 * `side` this sheet was opened with rides along to preselect the ticket.
 *
 * - Search filters that short list; it never promises "any token" — Sente
 *   lists only what Kuru and Perpl run on Monad testnet.
 * - Each row names its venue and quote currency: USDC on Kuru, AUSD on Perpl.
 * - With trading off (`useTradingEnabled`) the whole sheet is the "coming"
 *   state: a picker that leads to tickets that can't place is a half-enabled
 *   feature, which the plan rules out.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { MarketDto } from '@/markets/api';
import { useMarkets, useTickers } from '@/markets/hooks';
import { addRecent, readRecents } from '@/markets/localLists';
import { asPercent, priceOf, venueLine, type Recent } from '@/markets/marketsView';
import { changeOf, indexTickers, search } from '@/markets/select';
import { useSession } from '@/session';
import { heldMarkets } from '@/trade/ticket';
import { useTradingEnabled } from '@/trade/useTradingEnabled';
import { ComingNext } from '@/ui/ComingNext';
import { Icon } from '@/ui/icons';
import {
  Button,
  Chip,
  Chips,
  IconButton,
  Loading,
  Notice,
  Screen,
  Section,
  TopBar,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { MarketRow } from '@/ui/trading';

export default function TradeScreen() {
  const router = useRouter();
  const trading = useTradingEnabled();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <Screen>
      <TopBar right={<IconButton icon="close" label="Close" onPress={close} />} />
      <Text style={[text.display, styles.title]}>Trade</Text>
      {trading ? (
        <Picker />
      ) : (
        <>
          <ComingNext
            icon="trade"
            title="Trading from your wallet is coming"
            detail="Your own orders from your own wallet, alongside your agents'."
            points={[
              'Buy and sell spot on Kuru',
              'Go long or short on Perpl perps, with leverage',
              'Set take-profit and stop on the ticket',
            ]}
          />
          <Button
            label="Browse markets"
            icon="markets"
            onPress={() => router.replace('/markets')}
            style={styles.browse}
          />
        </>
      )}
    </Screen>
  );
}

function Picker() {
  const router = useRouter();
  const { side } = useLocalSearchParams<{ side?: string }>();
  const session = useSession();
  const markets = useMarkets();
  const tickers = useTickers();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<Recent[]>([]);

  useEffect(() => {
    void readRecents().then(setRecents);
  }, []);

  const all = useMemo(() => markets.data?.markets ?? [], [markets.data]);
  const index = useMemo(() => indexTickers(tickers.data?.tickers ?? []), [tickers.data]);
  const held = useMemo(
    () => heldMarkets(all, session.wallet.wallet?.balances ?? []),
    [all, session.wallet.wallet],
  );
  const found = useMemo(() => search(query, all, []).markets, [query, all]);
  const recentMarkets = recents.filter(
    (r): r is Extract<Recent, { kind: 'market' }> => r.kind === 'market',
  );

  const open = (market: { venue: MarketDto['venue']; symbol: string }, label: string) => {
    void addRecent({ kind: 'market', venue: market.venue, symbol: market.symbol, label }).then(
      setRecents,
    );
    // Replace, not push: the sheet closes, and back from the market goes to
    // wherever the sheet was opened from.
    router.replace({
      pathname: '/markets/[venue]/[symbol]',
      params: { venue: market.venue, symbol: market.symbol, ...(side ? { side } : {}) },
    });
  };

  const row = (market: MarketDto, subline = venueLine(market), last = false) => (
    <MarketRow
      key={`${market.venue}:${market.symbol}`}
      symbol={market.base}
      subline={subline}
      price={priceOf(market, index) ?? ''}
      tick={market.tickSize}
      changePct={asPercent(changeOf(market, index))}
      perp={market.kind === 'perp' ? { leverage: market.maxLeverage } : undefined}
      divider={!last}
      onPress={() => open(market, market.symbol)}
    />
  );

  return (
    <View>
      <View style={styles.search}>
        <Icon name="markets" size={16} color={color.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search markets"
          placeholderTextColor={color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          cursorColor={color.purpleHi}
          selectionColor={color.purple}
          style={styles.input}
          accessibilityLabel="Search markets"
        />
      </View>

      {markets.data === null ? (
        markets.error ? (
          <Notice
            tone="error"
            title={
              markets.unavailable ? "Markets aren't on this server yet" : "Couldn't load markets"
            }
            detail={markets.unavailable ? undefined : markets.error.message}
          />
        ) : (
          <Loading />
        )
      ) : query.trim() !== '' ? (
        <Section label={found.length > 0 ? 'Markets' : 'No match'}>
          {found.length > 0 ? (
            found.map((m, i) => row(m, undefined, i === found.length - 1))
          ) : (
            <Text style={text.dim}>
              Sente lists what Kuru and Perpl run on Monad testnet — {all.length} markets.
            </Text>
          )}
        </Section>
      ) : (
        <>
          {recentMarkets.length > 0 ? (
            <Section label="Recent">
              <Chips>
                {recentMarkets.map((r) => (
                  <Chip
                    key={`${r.venue}:${r.symbol}`}
                    label={r.label}
                    selected={false}
                    onPress={() => open(r, r.label)}
                  />
                ))}
              </Chips>
            </Section>
          ) : null}
          {held.length > 0 ? (
            <Section label="You hold">
              {held.map(({ market, holding }, i) =>
                row(market, `${holding} · ${venueLine(market)}`, i === held.length - 1),
              )}
            </Section>
          ) : null}
          <Section label="All markets">
            {all.map((m, i) => row(m, undefined, i === all.length - 1))}
          </Section>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  browse: { marginTop: 16 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: color.text,
    paddingVertical: 12,
  },
});
