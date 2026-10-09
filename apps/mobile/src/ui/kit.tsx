/**
 * The plain primitives every screen is built from, in the Goban system
 * (SEN-55). Anything you press is a stone — a pill — and surfaces are softly
 * squared boards; there is no elevation, depth comes from the ground stepping
 * lighter (`ink` → `board` → `well`). The pieces with a meaning of their own —
 * stones, sigils, gauges, status pills — are in `goban.tsx`.
 */
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type KeyboardTypeOptions,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { groupThousands } from '@/agents/amounts';

import { Icon, type IconName } from './icons';
import { color, font, GUTTER, RADIUS, text } from './theme';

/**
 * The floating dock (SEN-109): a pill of tabs and the round Trade button that
 * hover over the tab screens instead of taking a strip of their own. Shared
 * here because `Screen tabbed` has to scroll its last row clear of it.
 */
export const DOCK = {
  /** The pill's height; the Trade button is centred on it. */
  height: 62,
  /** Gap between the dock and the bottom safe-area inset. */
  lift: 10,
} as const;

/**
 * The desktop shell (SEN-166): on web, a window at least `WIDE_MIN` wide gets
 * a left rail instead of the dock and a centred column instead of edge-to-edge
 * rows. Width, not platform alone: a narrowed browser window gets the phone
 * layout, and Android is never wide, so its tree is the one it always was.
 */
const WIDE_MIN = 1024;
/** The centred column a wide screen reads in. */
export const CONTENT_MAX = 720;
/** A centred dialog on a wide window, and the sign-in column: a form, not a page. */
export const SHEET_MAX = 480;
/**
 * The wider column for the screens laid out in two (SEN-167): a market beside
 * its ticket, and Home. The rest stay at `CONTENT_MAX`.
 */
export const WIDE_MAX = 1180;
/** The left rail's width on a wide screen. */
export const RAIL = 232;

export function useWide(): boolean {
  // Called unconditionally, so the hook order is the same on every platform.
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_MIN;
}

/**
 * Pressable's style callback state. react-native-web also reports `hovered`,
 * which React Native's types leave out; native never sets it, so a hover style
 * keyed on it costs Android nothing. (The pointer cursor is free: RNW gives
 * every enabled Pressable one.)
 */
type PressState = PressableStateCallbackType & { hovered?: boolean };

export function isHovered(state: PressableStateCallbackType): boolean {
  return (state as PressState).hovered === true;
}

export function Screen({
  children,
  footer,
  refreshing,
  onRefresh,
  tabbed = false,
  maxWidth = CONTENT_MAX,
}: {
  children: ReactNode;
  /** Pinned below the scroll area: the step's primary actions. */
  footer?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Inside the tab navigator: the floating dock covers the bottom inset. */
  tabbed?: boolean;
  /** The column's width on a wide screen; ignored on a narrow one. */
  maxWidth?: number;
}) {
  const insets = useSafeAreaInsets();
  const wide = useWide();
  // A wide screen has a rail, not a dock, so there is nothing to scroll clear of.
  const bottom =
    tabbed && !wide ? insets.bottom + DOCK.lift + DOCK.height + 24 : insets.bottom + 40;
  const column = wide ? { maxWidth, width: '100%' as const, alignSelf: 'center' as const } : null;
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: footer ? 24 : bottom }, column]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing ?? false}
              onRefresh={onRefresh}
              tintColor={color.purpleHi}
              colors={[color.purple]}
              progressBackgroundColor={color.board}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          {column ? <View style={[styles.footerColumn, column]}>{footer}</View> : footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

export function TopBar({
  back,
  right,
}: {
  back?: { label: string; onPress: () => void };
  right?: ReactNode;
}) {
  return (
    <View style={styles.topBar}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Back to ${back.label}`}
          hitSlop={12}
          onPress={back.onPress}
          style={styles.backRow}
        >
          <Icon name="back" size={18} color={color.textDim} />
          <Text style={styles.back}>{back.label}</Text>
        </Pressable>
      ) : (
        <View />
      )}
      {right}
    </View>
  );
}

/** A round, outlined icon button: overflow menus, close. */
export function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  /** Read by screen readers; there is no visible text. */
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={(state) => [
        styles.iconButton,
        isHovered(state) && styles.iconButtonHover,
        state.pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} size={18} color={color.textDim} />
    </Pressable>
  );
}

/** A labelled block. `aside` sits right of the label: a link or a count. */
export function Section({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={text.label}>{label}</Text>
        {aside}
      </View>
      {children}
    </View>
  );
}

/** The text link a Section puts in its `aside`. */
export function SectionLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" hitSlop={10} onPress={onPress}>
      <Text style={styles.sectionLink}>{label}</Text>
    </Pressable>
  );
}

/**
 * A board: the one surface. `goban` draws the faint board grid behind it — for
 * the single card per screen that earns it (the balance on Home).
 */
export function Card({
  children,
  goban = false,
  quiet = false,
  style,
}: {
  children: ReactNode;
  goban?: boolean;
  /** Outline only, for something that is over (a revoked agent). */
  quiet?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.card, quiet && styles.cardQuiet, style]}>
      {goban ? <GobanGrid /> : null}
      {children}
    </View>
  );
}

function GobanGrid() {
  return (
    <View style={styles.grid} pointerEvents="none">
      {Array.from({ length: 24 }, (_, i) => (
        <View
          key={`h${i}`}
          style={[styles.gridLine, { top: i * 22, left: 0, right: 0, height: 1 }]}
        />
      ))}
      {Array.from({ length: 24 }, (_, i) => (
        <View
          key={`v${i}`}
          style={[styles.gridLine, { left: i * 22, top: 0, bottom: 0, width: 1 }]}
        />
      ))}
      <View style={styles.glow} />
    </View>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'soft' | 'danger';

export function Button({
  label,
  onPress,
  kind = 'secondary',
  size = 'md',
  icon,
  disabled = false,
  busy = false,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  size?: 'md' | 'sm';
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || busy;
  const ink = BUTTON_INK[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      onPress={onPress}
      disabled={inactive}
      style={(state) => [
        styles.button,
        size === 'sm' && styles.buttonSm,
        BUTTON[kind],
        isHovered(state) && !inactive && BUTTON_HOVER[kind],
        inactive && styles.inactive,
        state.pressed && styles.buttonPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} color={ink} /> : null}
          <Text style={[styles.buttonText, size === 'sm' && styles.buttonTextSm, { color: ink }]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * Copy a value to the clipboard (SEN-177). Web only: the app ships no native
 * clipboard module, and adding one would invalidate every installed dev
 * client (CLAUDE.md, gotcha 5). On a phone the button is absent and the text
 * beside it stays `selectable`, so a long press still copies it.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const clipboard =
    Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard) return null;
  const copy = () => {
    clipboard.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  };
  return (
    <Button
      label={copied ? 'Copied' : label}
      kind="secondary"
      size="sm"
      icon={copied ? 'check' : 'copy'}
      onPress={copy}
    />
  );
}

/** Buttons side by side, sharing the width. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

/**
 * ONE FOCUS RING PER INPUT (SEN-177). On web the browser draws its own square
 * outline on the inner `<input>`, inset from our rounded box, so a focused
 * field showed two rings. The box is the indicator — a purple border and a
 * soft glow — and every TextInput sets {@link BARE_INPUT} so the browser's
 * outline goes. Removing it is only safe because the box takes over: a
 * TextInput that sets BARE_INPUT must put {@link FOCUS_RING} on its container
 * while focused.
 *
 * `outlineStyle: 'none'` is valid CSS that React Native's types don't list.
 */
export const BARE_INPUT = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as TextStyle;

export const FOCUS_RING: ViewStyle = {
  borderColor: color.purple,
  shadowColor: color.purple,
  shadowOpacity: 0.45,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 0 },
};

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  max,
  error,
  hint,
  suffix,
  keyboardType,
  autoCapitalize = 'sentences',
  onSubmitEditing,
  maxLength,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  /** Shows a live `n / max` count, which turns berry past the limit. */
  max?: number;
  error?: string | undefined;
  hint?: string;
  suffix?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  /** Return / Enter in a single-line field: the field's own "done". */
  onSubmitEditing?: () => void;
  /** A hard cap on input, past the `max` counter's soft one. */
  maxLength?: number;
  /** Focus on mount: a screen sending someone back to fix this field. */
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const over = max !== undefined && value.length > max;
  const numeric = keyboardType === 'decimal-pad' || keyboardType === 'number-pad';
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={text.label}>{label}</Text>
        {max !== undefined ? (
          <Text style={[text.caption, text.num, over && text.danger]}>
            {groupThousands(String(value.length))} / {groupThousands(String(max))}
          </Text>
        ) : null}
      </View>
      <View
        style={[styles.inputRow, focused && FOCUS_RING, (error || over) && styles.inputRowError]}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={color.textFaint}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={!numeric && autoCapitalize !== 'none'}
          onSubmitEditing={onSubmitEditing}
          returnKeyType={onSubmitEditing ? 'done' : undefined}
          maxLength={maxLength}
          autoFocus={autoFocus}
          cursorColor={color.purpleHi}
          selectionColor={color.purple}
          textAlignVertical={multiline ? 'top' : 'center'}
          style={[
            styles.input,
            BARE_INPUT,
            multiline && styles.inputMultiline,
            numeric && text.num,
          ]}
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
      </View>
      {error ? <Text style={[text.dim, text.danger]}>{error}</Text> : null}
      {hint && !error ? <Text style={text.caption}>{hint}</Text> : null}
    </View>
  );
}

/** A checkbox or radio row. */
/**
 * Space toggles a checkbox or radio on the web, as it does a native one;
 * react-native-web's Pressable only answers Enter for those roles.
 */
function spaceToggles(onPress: () => void): object {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key !== ' ') return;
      event.preventDefault();
      onPress();
    },
  };
}

export function SelectRow({
  title,
  detail,
  selected,
  onPress,
  mode = 'check',
}: {
  title: string;
  detail?: ReactNode;
  selected: boolean;
  onPress: () => void;
  mode?: 'check' | 'radio';
}) {
  return (
    <Pressable
      accessibilityRole={mode === 'radio' ? 'radio' : 'checkbox'}
      // `aria-checked` too: react-native-web drops `accessibilityState.checked`.
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      {...spaceToggles(onPress)}
      style={({ pressed }) => [styles.selectRow, pressed && styles.pressed]}
    >
      <View style={[mode === 'radio' ? styles.radio : styles.check, selected && styles.markOn]}>
        {selected ? (
          mode === 'radio' ? (
            <View style={styles.radioDot} />
          ) : (
            <Icon name="check" size={13} color={color.ink} strokeWidth={2.6} />
          )
        ) : null}
      </View>
      <View style={styles.grow}>
        <Text style={text.body}>{title}</Text>
        {typeof detail === 'string' ? <Text style={text.caption}>{detail}</Text> : detail}
      </View>
    </Pressable>
  );
}

export function ToggleRow({
  title,
  detail,
  value,
  onValueChange,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.selectRow}>
      <View style={styles.grow}>
        <Text style={text.body}>{title}</Text>
        {detail ? <Text style={text.caption}>{detail}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: color.lineStrong, true: color.purple }}
        thumbColor={value ? color.text : color.textDim}
        ios_backgroundColor={color.lineStrong}
      />
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={(state) => [
        styles.chip,
        selected ? styles.chipOn : isHovered(state) && styles.chipHover,
        state.pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

/** One choice out of a few, in a well: time windows, filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(option.value)}
            style={(state) => [
              styles.segment,
              on ? styles.segmentOn : isHovered(state) && styles.segmentHover,
            ]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Label left, value right, hairline below. Values are tabular unless they are chain facts. */
export function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={[text.dim, styles.rowLabel]}>{label}</Text>
      <Text style={[mono ? text.mono : [text.body, text.num], styles.rowValue]} selectable>
        {value}
      </Text>
    </View>
  );
}

/**
 * A {@link Row} that opens to show more under it (SEN-177): a long text
 * summarised by its length, read in full on demand. A button with
 * `expanded` state, so the web gets `aria-expanded` and Enter / Space.
 */
export function DisclosureRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={open ? styles.disclosureOpen : null}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={`${label}, ${value}`}
        accessibilityHint={open ? 'Hides the full text' : 'Shows the full text'}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.row, open && styles.rowOpen, pressed && styles.pressed]}
      >
        <Text style={[text.dim, styles.rowLabel]}>{label}</Text>
        <View style={styles.disclosureValue}>
          <Text style={[text.body, text.num, styles.rowValue]}>{value}</Text>
          <View style={open ? styles.chevronOpen : styles.chevronClosed}>
            <Icon name="chevron" size={16} color={color.textFaint} />
          </View>
        </View>
      </Pressable>
      {open ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  );
}

/**
 * A pressable list row with an icon, a title, a line saying what it does, and
 * a chevron: the Controls list on an agent, the Account screen.
 */
export function ActionRow({
  icon,
  title,
  detail,
  onPress,
  danger = false,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const tint = danger ? color.berry : color.textDim;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
    >
      <Icon name={icon} size={20} color={tint} />
      <View style={styles.grow}>
        <Text style={[text.strong, danger && text.danger]}>{title}</Text>
        {detail ? <Text style={text.caption}>{detail}</Text> : null}
      </View>
      <Icon name="chevron" size={16} color={color.textFaint} />
    </Pressable>
  );
}

export type NoticeTone = 'info' | 'ok' | 'error';

/** A message in a well, with a coloured edge: berry for an error, purple for ok. */
export function Notice({
  tone = 'info',
  title,
  detail,
  children,
}: {
  tone?: NoticeTone;
  title: string;
  detail?: string | undefined;
  /** An action under the text, e.g. a retry link. */
  children?: ReactNode;
}) {
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[
        styles.notice,
        tone === 'error' && { borderLeftColor: color.berry },
        tone === 'ok' && { borderLeftColor: color.purple },
      ]}
    >
      <Text style={[text.strong, tone === 'error' && text.danger]}>{title}</Text>
      {detail ? (
        <Text style={text.dim} selectable>
          {detail}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** A small uppercase tag. `filled` is the stronger of two claims. */
export function Tag({ label, filled = false }: { label: string; filled?: boolean }) {
  return (
    <View style={[styles.tag, filled && styles.tagFilled]}>
      <Text style={[styles.tagText, filled && styles.tagTextFilled]}>{label}</Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={color.purpleHi} />
    </View>
  );
}

/**
 * The in-app confirmation sheet. Destructive and money-moving actions confirm
 * here, never through `Alert`: the sheet can say exactly what will happen.
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // A wide web window gets a centred dialog: a full-width drawer sliding up a
  // desktop screen reads as a phone layout stretched, not as a sheet.
  const wide = useWide();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={wide ? 'fade' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={[styles.sheetRoot, wide && styles.sheetRootWide]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            styles.sheet,
            wide ? styles.sheetWide : null,
            { paddingBottom: wide ? 20 : insets.bottom + 16 },
          ]}
        >
          {wide ? null : <View style={styles.grip} />}
          <View style={styles.sheetHead}>
            <Text style={[text.title, styles.sheetTitle, styles.grow]}>{title}</Text>
            <IconButton icon="close" label="Close" onPress={onClose} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const BUTTON = StyleSheet.create({
  primary: {
    backgroundColor: color.purple,
    borderColor: color.purple,
    shadowColor: color.purple,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  secondary: { borderColor: color.lineStrong },
  soft: { backgroundColor: color.well, borderColor: color.well },
  danger: { borderColor: 'rgba(240, 80, 140, 0.45)' },
});

/** A step lighter on hover, in the ground's own tones: purple stays an event. */
const BUTTON_HOVER = StyleSheet.create({
  primary: { borderColor: color.purpleHi },
  secondary: { backgroundColor: color.well },
  soft: { backgroundColor: color.line, borderColor: color.line },
  danger: { backgroundColor: 'rgba(240, 80, 140, 0.08)' },
});

const BUTTON_INK: Record<ButtonKind, string> = {
  primary: '#FFFFFF',
  secondary: color.text,
  soft: color.text,
  danger: color.berry,
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: GUTTER, paddingTop: 8 },
  footer: {
    paddingHorizontal: GUTTER,
    paddingTop: 12,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: color.line,
    backgroundColor: color.ink,
  },
  footerColumn: { gap: 12 },
  topBar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -4 },
  back: { fontFamily: font.medium, fontSize: 15, color: color.textDim },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonHover: { backgroundColor: color.well, borderColor: color.lineStrong },
  section: { marginTop: 28, gap: 4 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionLink: { fontFamily: font.medium, fontSize: 13, color: color.purpleHi },
  card: {
    padding: 16,
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.board,
    overflow: 'hidden',
  },
  cardQuiet: { backgroundColor: 'transparent' },
  grid: { ...StyleSheet.absoluteFill },
  gridLine: { position: 'absolute', backgroundColor: 'rgba(221, 215, 254, 0.05)' },
  glow: {
    position: 'absolute',
    top: -120,
    right: -120,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(131, 110, 249, 0.14)',
  },
  button: {
    minHeight: 50,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderRadius: RADIUS.stone,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSm: { minHeight: 38, paddingHorizontal: 14 },
  buttonText: { fontFamily: font.semibold, fontSize: 15 },
  buttonTextSm: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 10 },
  inactive: { opacity: 0.35, shadowOpacity: 0, elevation: 0 },
  pressed: { opacity: 0.7 },
  buttonPressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  field: { marginTop: 20, gap: 8 },
  fieldHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.well,
    backgroundColor: color.well,
  },
  inputRowError: { borderColor: color.berry },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: color.text,
    paddingVertical: 13,
    paddingHorizontal: 0,
  },
  inputMultiline: { minHeight: 140, maxHeight: 280 },
  suffix: { fontFamily: font.medium, fontSize: 14, color: color.textFaint, marginLeft: 8 },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  grow: { flex: 1 },
  check: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radio: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.ink },
  markOn: { backgroundColor: color.purpleSoft, borderColor: color.purpleSoft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: RADIUS.stone,
  },
  chipHover: { backgroundColor: color.well },
  chipOn: { backgroundColor: color.purpleSoft, borderColor: color.purpleSoft },
  chipText: { fontFamily: font.medium, fontSize: 13, color: color.text },
  chipTextOn: { color: color.purpleDeep },
  segmented: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: RADIUS.stone,
    backgroundColor: color.well,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: RADIUS.stone,
    alignItems: 'center',
  },
  segmentOn: { backgroundColor: color.lineStrong },
  segmentHover: { backgroundColor: color.line },
  segmentText: { fontFamily: font.medium, fontSize: 13, color: color.textDim },
  segmentTextOn: { color: color.text },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  rowLabel: { flexShrink: 0, maxWidth: '55%' },
  rowOpen: { borderBottomWidth: 0 },
  disclosureOpen: { borderBottomWidth: 1, borderBottomColor: color.line },
  disclosureValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  chevronClosed: { transform: [{ rotate: '90deg' }] },
  chevronOpen: { transform: [{ rotate: '-90deg' }] },
  disclosureBody: { paddingBottom: 12, gap: 8 },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  notice: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    borderLeftWidth: 3,
    borderLeftColor: color.lineStrong,
    backgroundColor: color.well,
    gap: 4,
  },
  tag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: color.purpleSoft,
    borderRadius: RADIUS.stone,
  },
  tagFilled: { backgroundColor: color.purpleSoft },
  tagText: {
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.purpleSoft,
  },
  tagTextFilled: { color: color.purpleDeep },
  loading: { paddingVertical: 40, alignItems: 'center' },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim },
  sheet: {
    maxHeight: '88%',
    backgroundColor: color.board,
    borderTopWidth: 1,
    borderTopColor: color.lineStrong,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  sheetRootWide: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheetWide: {
    width: '100%',
    maxWidth: SHEET_MAX,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: 20,
    paddingTop: 8,
  },
  grip: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginTop: 10,
    backgroundColor: color.lineStrong,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: GUTTER,
    paddingTop: 14,
    paddingBottom: 6,
  },
  sheetTitle: { fontSize: 22, lineHeight: 28 },
  sheetBody: { paddingHorizontal: GUTTER, paddingBottom: 8 },
});
