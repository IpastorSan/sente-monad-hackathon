/**
 * One move as a stone and a line, with how long ago (SEN-58): the last move on
 * an agent card, and the latest moves on the agent screen. The words come from
 * `describeMove`, so both screens and the Ledger say the same thing.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Stone } from '@/ui/goban';
import { text } from '@/ui/theme';

import { relativeAge, type Move } from './usage';

export function MoveLine({ move, now }: { move: Move; now: number }) {
  return (
    <View style={styles.line}>
      <Stone kind={move.stone} size={10} />
      <Text style={[text.dim, styles.grow]} numberOfLines={1}>
        {move.line}
      </Text>
      <Text style={[text.caption, text.num]}>{relativeAge(move.at, now)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1 },
});
