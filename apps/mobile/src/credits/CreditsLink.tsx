/**
 * The link an out-of-credits message carries to the Credits screen (SEN-183).
 * Renders nothing unless the reason is one that screen answers, so a caller
 * can drop it under any notice without branching.
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { color, font } from '@/ui/theme';

import { isCreditsReason } from './view';

export function CreditsLink({
  reason,
  label = 'See your credits',
}: {
  /** A refusal or pause reason; the link shows only for `credits_exhausted` and `credits_low`. */
  reason: string | null | undefined;
  label?: string;
}) {
  const router = useRouter();
  if (!isCreditsReason(reason)) return null;
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={10}
      onPress={() => router.push('/credits')}
      style={styles.link}
    >
      <Text style={styles.text}>{label} →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: 'flex-start', marginTop: 8 },
  text: { fontFamily: font.medium, fontSize: 13, color: color.purpleHi },
});
