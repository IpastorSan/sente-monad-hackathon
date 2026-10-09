/**
 * The user's face on web (SEN-172): the same `avatarArt` shapes as the native
 * Skia `Avatar.tsx`, rendered by `avatarSvg` into an `<img>`. Not a Skia
 * canvas: each one holds a WebGL context and Chrome drops the oldest past ~16
 * per page, which turned icons into broken images on Home (SEN-174).
 */
import { useMemo } from 'react';
import { View } from 'react-native';

import { avatarSvg } from './avatarArt';

export function Avatar({ seed, size = 36 }: { seed: string; size?: number }) {
  const src = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(seed, size))}`,
    [seed, size],
  );
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={{ display: 'block', width: size, height: size, pointerEvents: 'none' }}
      />
    </View>
  );
}
