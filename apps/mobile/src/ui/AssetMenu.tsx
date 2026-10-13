/**
 * The dropdown under a total's asset (SEN-213): every held asset's exact
 * amount, the headline one checked. One anchored menu on both platforms, in a
 * transparent `Modal` so it floats above scroll views and closes on a tap
 * outside, Android back or (react-native-web) Escape; on web the Modal traps
 * focus and hands it back to the trigger on close, and the arrow keys, Home
 * and End move between rows.
 */
import { useEffect, useRef } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';

import { amountFigure, type AssetAmount } from './assetAmounts';
import { Icon } from './icons';
import { color, font, RADIUS, text } from './theme';
import { maskDigits } from './tradingFormat';

/** Where the trigger sits, from `measureInWindow`. */
export type Anchor = { x: number; y: number; width: number; height: number };

const WIDTH = 280;
const EDGE = 16;

type Focusable = { focus?: () => void };

/** RN's `Role` has no `menuitemradio`; react-native-web passes it to the DOM as is. */
const ITEM_ROLE = (Platform.OS === 'web' ? { role: 'menuitemradio' } : { role: 'menuitem' }) as {
  role: 'menuitem';
};

export function AssetMenu({
  anchor,
  choices,
  selected,
  hidden,
  label,
  onSelect,
  onClose,
}: {
  /** Open when set. */
  anchor: Anchor | null;
  choices: readonly AssetAmount[];
  selected: string;
  /** Hide balances: the amounts are masked here as on the headline. */
  hidden: boolean;
  /** What the total is, for the menu's name: `Total value`. */
  label: string;
  onSelect: (asset: string) => void;
  onClose: () => void;
}) {
  const window = useWindowDimensions();
  const rows = useRef<(View | null)[]>([]);

  const focusRow = (index: number) => {
    const count = choices.length;
    const next = ((index % count) + count) % count;
    (rows.current[next] as unknown as Focusable | null)?.focus?.();
  };

  // Web: open on the checked row, as a native select does.
  useEffect(() => {
    if (anchor === null || Platform.OS !== 'web') return;
    const start = Math.max(
      0,
      choices.findIndex((c) => c.asset === selected),
    );
    const frame = requestAnimationFrame(() => focusRow(start));
    return () => cancelAnimationFrame(frame);
    // Only on opening: re-focusing on every render would fight the arrows.
  }, [anchor]);

  if (anchor === null) return null;

  const width = Math.min(WIDTH, window.width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(anchor.x, window.width - width - EDGE));
  const top = anchor.y + anchor.height + 6;

  const keys =
    Platform.OS === 'web'
      ? {
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            const at = rows.current.findIndex(
              (row) => (row as unknown) === globalThis.document?.activeElement,
            );
            const moves: Record<string, number> = {
              ArrowDown: at + 1,
              ArrowUp: at - 1,
              Home: 0,
              End: choices.length - 1,
            };
            const target = moves[event.key];
            if (target === undefined) return;
            event.preventDefault();
            focusRow(target);
          },
        }
      : {};

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close"
        focusable={false}
      />
      <View
        role="menu"
        aria-label={`${label}, assets`}
        style={[styles.menu, { top, left, width }]}
        {...keys}
      >
        {choices.map(({ asset, amount }, index) => {
          const checked = asset === selected;
          const figure = amountFigure(amount, asset);
          return (
            <Pressable
              key={asset}
              ref={(node) => {
                rows.current[index] = node;
              }}
              {...ITEM_ROLE}
              aria-checked={checked}
              accessibilityState={{ checked }}
              accessibilityLabel={`${asset}, ${hidden ? 'hidden' : figure}`}
              onPress={() => {
                onSelect(asset);
                onClose();
              }}
              style={({ pressed, hovered, focused }: StateWithFocus) => [
                styles.row,
                (hovered || focused) && styles.rowHover,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={[text.strong, styles.asset, checked && styles.assetOn]}>{asset}</Text>
              <Text style={[text.body, text.num, styles.amount]} numberOfLines={1}>
                {hidden ? maskDigits(figure) : figure}
              </Text>
              <View style={styles.mark}>
                {checked ? <Icon name="check" size={16} color={color.purpleHi} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

/** Pressable's state as react-native-web reports it: `hovered` and `focused` too. */
type StateWithFocus = { pressed: boolean; hovered?: boolean; focused?: boolean };

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    paddingVertical: 6,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.board,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  row: {
    minHeight: 44,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    // No browser ring: the row's hover tone already marks focus.
    ...((Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle),
  },
  rowHover: { backgroundColor: color.well },
  rowPressed: { opacity: 0.7 },
  asset: { width: 64, fontFamily: font.semibold, color: color.textDim },
  assetOn: { color: color.text },
  amount: { flex: 1, textAlign: 'right' },
  mark: { width: 16, alignItems: 'center' },
});
