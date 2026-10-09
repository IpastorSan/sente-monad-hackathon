/**
 * Web twin of `GobanHero.tsx` (SEN-173): the same board, in the mockup's own
 * 200-unit viewBox, drawn as DOM SVG so Welcome spends no WebGL context on a
 * picture (`docs/web.md`).
 *
 * The breath is SMIL instead of a Reanimated value driving Skia: the same 3 s
 * in-and-out of the blurred halo's opacity, 0 → 0.8 → 0. Reduced motion leaves
 * the halo off, as on native.
 */
import { useId, useState } from 'react';
import { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { color } from './theme';

/** The mockup's viewBox side. */
const VIEW = 200;
const MAX_SIZE = 300;
/** One full breath, in then out, as the mockup's `breathe-stone`. */
const BREATH_MS = 3_000;
const LINES = Array.from({ length: 9 }, (_, i) => 20 + i * 20);
/** `Easing.inOut(Easing.ease)`, near enough, for each half of the breath. */
const EASE_IN_OUT = '0.42 0 0.58 1';

export function GobanHero() {
  const [width, setWidth] = useState(0);
  const size = Math.min(width, MAX_SIZE);
  const reduced = useReducedMotion();
  const blur = `${useId().replace(/[^a-zA-Z0-9]/g, '')}blur`;

  return (
    <View
      style={{ width: '100%', alignItems: 'center' }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size > 0 ? (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          aria-hidden
          focusable={false}
          style={{ display: 'block' }}
        >
          <defs>
            <filter id={blur} x="-150%" y="-150%" width="400%" height="400%">
              <feGaussianBlur stdDeviation={8} />
            </filter>
          </defs>

          <g stroke={color.lineStrong} strokeWidth={1}>
            {LINES.map((p) => (
              <g key={p}>
                <line x1={20} y1={p} x2={180} y2={p} />
                <line x1={p} y1={20} x2={p} y2={180} />
              </g>
            ))}
          </g>

          {/* The mandate: territory, then its boundary. */}
          <rect x={50} y={50} width={100} height={100} rx={4} fill="rgba(131, 110, 249, 0.07)" />
          <rect
            x={50}
            y={50}
            width={100}
            height={100}
            rx={4}
            fill="none"
            stroke={color.purpleSoft}
            strokeWidth={1}
            strokeDasharray="4 4"
          />

          <circle cx={80} cy={80} r={8} fill={color.text} />
          <circle cx={120} cy={120} r={8} fill={color.purple} />
          <circle cx={140} cy={80} r={8} fill={color.purple} />

          {/* Tengen, breathing. */}
          {reduced ? null : (
            <circle
              cx={100}
              cy={100}
              r={11}
              fill={color.purple}
              opacity={0}
              filter={`url(#${blur})`}
            >
              <animate
                attributeName="opacity"
                values="0;0.8;0"
                keyTimes="0;0.5;1"
                calcMode="spline"
                keySplines={`${EASE_IN_OUT};${EASE_IN_OUT}`}
                dur={`${BREATH_MS}ms`}
                repeatCount="indefinite"
              />
            </circle>
          )}
          <circle cx={100} cy={100} r={9} fill={color.purpleHi} />

          {/* A refusal, outside the line: the one move the enclave held. */}
          <circle cx={160} cy={140} r={7} fill="none" stroke={color.purpleSoft} strokeWidth={2} />
          <line x1={153} y1={147} x2={167} y2={133} stroke={color.purpleSoft} strokeWidth={2} />
        </svg>
      ) : null}
    </View>
  );
}
