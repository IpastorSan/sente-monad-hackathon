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

/** One amount field: what is typed, what the account holds, and whether it fits. */
export type FundEntry = {
  token: Token;
  amount: string;
  setAmount: (amount: string) => void;
  /** `null` while it is read, or when it couldn't be. */
  balance: bigint | null;
  check: FundingCheck;
};

/**
 * The review step's optional funding. `spot` is the one amount every mandate
 * had (a token chip when there is a choice); `perps`, only when the mandate
 * trades on Perpl, is a second amount in AUSD, sent right after (SEN-198).
 */
export function FundNow({
  tokens,
  setToken,
  spot,
  perps,
  perpsNote,
}: {
  /** The spot tokens to choose from; the chosen one is `spot.token`. */
  tokens: readonly Token[];
  setToken: (token: Token) => void;
  spot: FundEntry | null;
  perps: FundEntry | null;
  /** The line under the AUSD amount. */
  perpsNote?: string;
}) {
  return (
    <Section label="Fund it now · optional">
      <Text style={text.dim}>
        {spot && perps
          ? 'Sent from your account right after the agent is hired, one transfer after the other. Leave an amount empty to fund it later.'
          : 'Sent from your account right after the agent is hired. Leave it empty to fund it later.'}
      </Text>
      {spot && tokens.length > 1 ? (
        <View style={styles.chips}>
          <Chips>
            {tokens.map((option) => (
              <Chip
                key={option.symbol}
                label={option.symbol}
                selected={option.symbol === spot.token.symbol}
                onPress={() => setToken(option)}
              />
            ))}
          </Chips>
        </View>
      ) : null}
      {spot ? <AmountField entry={spot} label={perps ? 'For spot' : 'Amount'} /> : null}
      {perps ? (
        <>
          <AmountField entry={perps} label={spot ? 'For perps' : 'Amount'} />
          {perpsNote ? <Text style={[text.dim, styles.note]}>{perpsNote}</Text> : null}
        </>
      ) : null}
    </Section>
  );
}

function AmountField({ entry, label }: { entry: FundEntry; label: string }) {
  const { token, balance, check } = entry;
  return (
    <Field
      label={label}
      value={entry.amount}
      onChangeText={entry.setAmount}
      keyboardType="decimal-pad"
      suffix={token.symbol}
      placeholder="0"
      error={check.kind === 'invalid' ? check.error : undefined}
      hint={`Your account holds ${balance === null ? '…' : formatAtoms(balance, token.decimals)} ${token.symbol}`}
    />
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
  note: { marginTop: 6 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
});
