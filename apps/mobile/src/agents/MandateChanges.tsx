/**
 * An amendment read as a change (SEN-59): the approval sheet's rows. The old
 * value is struck through in the faint ink, the new one sits beside it, and a
 * market or venue that joins is purple — so what the passkey is about to widen
 * is the thing the eye lands on. Computed by `diffMandates`; the labels are
 * `describeMandate`'s, the same words the review step and agent page use.
 */
import { StyleSheet, Text, View } from 'react-native';

import { EnforcerTag } from '@/ui/goban';
import { color, text } from '@/ui/theme';

import type { AgentMandate } from './api';
import { diffMandates, type MandateChange } from './mandateDiff';

export function MandateChanges({ before, after }: { before: AgentMandate; after: AgentMandate }) {
  const changes = diffMandates(before, after);
  if (changes.length === 0) {
    return (
      <Text style={[text.dim, styles.none]}>
        No limit changes. Approving re-signs the same limits.
      </Text>
    );
  }
  return (
    <View>
      {changes.map((change) => (
        <View key={change.id} style={styles.row}>
          <View style={styles.label}>
            <Text style={text.dim}>{change.label}</Text>
            <EnforcerTag enforcer={change.enforcer} />
          </View>
          <Text style={[text.body, text.num, styles.value]} selectable>
            <ChangeValue change={change} />
          </Text>
        </View>
      ))}
    </View>
  );
}

function ChangeValue({ change }: { change: MandateChange }) {
  if (change.kind === 'list') {
    // "MON-USDC + WETH-USDC": what stays, then what joins, then what leaves.
    const parts = [
      ...(change.kept.length > 0 ? [<Text key="kept">{change.kept.join(', ')}</Text>] : []),
      ...change.added.map((item) => (
        <Text key={`a${item}`} style={styles.added}>
          + {item}
        </Text>
      )),
      ...change.removed.map((item) => (
        <Text key={`r${item}`} style={styles.struck}>
          {item}
        </Text>
      )),
    ];
    return <>{parts.flatMap((part, i) => (i === 0 ? [part] : [' ', part]))}</>;
  }
  if (change.before === null) return <Text style={styles.added}>{change.after}</Text>;
  return (
    <>
      <Text style={styles.struck}>{change.before}</Text>
      {' → '}
      {change.after === null ? <Text style={styles.gone}>removed</Text> : change.after}
    </>
  );
}

/** Enclave rules before → after, and the policy they live in. */
export function RulesChange({
  before,
  after,
  policyId,
}: {
  before: number;
  after: number;
  policyId: string;
}) {
  return (
    <View style={[styles.row, styles.last]}>
      <View style={styles.between}>
        <Text style={text.dim}>Enclave rules</Text>
        <Text style={[text.body, text.num]}>
          {before === after ? String(after) : `${String(before)} → ${String(after)}`}
        </Text>
      </View>
      <Text style={text.mono} selectable>
        policy {policyId}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  none: { paddingVertical: 12 },
  row: {
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  last: { flexDirection: 'column', borderBottomWidth: 0 },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { flexShrink: 0, maxWidth: '50%', gap: 4, alignItems: 'flex-start' },
  value: { flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  struck: { color: color.textFaint, textDecorationLine: 'line-through' },
  added: { color: color.purpleHi },
  gone: { color: color.textDim },
});
