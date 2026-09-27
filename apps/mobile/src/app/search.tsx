/**
 * Search (SEN-111, plan U-5; `markets.html` → "Search focused"): one box over
 * markets and agents. A stack screen above the tabs rather than a state of the
 * Markets tab, so the dock is out of the way while the keyboard is up, as the
 * study asks, and Back is the Cancel.
 *
 * - Recents stay as a chip row while you type, so the last thing you opened
 *   is one tap away. They live on the device (`markets/localLists.ts`).
 * - Agents match by what they trade, not just by name: "mon" finds an agent
 *   trading MON-USDC (`search` in `markets/select.ts`). Yours come from
 *   `GET /agents`; everyone else's from the Board, read once when the screen
 *   opens. When the indexer is unconfigured or unreachable the Board has no
 *   numbers, so its agents are left out rather than listed without a sample.
 * - Nothing moves money from here. Yours opens its screen; someone else's
 *   opens its Ledger, where forking the strategy is the primary action. (The
 *   study's "Hire" prefilling a preset waits for the preset flow, U-9.)
 * - The tail says why the list is short: Sente lists only what Kuru and Perpl
 *   run on Monad testnet, so a miss is not "no results", it is the whole set.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { AgentSummary, Leaderboard } from '@/agents/api';
import { useAgentsOverview } from '@/agents/useAgentsOverview';
import type { MarketDto } from '@/markets/api';
import { useMarkets, useTickers } from '@/markets/hooks';
import { addRecent, readRecents } from '@/markets/localLists';
import {
  agentsHeading,
  asPercent,
  highlight,
  priceOf,
  searchAgents,
  venueLine,
  type Recent,
  type SearchAgent,
} from '@/markets/marketsView';
import { changeOf, indexTickers, search } from '@/markets/select';
import { useSession } from '@/session';
import { Sigil } from '@/ui/goban';
import { Button, Chip, Screen, Section, SectionLink, Segmented } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { ChangeText, PerpTag, TokenGlyph } from '@/ui/trading';
import { formatPrice } from '@/ui/tradingFormat';

type Scope = 'all' | 'markets' | 'agents';

const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'markets', label: 'Markets' },
  { value: 'agents', label: 'Agents' },
];

const NO_SUMMARIES: ReadonlyMap<string, AgentSummary> = new Map();

export default function SearchScreen() {
  const router = useRouter();
  const { agents: agentsApi } = useSession();
  const markets = useMarkets();
  const tickers = useTickers();
  const { state: overview } = useAgentsOverview();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [recents, setRecents] = useState<Recent[]>([]);
  const [board, setBoard] = useState<Leaderboard | null>(null);

  useEffect(() => {
    void readRecents().then(setRecents);
  }, []);

  // Once per visit: the Board is read live from the indexer on every request,
  // and a search box has no reason to poll it.
  useEffect(() => {
    if (!agentsApi) return;
    let cancelled = false;
    agentsApi.leaderboard().then(
      (answer) => {
        if (!cancelled && answer.source.kind === 'ok') setBoard(answer);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [agentsApi]);

  const index = useMemo(() => indexTickers(tickers.data?.tickers ?? []), [tickers.data]);
  const agents = useMemo(
    () =>
      overview.kind === 'loaded'
        ? searchAgents(overview.agents, overview.summaries, board)
        : searchAgents([], NO_SUMMARIES, board),
    [overview, board],
  );
  const results = useMemo(
    () => search(query, markets.data?.markets ?? [], agents),
    [query, markets.data, agents],
  );

  const remember = (entry: Recent) => {
    void addRecent(entry).then(setRecents);
  };

  const openMarket = (market: { venue: MarketDto['venue']; symbol: string }, label: string) => {
    remember({ kind: 'market', venue: market.venue, symbol: market.symbol, label });
    router.push({
      pathname: '/markets/[venue]/[symbol]',
      params: { venue: market.venue, symbol: market.symbol },
    });
  };

  const openAgent = (agent: { id: string; own: boolean }, label: string) => {
    remember({ kind: 'agent', id: agent.id, own: agent.own, label });
    if (agent.own) router.push({ pathname: '/agents/[id]', params: { id: agent.id } });
    else router.push({ pathname: '/agents/[id]/ledger', params: { id: agent.id } });
  };

  const openRecent = (recent: Recent) =>
    recent.kind === 'market' ? openMarket(recent, recent.label) : openAgent(recent, recent.label);

  const typed = query.trim() !== '';
  const showMarkets = scope !== 'agents';
  const showAgents = scope !== 'markets';

  return (
    <Screen>
      <View style={styles.bar}>
        <View style={styles.field}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Markets and agents"
            placeholderTextColor={color.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            cursorColor={color.purpleHi}
            selectionColor={color.purple}
            style={styles.input}
            accessibilityLabel="Search markets and agents"
          />
          {typed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear"
              hitSlop={10}
              onPress={() => setQuery('')}
            >
              <Text style={styles.clear}>×</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>

      {recents.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.recents}
        >
          <Text style={text.caption}>Recent</Text>
          {recents.map((recent) => (
            <Chip
              key={recent.kind === 'market' ? `${recent.venue}:${recent.symbol}` : recent.id}
              label={recent.label}
              selected={false}
              onPress={() => openRecent(recent)}
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.scopes}>
        <Segmented options={SCOPES} value={scope} onChange={setScope} />
      </View>

      {!typed ? (
        <Text style={[text.dim, styles.hint]}>
          Search by symbol, like MON or ETH, or by an agent&apos;s name. An agent also shows up
          under the markets it trades.
        </Text>
      ) : (
        <>
          {showMarkets && results.markets.length > 0 ? (
            <Section label="Markets">
              {results.markets.map((market, i) => {
                const price = priceOf(market, index);
                const shown = price === null ? null : formatPrice(price, market.tickSize);
                return (
                  <Result
                    key={`${market.venue}:${market.symbol}`}
                    divider={i < results.markets.length - 1}
                    lead={<TokenGlyph symbol={market.base} />}
                    title={
                      <>
                        <Highlighted text={market.base} query={query} />
                        {market.kind === 'perp' ? ' ' : null}
                        {market.kind === 'perp' ? <PerpTag leverage={market.maxLeverage} /> : null}
                      </>
                    }
                    caption={`${venueLine(market)}${shown ? ` · ${shown}` : ''}`}
                    trailing={<ChangeText pct={asPercent(changeOf(market, index))} />}
                    onPress={() =>
                      openMarket(market, market.kind === 'perp' ? market.symbol : market.base)
                    }
                  />
                );
              })}
            </Section>
          ) : null}

          {showAgents && results.agents.length > 0 ? (
            <Section
              label={agentsHeading(results.markets)}
              aside={
                board !== null ? (
                  <SectionLink label="Top agents" onPress={() => router.push('/leaderboard')} />
                ) : undefined
              }
            >
              {results.agents.map((agent, i) => (
                <AgentResult
                  key={agent.id}
                  agent={agent}
                  query={query}
                  divider={i < results.agents.length - 1}
                  onPress={() => openAgent(agent, agent.name)}
                />
              ))}
            </Section>
          ) : null}

          <Text style={[text.caption, styles.tail]}>
            {results.markets.length + results.agents.length === 0
              ? `Nothing matches “${query.trim()}”. `
              : 'No other tokens match. '}
            Sente lists the markets Kuru and Perpl run on Monad testnet.
          </Text>
        </>
      )}
    </Screen>
  );
}

function AgentResult({
  agent,
  query,
  divider,
  onPress,
}: {
  agent: SearchAgent;
  query: string;
  divider: boolean;
  onPress: () => void;
}) {
  return (
    <Result
      divider={divider}
      lead={<Sigil seed={agent.id} size={36} />}
      title={
        <>
          <Highlighted text={agent.name} query={query} />
          {agent.roi ? (
            <Text style={[text.num, agent.roi.up ? text.up : text.down]}>
              {'  '}
              {agent.roi.label}
            </Text>
          ) : null}
        </>
      }
      caption={agent.caption}
      trailing={<Button label="View" size="sm" kind="soft" onPress={onPress} />}
      onPress={onPress}
    />
  );
}

/** A search hit: a stone or sigil, a title over a caption, something on the right. */
function Result({
  lead,
  title,
  caption,
  trailing,
  divider,
  onPress,
}: {
  lead: ReactNode;
  title: ReactNode;
  caption: string;
  trailing: ReactNode;
  divider: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.result, divider && styles.divider, pressed && styles.pressed]}
    >
      {lead}
      <View style={styles.resultMain}>
        <Text style={text.strong} numberOfLines={1}>
          {title}
        </Text>
        <Text style={text.caption} numberOfLines={1}>
          {caption}
        </Text>
      </View>
      {trailing}
    </Pressable>
  );
}

function Highlighted({ text: value, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(value, query).map((run, i) =>
        run.hit ? (
          <Text key={i} style={styles.hit}>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
    borderWidth: 1,
    borderColor: color.purple,
  },
  input: {
    flex: 1,
    paddingVertical: 11,
    fontFamily: font.regular,
    fontSize: 15,
    color: color.text,
  },
  clear: { fontFamily: font.medium, fontSize: 20, lineHeight: 22, color: color.textFaint },
  cancel: { fontFamily: font.medium, fontSize: 15, color: color.purpleHi },
  recents: { alignItems: 'center', gap: 8, marginTop: 12 },
  scopes: { marginTop: 14 },
  hint: { marginTop: 20 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  pressed: { opacity: 0.7 },
  resultMain: { flex: 1, minWidth: 0, gap: 1 },
  hit: { color: color.text, backgroundColor: 'rgba(131, 110, 249, 0.28)' },
  tail: { marginTop: 18, textAlign: 'center' },
});
