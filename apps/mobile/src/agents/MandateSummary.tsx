/**
 * The mandate read back as two ledgers: what the enclave will refuse to sign,
 * and what Sente checks before it sends. Used by the review step and by the
 * agent page, so the user sees the same words in both places.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Row, Tag } from '@/ui/kit';
import { text } from '@/ui/theme';

import type { AgentMandate } from './api';
import { describeMandate, ENFORCERS, type Enforcer } from './mandate';

const ORDER: readonly Enforcer[] = ['enclave', 'sente'];

export function MandateSummary({ mandate }: { mandate: AgentMandate }) {
  const limits = describeMandate(mandate);
  const venues = mandate.venues
    .map((venue) => (venue === 'kuru' ? 'Kuru (spot)' : 'Perpl (perps)'))
    .join(' and ');

  return (
    <View>
      <Text style={text.dim}>Trades on {venues || 'no venue'}.</Text>
      {ORDER.map((enforcer) => {
        const rows = limits.filter((limit) => limit.enforcer === enforcer);
        if (rows.length === 0) return null;
        return (
          <View key={enforcer} style={styles.group}>
            <View style={styles.head}>
              <Tag label={enforcer} filled={enforcer === 'enclave'} />
              <Text style={text.strong}>{ENFORCERS[enforcer].title}</Text>
            </View>
            <Text style={[text.dim, styles.detail]}>{ENFORCERS[enforcer].detail}</Text>
            {rows.map((limit) => (
              <Row key={limit.id} label={limit.label} value={limit.value} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: 20 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detail: { marginTop: 6, marginBottom: 4 },
});
