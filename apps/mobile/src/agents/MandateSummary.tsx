/**
 * The mandate read back as two ledgers: what the enclave will refuse to sign,
 * and what Sente checks before it sends. Used by the review step and by the
 * agent page, so the user sees the same words in both places.
 *
 * SEN-59: each ledger is a board of its own, headed by the enforcer's tag, so
 * the stronger claim (the enclave's) reads as a different kind of line from the
 * weaker one rather than as a longer list.
 */
import { StyleSheet, Text, View } from 'react-native';

import { EnforcerTag } from '@/ui/goban';
import { Card, Row } from '@/ui/kit';
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
    <View style={styles.root}>
      <Text style={text.dim}>Trades on {venues || 'no venue'}.</Text>
      {ORDER.map((enforcer) => {
        const rows = limits.filter((limit) => limit.enforcer === enforcer);
        if (rows.length === 0) return null;
        return (
          <Card key={enforcer} quiet={enforcer === 'sente'}>
            <View style={styles.head}>
              <EnforcerTag enforcer={enforcer} />
              <Text style={text.strong}>{ENFORCERS[enforcer].title}</Text>
            </View>
            <Text style={[text.caption, styles.detail]}>{ENFORCERS[enforcer].detail}</Text>
            {rows.map((limit) => (
              <Row key={limit.id} label={limit.label} value={limit.value} />
            ))}
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detail: { marginTop: 6, marginBottom: 4 },
});
