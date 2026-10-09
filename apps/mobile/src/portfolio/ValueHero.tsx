/**
 * The Portfolio hero (SEN-152): the ≈ $ total, its change over the chosen
 * range and a sign-tinted area chart with 1D / 1W / 1M / ALL pills — the
 * `hero-v` block of `docs/design/trading/portfolio.html`.
 *
 * The line is the server's recorded history (`GET /portfolio/history`) ending
 * at the live total. Until the server has a point in the range — trading off,
 * an API without the route, a user it has not recorded yet — the hero keeps
 * what it always drew: the total as this phone saw it since the app opened,
 * captioned that way, with no pills to promise a history that is not there.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Chart } from '@/ui/chart/Chart';
import { text } from '@/ui/theme';
import { BigNumber, ChangeText, RangePills } from '@/ui/trading';

import { HERO_RANGES, heroLine, PARTIAL_NOTE, type HeroRange } from './history';
import { useObservedValue } from './usePortfolio';
import { useValueHistory } from './useValueHistory';
import { cents, clock, seriesChange, shown, signedUsd } from './view';

export function ValueHero({
  total,
  approx,
  at,
  trading,
  hidden,
  note,
}: {
  /** The exact $ total the screen computed, agents included; shown floored to the cent. */
  total: string;
  /** Some of it is a token valued at its Kuru price (`totalIsApprox`). */
  approx: boolean;
  /** The newest data time behind `total`, `null` before any read. */
  at: number | null;
  trading: boolean;
  hidden: boolean;
  /** What the ≈ $ leaves out, said under it. */
  note: string;
}) {
  const [range, setRange] = useState<HeroRange>('1D');
  const history = useValueHistory(trading, range);
  // Once any range has answered with points, the pills stay: switching to a
  // range still loading must not make them vanish under the thumb.
  const [recorded, setRecorded] = useState(false);
  useEffect(() => {
    if (history.data && history.data.points.length > 0) setRecorded(true);
  }, [history.data]);

  const observed = useObservedValue(total, at);
  const line = heroLine(history.data, range, at === null ? null : { at, usd: total });
  const points = line?.points ?? observed;
  const change = line ? line.change : seriesChange(observed);
  const suffix = line?.suffix ?? ` since ${clock(observed[0]?.at ?? Date.now())} UTC`;

  return (
    <>
      <View style={styles.hero}>
        <Text style={text.label}>Total value</Text>
        <BigNumber
          value={cents(total) ?? total}
          prefix="$"
          approx={approx}
          size="xl"
          blurred={hidden}
        />
        {change !== null ? (
          <ChangeText
            pct={change.pct}
            lead={`${shown(signedUsd(change.delta), hidden)} (`}
            suffix={`)${suffix}`}
          />
        ) : null}
        {points.length > 1 ? (
          <Chart
            kind="area"
            points={points.map((s) => s.usd)}
            height={128}
            // Tinted by the sign of the selected range (design notes).
            tone={change?.tone === 'down' ? 'berry' : 'mint'}
            label={line ? `Portfolio value, ${range}` : 'Portfolio value since the app opened'}
          />
        ) : null}
        <Text style={text.caption}>{line?.partial ? `${note} ${PARTIAL_NOTE}` : note}</Text>
      </View>
      {recorded ? <RangePills options={HERO_RANGES} value={range} onChange={setRange} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  hero: { marginTop: 12, gap: 6 },
});
