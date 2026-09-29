/**
 * A preset's detail (SEN-116, plan U-9; agents.html → "Hire Range Trader",
 * "Preset detail" and "…scrolled: live record").
 *
 * Everything here is drawn at the preset's default parameters from
 * `GET /presets` — the API's own render — or, until it answers or where the
 * route is missing, from the copy of `@sente/presets` bundled into the app
 * (SEN-160). So "How it decides" and "What it will be told" are the agent's
 * actual text, quoted, not a description of it. Configure changes the
 * parameters.
 *
 * The live record is the cohort from `GET /presets/:id/stats`, always with
 * its sample and window. No backtest, no projection: a preset with too few
 * agents says so, and a missing route shows no record rather than zeros.
 */
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getPreset } from '@sente/presets';

import { PresetsApi, type PresetStatsDto } from '@/presets/api';
import { cadenceLabel, defaultMarkets, riskOf, statsLine, venueLine } from '@/presets/cards';
import { presetToDto } from '@/presets/catalog';
import { cantDo, decisionSteps } from '@/presets/params';
import { useHirePreset } from '@/presets/usePresets';
import { useSession } from '@/session';
import { Joseki } from '@/ui/joseki';
import { Button, Notice, Screen, Section, TopBar } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

/** Lines of the strategy shown before "Show all". */
const COLLAPSED_LINES = 3;

type StatsState = { kind: 'loading' } | { kind: 'ready'; stats: PresetStatsDto } | { kind: 'none' };

export default function PresetDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const bundled = useMemo(() => {
    const found = id ? getPreset(id) : undefined;
    return found ? presetToDto(found) : null;
  }, [id]);
  // SEN-160: the server's copy when it answers — the text quoted here is then
  // the one a hire is rendered with. The bundle shows until it does, and
  // stands in for good only when the route is missing.
  const { state: served } = useHirePreset(id);
  const preset =
    served.kind === 'ready' || served.kind === 'update-app'
      ? served.dto
      : served.kind === 'missing'
        ? null
        : bundled;
  const presetId = preset?.id;

  const session = useSession();
  const signedIn = session.agents !== null;
  const auth = session.api;
  const [stats, setStats] = useState<StatsState>({ kind: 'loading' });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!presetId) return;
    if (!signedIn) {
      setStats({ kind: 'none' });
      return;
    }
    let cancelled = false;
    // Any failure — no route yet, a preset the server doesn't know, a blip —
    // means no record on screen. A missing number is honest; a zero is not.
    new PresetsApi({ auth }).stats(presetId).then(
      (value) => {
        if (!cancelled) setStats({ kind: 'ready', stats: value });
      },
      () => {
        if (!cancelled) setStats({ kind: 'none' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [presetId, signedIn, auth]);

  if (!preset) {
    return (
      <Screen>
        <TopBar back={{ label: 'Presets', onPress: () => router.back() }} />
        <Notice
          tone="error"
          title="No such preset"
          detail="It may have left the catalog. Go back and pick another."
        />
      </Screen>
    );
  }

  const risk = riskOf(preset);
  const markets = defaultMarkets(preset);
  const strategyLines = preset.defaults.strategy.split('\n').filter((line) => line.trim() !== '');
  const steps = decisionSteps(preset.defaults.strategy);
  const shown = expanded ? strategyLines : strategyLines.slice(0, COLLAPSED_LINES);
  const configure = () =>
    router.push(`/presets/${encodeURIComponent(preset.id)}/configure` as Href);

  return (
    <Screen
      footer={<Button label={`Configure ${preset.name}`} kind="primary" onPress={configure} />}
    >
      <TopBar back={{ label: 'Presets', onPress: () => router.back() }} />

      <View style={styles.hero}>
        <Joseki presetId={preset.id} large width={300} height={74} />
        <View style={styles.heroFoot}>
          <View style={styles.heroCopy}>
            <Text style={[text.display, styles.name]}>{preset.name}</Text>
            <Text style={text.caption}>
              {[
                venueLine(preset),
                ...markets,
                cadenceLabel(preset.defaults.suggestedCadenceSeconds),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <View
            style={styles.risk}
            accessible
            accessibilityLabel={`Risk ${risk.label === 'Med' ? 'medium' : risk.label.toLowerCase()}`}
          >
            {[1, 2, 3].map((i) => (
              <View key={i} style={[styles.stone, i <= risk.stones && styles.stoneOn]} />
            ))}
            <Text style={[text.caption, styles.riskLabel]}>{risk.label}</Text>
          </View>
        </View>
      </View>

      <Text style={[text.dim, styles.description]}>{preset.description}</Text>

      {steps.length > 0 ? (
        <Section label="How it decides">
          {steps.map((step, i) => (
            <View key={i} style={styles.step}>
              <Text style={[text.caption, text.num, styles.stepNumber]}>{i + 1}</Text>
              <Text style={[text.body, styles.stepText]}>{step}</Text>
            </View>
          ))}
          <Text style={[text.caption, styles.after]}>
            At the default settings. Configure changes the numbers.
          </Text>
        </Section>
      ) : null}

      <Section label="What it will be told">
        <View style={styles.given}>
          {shown.map((line, i) => (
            <Text key={i} style={[text.voice, styles.givenLine]}>
              {line}
            </Text>
          ))}
        </View>
        {strategyLines.length > COLLAPSED_LINES ? (
          <Text
            accessibilityRole="button"
            onPress={() => setExpanded(!expanded)}
            style={[text.dim, styles.more]}
          >
            {expanded ? 'Show less' : `Show all ${strategyLines.length} lines`}
          </Text>
        ) : null}
        <Text style={[text.caption, styles.after]}>
          This text is the whole strategy: nothing hidden sits behind it.
        </Text>
      </Section>

      <LiveRecord state={stats} />

      <Section label="What it can’t do">
        {cantDo(preset.id).map((line) => (
          <View key={line} style={styles.step}>
            <Text style={[text.caption, styles.stepNumber]}>—</Text>
            <Text style={[text.dim, styles.stepText]}>{line}</Text>
          </View>
        ))}
      </Section>
    </Screen>
  );
}

/** The cohort, always with its sample; never a backtest. */
function LiveRecord({ state }: { state: StatsState }) {
  if (state.kind === 'loading') {
    return (
      <Section label="Agents running it now">
        <Text style={text.caption}>Loading the live record…</Text>
      </Section>
    );
  }
  if (state.kind === 'none') {
    return (
      <Section label="Agents running it now">
        <Text style={text.dim}>No live record to show yet.</Text>
      </Section>
    );
  }
  const { stats } = state;
  const line = statsLine(stats);
  return (
    <Section label="Agents running it now" aside={<Text style={text.caption}>30 days</Text>}>
      {line?.figure.kind === 'median' ? (
        <>
          <Text
            style={[
              styles.big,
              line.figure.direction === 'up' && text.up,
              line.figure.direction === 'down' && text.down,
            ]}
          >
            {line.figure.value}
          </Text>
          <Text style={text.caption}>
            Median of {stats.medianReturn30d !== null ? stats.returnN : stats.n} live agents ·{' '}
            {line.sample}
          </Text>
        </>
      ) : (
        <Text style={text.body}>
          Too new to rate: {stats.n} of the {stats.minN} agents a median needs.
        </Text>
      )}
      <View style={styles.wells}>
        <View style={styles.well}>
          <Text style={text.label}>Running</Text>
          <Text style={[text.strong, text.num]}>{stats.running}</Text>
        </View>
        <View style={styles.well}>
          <Text style={text.label}>In 30 days</Text>
          <Text style={[text.strong, text.num]}>{stats.n}</Text>
        </View>
        <View style={styles.well}>
          <Text style={text.label}>Customized</Text>
          <Text style={[text.strong, text.num]}>{stats.customized}</Text>
        </View>
      </View>
      <Text style={[text.caption, styles.after]}>
        Live results, not a backtest. Each agent has its own settings and mandate.
        {stats.definition ? ` ${stats.definition}` : ''}
      </Text>
      {stats.notes.map((note) => (
        <Text key={note} style={text.caption}>
          {note}
        </Text>
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: 4,
    padding: 14,
    paddingTop: 10,
    borderRadius: RADIUS.board,
    backgroundColor: color.board,
    borderWidth: 1,
    borderColor: color.line,
    overflow: 'hidden',
  },
  heroFoot: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 4 },
  heroCopy: { flex: 1, gap: 4 },
  name: { fontSize: 30, lineHeight: 34 },
  risk: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  stone: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.2,
    borderColor: color.lineStrong,
  },
  stoneOn: { backgroundColor: color.purpleHi, borderColor: color.purpleHi },
  riskLabel: { marginLeft: 3 },
  description: { marginTop: 14, fontSize: 14, lineHeight: 21 },
  step: { flexDirection: 'row', gap: 10, marginTop: 8 },
  stepNumber: { width: 14, marginTop: 3 },
  stepText: { flex: 1 },
  given: {
    padding: 14,
    gap: 6,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  givenLine: { fontSize: 15, lineHeight: 22 },
  more: { marginTop: 10, color: color.purpleHi },
  after: { marginTop: 10 },
  big: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 40,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  wells: { flexDirection: 'row', gap: 8, marginTop: 14 },
  well: {
    flex: 1,
    gap: 4,
    padding: 12,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
});
