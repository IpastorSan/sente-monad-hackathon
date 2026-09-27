/**
 * Preset cards for the Agents tab (SEN-114; agents.html → "Agents tab" and
 * "The catalog"): the joseki, the name and promise, a meta line (tokens,
 * venue, risk stones, cadence) and the cohort line with its sample. Every
 * word comes from `cards.ts`; this file only lays it out.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Joseki } from '@/ui/joseki';
import { TokenGlyph } from '@/ui/trading';
import { color, font, RADIUS, text } from '@/ui/theme';

import type { PresetDto, PresetStatsDto } from './api';
import {
  cadenceLabel,
  defaultMarkets,
  FEATURED_NOTE,
  riskOf,
  statsLine,
  venueLine,
  type Risk,
  type StatsLine,
} from './cards';

export function PresetCard({
  preset,
  stats,
  onPress,
}: {
  preset: PresetDto;
  stats: PresetStatsDto | undefined;
  onPress: () => void;
}) {
  const line = statsLine(stats);
  const markets = defaultMarkets(preset);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${preset.name}. ${preset.tagline}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <Joseki presetId={preset.id} />
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>
            {preset.name}
          </Text>
          <Text style={styles.promise}>{preset.tagline}</Text>
        </View>
      </View>
      <View style={styles.meta}>
        {markets.length > 0 ? (
          <View style={styles.toks}>
            {markets.map((market, i) => (
              <View key={market} style={i > 0 && styles.tokOverlap}>
                <TokenGlyph symbol={market} size="sm" />
              </View>
            ))}
          </View>
        ) : null}
        <Text style={styles.metaText}>{venueLine(preset)}</Text>
        <Dot />
        <RiskStones risk={riskOf(preset)} />
        <Dot />
        <Text style={styles.metaText}>{cadenceLabel(preset.defaults.suggestedCadenceSeconds)}</Text>
      </View>
      {line ? <Stats line={line} /> : null}
    </Pressable>
  );
}

/**
 * The featured card: Guardian, because it answers "where is my stop-loss?"
 * honestly — a watched line, never a venue order.
 */
export function FeaturedPreset({
  preset,
  stats,
  onPress,
}: {
  preset: PresetDto;
  stats: PresetStatsDto | undefined;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Featured: ${preset.name}. ${preset.tagline}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, styles.feature, pressed && styles.pressed]}
    >
      <Joseki presetId={preset.id} large width={124} height={118} style={styles.featureBoard} />
      <View style={styles.featureCopy}>
        <Text style={styles.eyebrow}>Featured preset</Text>
        <Text style={[text.title, styles.featureName]}>{preset.name}</Text>
        <Text style={styles.promise}>{preset.tagline}</Text>
      </View>
      <Text style={[text.caption, styles.featureNote]}>{FEATURED_NOTE}</Text>
      <View style={styles.meta}>
        <RiskStones risk={riskOf(preset)} />
        <Dot />
        <Text style={styles.metaText}>{cadenceLabel(preset.defaults.suggestedCadenceSeconds)}</Text>
        {stats ? (
          <>
            <Dot />
            <Text style={styles.metaText}>{stats.running} running</Text>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Risk as three stones: filled = how far its suggested limits let it move against you. */
function RiskStones({ risk }: { risk: Risk }) {
  return (
    <View
      style={styles.risk}
      accessible
      accessibilityLabel={`Risk ${risk.label === 'Med' ? 'medium' : risk.label.toLowerCase()}`}
    >
      {[1, 2, 3].map((i) => (
        <View key={i} style={[styles.riskStone, i <= risk.stones && styles.riskOn]} />
      ))}
      <Text style={[styles.metaText, styles.riskLabel]}>{risk.label}</Text>
    </View>
  );
}

function Stats({ line }: { line: StatsLine }) {
  const { figure } = line;
  return (
    <View style={styles.stats}>
      <Text style={styles.statsText} numberOfLines={1}>
        {line.running}
        {figure.kind === 'median' ? (
          <>
            {' · median '}
            <Text
              style={[
                styles.statsFigure,
                figure.direction === 'up' && text.up,
                figure.direction === 'down' && text.down,
              ]}
            >
              {figure.value}
            </Text>
          </>
        ) : figure.kind === 'too-new' ? (
          ' · Too new to rate'
        ) : null}
      </Text>
      <Text style={styles.sample}>{line.sample}</Text>
    </View>
  );
}

function Dot() {
  return <View style={styles.dot} />;
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    borderRadius: RADIUS.board,
    backgroundColor: color.board,
    borderWidth: 1,
    borderColor: color.line,
    gap: 6,
  },
  pressed: { opacity: 0.85 },
  top: { flexDirection: 'row', gap: 14 },
  head: { flex: 1, gap: 3 },
  name: {
    fontFamily: font.displaySemibold,
    fontSize: 17,
    lineHeight: 20,
    letterSpacing: -0.2,
    color: color.text,
  },
  promise: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: color.textDim },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 10,
    rowGap: 6,
    marginTop: 6,
  },
  metaText: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: color.textDim },
  dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: color.lineStrong },
  toks: { flexDirection: 'row' },
  tokOverlap: { marginLeft: -6 },
  risk: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  riskStone: {
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 1.2,
    borderColor: color.lineStrong,
  },
  riskOn: { backgroundColor: color.purpleHi, borderColor: color.purpleHi },
  riskLabel: { marginLeft: 3 },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    paddingTop: 10,
    marginTop: 4,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderTopColor: color.lineStrong,
  },
  statsText: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  statsFigure: { fontFamily: font.medium, color: color.text },
  sample: { fontFamily: font.chain, fontSize: 11, lineHeight: 16, color: color.textFaint },
  feature: { padding: 18, paddingBottom: 16, gap: 8, overflow: 'hidden' },
  featureBoard: { position: 'absolute', right: -8, top: 8, opacity: 0.95 },
  featureCopy: { maxWidth: 190, gap: 6 },
  featureNote: { maxWidth: 230 },
  featureName: { fontSize: 22, lineHeight: 26 },
  eyebrow: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.purpleHi,
  },
});
