/**
 * The consensus ramp's track and fill (SEN-24, SEN-60), drawn as one Skia
 * surface so the track and the fill can never round to different pixel rows.
 * `ConsensusRamp.tsx` owns the state and the animation; this only paints it.
 *
 * Native only: the web build resolves `ConsensusTrack.web.tsx`. A ledger is a
 * column of ramps, and on web each Skia canvas is a WebGL context — Chrome
 * keeps ~16 per page (SEN-173, `docs/web.md`).
 */
import {
  BlurMask,
  Canvas,
  Group,
  LinearGradient,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';

import { color } from './theme';

export type ConsensusTrackProps = {
  width: number;
  /** The fill's width in px, on the UI thread. */
  fillWidth: Readonly<SharedValue<number>>;
  /** The purple's presence, 0..1. */
  lit: Readonly<SharedValue<number>>;
  /** The track's thickness. */
  track: number;
  /** Room above and below the track for the glow; the margins pull in by as much. */
  glow: number;
};

export function ConsensusTrack({ width, fillWidth, lit, track, glow }: ConsensusTrackProps) {
  return (
    <Canvas style={{ width, height: track + glow * 2, marginVertical: -glow }}>
      <RoundedRect x={0} y={glow} width={width} height={track} r={track / 2} color={color.line} />
      <RoundedRect
        x={0}
        y={glow}
        width={fillWidth}
        height={track}
        r={track / 2}
        color={color.lineStrong}
      />
      <Group opacity={lit}>
        <RoundedRect
          x={0}
          y={glow}
          width={fillWidth}
          height={track}
          r={track / 2}
          color={color.purple}
        >
          <BlurMask blur={5} style="normal" />
        </RoundedRect>
        <RoundedRect x={0} y={glow} width={fillWidth} height={track} r={track / 2}>
          <LinearGradient
            start={vec(0, 0)}
            end={vec(Math.max(width, 1), 0)}
            colors={[color.purple, color.purpleHi]}
          />
        </RoundedRect>
      </Group>
    </Canvas>
  );
}
