/**
 * Securing deposits (SEN-188): the hire step's progress line, and the agent
 * page's warning until the pinning amend has landed. The rules are
 * `depositPin.ts`'s.
 */
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Notice, SectionLink } from '@/ui/kit';
import { color, text } from '@/ui/theme';

import type { DepositPinState } from './depositPin';

const UNTIL =
  'Until they are, it can’t deposit to Kuru. Perpl, withdrawals and anything already in its Kuru account are unaffected.';

/** The hired screen's line about the pinning amend that followed the hire. */
export function DepositPinStatus({
  state,
  onRetry,
}: {
  state: DepositPinState;
  onRetry: () => void;
}) {
  switch (state.kind) {
    case 'securing':
      return (
        <View style={styles.progress}>
          <ActivityIndicator color={color.purpleHi} />
          <Text style={text.body}>Securing deposits…</Text>
        </View>
      );
    case 'secured':
      return (
        <Notice
          tone="ok"
          title="Deposits secured"
          detail="Its policy now lets it fund only its own Kuru account."
        />
      );
    case 'failed':
      return (
        <Notice
          tone="error"
          title="Hired, but its deposits aren’t secured yet"
          detail={`${state.title}: ${state.detail} ${UNTIL}`}
        >
          <SectionLink label="Secure deposits" onPress={onRetry} />
        </Notice>
      );
  }
}

/** The agent page's warning while `kuruDepositPinned` is false. */
export function DepositPinWarning({
  state,
  onSecure,
}: {
  /** The last attempt from this page, if any. */
  state: DepositPinState | null;
  onSecure: () => void;
}) {
  if (state?.kind === 'securing') {
    return (
      <View style={styles.progress}>
        <ActivityIndicator color={color.purpleHi} />
        <Text style={text.body}>Securing deposits…</Text>
      </View>
    );
  }
  const failed = state?.kind === 'failed' ? ` Last try: ${state.title}: ${state.detail}` : '';
  return (
    <Notice
      tone="error"
      title="Kuru deposits aren’t secured yet"
      detail={
        'Its policy doesn’t yet pin deposits to its own Kuru account, so a deposit could credit ' +
        `someone else’s. Approving one policy update fixes that. ${UNTIL}${failed}`
      }
    >
      <SectionLink label="Secure deposits" onPress={onSecure} />
    </Notice>
  );
}

const styles = StyleSheet.create({
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
});
