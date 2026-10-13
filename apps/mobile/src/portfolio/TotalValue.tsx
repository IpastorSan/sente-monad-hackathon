/**
 * A total as one dollar figure with its breakdown by coin under it (SEN-215):
 * `$560.12`, and a "By coin" toggle that opens, inline, one row per coin —
 * its logo, exact amount, the price it was counted at and the dollars that
 * came to — closed by the same total, so the figure visibly adds up. A coin
 * with no price is a row too, "no price — not counted".
 *
 * Inline rather than a floating menu: the rows are read, not picked, and an
 * expanding list sits the same on a phone and a desktop column. The eye masks
 * every amount and dollar figure; prices stay, since they are not wealth.
 *
 * The figures come from `valuation.ts`; this only lays out. Home, Portfolio
 * and the agent cockpit all draw their total with it.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { amountFigure } from '@/ui/assetAmounts';
import { Icon } from '@/ui/icons';
import { isHovered } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { BigNumber, TokenGlyph } from '@/ui/trading';
import { maskDigits } from '@/ui/tradingFormat';

import { dollars, priceLabel, type CoinValue, type Valuation } from './valuation';

export function TotalValue({
  value,
  label = 'Total value',
  size = 'xl',
  hidden,
  style,
}: {
  value: Valuation;
  /** What the figure is, for its accessible name. */
  label?: string;
  size?: 'md' | 'lg' | 'xl';
  hidden: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const mask = (figure: string) => (hidden ? maskDigits(figure) : figure);
  const coins = value.rows.length;
  return (
    <View style={style}>
      <View style={styles.head}>
        <BigNumber
          value={value.usd}
          prefix="$"
          size={size}
          blurred={hidden}
          style={styles.figure}
        />
        {coins > 0 ? (
          <Pressable
            onPress={() => setOpen((o) => !o)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`${open ? 'Hide' : 'Show'} ${label.toLowerCase()} breakdown by coin`}
            accessibilityState={{ expanded: open }}
            style={(state) => [
              styles.toggle,
              open && styles.toggleOn,
              isHovered(state) && styles.toggleHover,
              state.pressed && styles.pressed,
            ]}
          >
            <Text style={styles.toggleText}>{coins === 1 ? '1 coin' : `${coins} coins`}</Text>
            <View style={open ? styles.caretOpen : undefined}>
              <Icon name="caret" size={14} color={color.textDim} strokeWidth={2.2} />
            </View>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <View style={styles.list} accessibilityLabel={`${label}, by coin`}>
          {value.rows.map((row) => (
            <CoinRow key={row.asset} row={row} mask={mask} />
          ))}
          <View style={styles.sum}>
            <Text style={[text.dim, styles.grow]}>Total</Text>
            <Text style={[text.strong, text.num, styles.right]}>{mask(dollars(value.usd))}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function CoinRow({ row, mask }: { row: CoinValue; mask: (figure: string) => string }) {
  const price = priceLabel(row);
  const amount = `${mask(amountFigure(row.amount, row.asset))} ${row.asset}`;
  return (
    <View style={styles.row}>
      <TokenGlyph symbol={row.asset} size="sm" />
      <View style={styles.grow}>
        <Text style={text.strong} numberOfLines={1}>
          {row.asset}
        </Text>
        <Text style={[text.caption, text.num]} numberOfLines={1}>
          {price !== null ? `${amount} ${price}` : amount}
        </Text>
      </View>
      {row.usd !== null ? (
        <Text style={[text.strong, text.num, styles.right]}>{mask(dollars(row.usd))}</Text>
      ) : (
        <Text style={[text.caption, styles.right]}>no price — not counted</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 12 },
  figure: { flexShrink: 1 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 4,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
  },
  toggleOn: { borderColor: color.lineStrong, backgroundColor: color.well },
  toggleHover: { backgroundColor: color.well },
  toggleText: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textDim },
  caretOpen: { transform: [{ rotate: '180deg' }] },
  pressed: { opacity: 0.7 },
  list: {
    marginTop: 12,
    maxWidth: 520,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  sum: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  right: { textAlign: 'right' },
});
