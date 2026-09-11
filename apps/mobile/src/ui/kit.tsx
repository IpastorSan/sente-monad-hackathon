/**
 * The handful of primitives the agent screens are built from. Hairlines and
 * type do the structural work; nothing here draws a card.
 */
import type { ReactNode } from 'react';
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
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { groupThousands } from '@/agents/amounts';

import { color, font, GUTTER, RADIUS, text } from './theme';

export function Screen({
  children,
  footer,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  /** Pinned below the scroll area: the step's primary actions. */
  footer?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: footer ? 24 : insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing ?? false}
              onRefresh={onRefresh}
              tintColor={color.textDim}
              colors={[color.ground]}
              progressBackgroundColor={color.text}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>{footer}</View>
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
        <Pressable accessibilityRole="button" hitSlop={12} onPress={back.onPress}>
          <Text style={styles.back}>‹ {back.label}</Text>
        </Pressable>
      ) : (
        <View />
      )}
      {right}
    </View>
  );
}

/** A labelled block under a hairline. The rule, not a box, is the structure. */
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

type ButtonKind = 'primary' | 'secondary' | 'danger';

export function Button({
  label,
  onPress,
  kind = 'secondary',
  disabled = false,
  busy = false,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        BUTTON[kind],
        inactive && styles.inactive,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'primary' ? color.ground : color.text} />
      ) : (
        <Text style={[styles.buttonText, BUTTON_TEXT[kind]]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Buttons side by side, sharing the width. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

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
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  /** Shows a live `n / max` count, which turns red past the limit. */
  max?: number;
  error?: string | undefined;
  hint?: string;
  suffix?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
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
      <View style={[styles.inputRow, (error || over) && styles.inputRowError]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={color.textFaint}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={!numeric && autoCapitalize !== 'none'}
          cursorColor={color.text}
          selectionColor={color.textDim}
          textAlignVertical={multiline ? 'top' : 'center'}
          style={[styles.input, multiline && styles.inputMultiline, numeric && text.num]}
        />
        {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
      </View>
      {error ? <Text style={[text.dim, text.danger]}>{error}</Text> : null}
      {hint && !error ? <Text style={text.caption}>{hint}</Text> : null}
    </View>
  );
}

/** A checkbox or radio row. */
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
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.selectRow, pressed && styles.pressed]}
    >
      <View style={[mode === 'radio' ? styles.radio : styles.check, selected && styles.markOn]}>
        {selected ? <View style={mode === 'radio' ? styles.radioDot : styles.checkDot} /> : null}
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
        trackColor={{ false: color.rule, true: color.text }}
        thumbColor={value ? color.ground : color.textDim}
        ios_backgroundColor={color.rule}
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
      style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
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

export type NoticeTone = 'info' | 'ok' | 'error';

/** A message set off by a rule on its left edge: error in red, the rest neutral. */
export function Notice({
  tone = 'info',
  title,
  detail,
}: {
  tone?: NoticeTone;
  title: string;
  detail?: string | undefined;
}) {
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[
        styles.notice,
        tone === 'error' && { borderLeftColor: color.danger },
        tone === 'ok' && { borderLeftColor: color.text },
      ]}
    >
      <Text style={[text.strong, tone === 'error' && text.danger]}>{title}</Text>
      {detail ? (
        <Text style={text.dim} selectable>
          {detail}
        </Text>
      ) : null}
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
      <ActivityIndicator color={color.textDim} />
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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.sheetRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHead}>
            <Text style={[text.title, styles.grow]}>{title}</Text>
            <Pressable accessibilityRole="button" hitSlop={12} onPress={onClose}>
              <Text style={styles.back}>Close</Text>
            </Pressable>
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
  primary: { backgroundColor: color.text, borderColor: color.text },
  secondary: { borderColor: color.ruleStrong },
  danger: { borderColor: color.danger },
});

const BUTTON_TEXT = StyleSheet.create({
  primary: { color: color.ground },
  secondary: { color: color.text },
  danger: { color: color.danger },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ground },
  content: { paddingHorizontal: GUTTER, paddingTop: 8 },
  footer: {
    paddingHorizontal: GUTTER,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: color.rule,
    backgroundColor: color.ground,
  },
  topBar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  back: { fontFamily: font.medium, fontSize: 15, color: color.textDim },
  section: {
    marginTop: 28,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: color.rule,
    gap: 4,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  button: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontFamily: font.semibold, fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: 10 },
  inactive: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  field: { marginTop: 20, gap: 6 },
  fieldHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.ruleStrong,
  },
  inputRowError: { borderBottomColor: color.danger },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: color.text,
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  inputMultiline: { minHeight: 120, maxHeight: 260 },
  suffix: { fontFamily: font.medium, fontSize: 14, color: color.textDim, marginLeft: 8 },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  grow: { flex: 1 },
  check: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: color.ruleStrong,
    borderRadius: RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDot: { width: 10, height: 10, backgroundColor: color.ground },
  radio: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: color.ruleStrong,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.ground },
  markOn: { backgroundColor: color.text, borderColor: color.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: color.ruleStrong,
    borderRadius: RADIUS,
  },
  chipOn: { backgroundColor: color.text, borderColor: color.text },
  chipText: { fontFamily: font.medium, fontSize: 13, color: color.text },
  chipTextOn: { color: color.ground },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.rule,
  },
  rowLabel: { flexShrink: 0, maxWidth: '55%' },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  notice: {
    marginTop: 16,
    paddingLeft: 12,
    paddingVertical: 2,
    borderLeftWidth: 2,
    borderLeftColor: color.ruleStrong,
    gap: 4,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: color.text,
    borderRadius: RADIUS,
  },
  tagFilled: { backgroundColor: color.text },
  tagText: {
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.text,
  },
  tagTextFilled: { color: color.ground },
  loading: { paddingVertical: 40, alignItems: 'center' },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: color.raised,
    borderTopWidth: 1,
    borderTopColor: color.ruleStrong,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: GUTTER,
    paddingTop: 18,
    paddingBottom: 6,
  },
  sheetBody: { paddingHorizontal: GUTTER, paddingBottom: 8 },
});
