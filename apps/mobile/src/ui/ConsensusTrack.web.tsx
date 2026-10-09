/**
 * Web twin of `ConsensusTrack.tsx` (SEN-173): the same track, fill, glow and
 * gradient as DOM elements driven by Reanimated styles, so a ledger of ramps
 * costs no WebGL contexts (`docs/web.md`). The gradient spans the whole track,
 * as the Skia one does, and the fill reveals it from the left.
 */
import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import type { ConsensusTrackProps } from './ConsensusTrack';
import { color } from './theme';

export function ConsensusTrack({ width, fillWidth, lit, track, glow }: ConsensusTrackProps) {
  const fill = useAnimatedStyle(() => ({ width: fillWidth.value }));
  const lighting = useAnimatedStyle(() => ({ width: fillWidth.value, opacity: lit.value }));
  const bar = {
    position: 'absolute',
    left: 0,
    top: glow,
    height: track,
    borderRadius: track / 2,
  } as const;
  const layer = { position: 'absolute', inset: 0, borderRadius: track / 2 } as const;

  return (
    <View style={{ width, height: track + glow * 2, marginVertical: -glow }} pointerEvents="none">
      <View style={[bar, { width, backgroundColor: color.line }]} />
      <Animated.View style={[bar, { backgroundColor: color.lineStrong }, fill]} />
      <Animated.View style={[bar, lighting]}>
        <div style={{ ...layer, background: color.purple, filter: 'blur(5px)' }} />
        <div
          style={{
            ...layer,
            background: `linear-gradient(to right, ${color.purple}, ${color.purpleHi}) 0 0 / ${Math.max(width, 1)}px 100% no-repeat`,
          }}
        />
      </Animated.View>
    </View>
  );
}
