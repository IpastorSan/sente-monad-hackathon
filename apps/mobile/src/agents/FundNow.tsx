/**
 * Funding at hire (SEN-177): the optional "Fund it now" on the review step,
 * and its progress on the hired screen. The rules are `initialFunding.ts`'s.
 */
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { txUrl } from '@/chain/explorer';
import { Chip, Chips, Field, Notice, Section, SectionLink } from '@/ui/kit';
import { color, text } from '@/ui/theme';

import { formatAtoms } from './amounts';
import type { FundingCheck, FundingState } from './initialFunding';
import type { Token } from './mandate';

export function FundNow({
  tokens,
  token,
  setToken,
  amount,
  setAmount,
  balance,
  check,
}: {
  tokens: readonly Token[];
  token: Token;
  setToken: (token: Token) => void;
  amount: string;
  setAmount: (amount: string) => void;
  /** `null` while it is read, or when it couldn't be. */
  balance: bigint | null;
  check: FundingCheck;
}) {
  return (
    <Section label="Fund it now · optional">
      <Text style={text.dim}>
        Sent from your account right after the agent is hired. Leave it empty to fund it later.
      </Text>
      {tokens.length > 1 ? (
        <View style={styles.chips}>
          <Chips>
            {tokens.map((option) => (
              <Chip
                key={option.symbol}
                label={option.symbol}
                selected={option.symbol === token.symbol}
                onPress={() => setToken(option)}
              />
            ))}
          </Chips>
        </View>
      ) : null}
      <Field
        label="Amount"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        suffix={token.symbol}
        placeholder="0"
        error={check.kind === 'invalid' ? check.error : undefined}
        hint={`Your account holds ${balance === null ? '…' : formatAtoms(balance, token.decimals)} ${token.symbol}`}
      />
    </Section>
  );
}

/** The hired screen's line about the funding that followed the hire. */
export function FundingStatus({ state, onRetry }: { state: FundingState; onRetry: () => void }) {
  switch (state.kind) {
    case 'funding':
      return (
        <View style={styles.progress}>
          <ActivityIndicator color={color.purpleHi} />
          <Text style={text.body}>Funding {state.label}…</Text>
        </View>
      );
    case 'sent': {
      const url = state.transactionHash ? txUrl(state.transactionHash) : null;
      return (
        <Notice
          tone="ok"
          title={`Funded with ${state.label}`}
          detail="It landed in the agent’s wallet."
        >
          {url ? (
            <SectionLink label="View on the explorer" onPress={() => void Linking.openURL(url)} />
          ) : null}
        </Notice>
      );
    }
    case 'submitted':
      return (
        <Notice
          tone="info"
          title={`Sending ${state.label}`}
          detail={`Submitted, not confirmed yet (${state.status}). The agent’s balance updates once it lands.`}
        />
      );
    case 'failed':
      return (
        <Notice
          tone="error"
          title={`Hired, but funding ${state.label} failed`}
          detail={`${state.title}: ${state.detail}`}
        >
          <SectionLink label="Try funding again" onPress={onRetry} />
        </Notice>
      );
  }
}

const styles = StyleSheet.create({
  chips: { marginTop: 12 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
});
