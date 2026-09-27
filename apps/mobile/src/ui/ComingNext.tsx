/**
 * The placeholder for a screen the trading-first shell (SEN-109) already has a
 * place for but not yet a body: Markets, Portfolio and the Trade ticket. It
 * says what is coming in plain words instead of showing an empty frame, and it
 * sits on the Goban board card so it reads as part of the app, not an error.
 * Each one is replaced wholesale by its own unit (U-5, U-12, U-13).
 */
import { StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './icons';
import { Card, Tag } from './kit';
import { color, RADIUS, text } from './theme';

export function ComingNext({
  icon,
  title,
  detail,
  points,
}: {
  icon: IconName;
  title: string;
  detail: string;
  /** What the screen will hold, one short line each. */
  points: readonly string[];
}) {
  return (
    <Card goban style={styles.card}>
      <View style={styles.head}>
        <View style={styles.glyph}>
          <Icon name={icon} size={24} color={color.purpleHi} />
        </View>
        <Tag label="Coming next" />
      </View>
      <Text style={text.title}>{title}</Text>
      <Text style={text.dim}>{detail}</Text>
      <View style={styles.points}>
        {points.map((point) => (
          <View key={point} style={styles.point}>
            <View style={styles.dot} />
            <Text style={[text.body, styles.pointText]}>{point}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16, gap: 10 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  glyph: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.well,
    alignItems: 'center',
    justifyContent: 'center',
  },
  points: { gap: 8, marginTop: 6 },
  point: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.textFaint },
  pointText: { flex: 1, color: color.textDim },
});
