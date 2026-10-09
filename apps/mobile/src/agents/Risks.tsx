/**
 * The risks of hiring an agent, acknowledged before it can act (SEN-177).
 *
 * Every line is a claim, held to what the code does:
 *
 * - Caps are per transaction: Privy compares each request on its own
 *   (`packages/mandate/src/mandate.ts`, "Deposit caps are per transaction"),
 *   and no cumulative loss limit is compiled.
 * - Order size, and Perpl's markets and leverage, are Sente's pre-check
 *   (`enforce.ts`): Perpl orders are signed API calls and Kuru order sizes sit
 *   in batched calldata, so the enclave never sees them.
 * - A revoke leaves only the way out (`compileRevocationRules`): no rule can
 *   cancel a Kuru order any more, so one resting on a book, or already sent,
 *   can still fill.
 * - Runs are billed to the owner's OpenRouter key (`agent-runner.service.ts`).
 * - Both venues are Monad testnet deployments (`MANDATE_CHAIN_ID` 10143).
 *
 * Shown on the hire review with a required tick, and once more before the
 * first run or schedule of an agent hired before the app asked.
 */
import { useRouter, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, SectionLink, SelectRow, Sheet } from '@/ui/kit';
import { color, text } from '@/ui/theme';

export const RISKS: readonly string[] = [
  'An AI agent can lose the money you give it. Trading inside its mandate is still trading.',
  'The mandate limits what it may do, not whether it profits.',
  'The enclave enforces caps per transaction, not a limit on total losses.',
  'Order sizes, and Perpl’s markets and leverage, are checked by Sente before each order, not by the enclave.',
  'Revoking stops new orders, but an order already sent or resting on a book can still fill.',
  'The model can misread a market or act on stale or wrong data.',
  'Every run spends your OpenRouter credits, whether or not it trades.',
  'Testnet only: these tokens have no monetary value.',
];

export const RISK_ACK = 'I understand the agent can lose the funds I give it';

/** SEN-181's in-app guide; its limits section is the long version. */
const GUIDE = '/how-it-works#limits' as Href;

function Bullets() {
  const router = useRouter();
  return (
    <View style={styles.list}>
      {RISKS.map((risk) => (
        <View key={risk} style={styles.item}>
          <Text style={[text.dim, styles.dot]}>•</Text>
          <Text style={[text.dim, styles.grow]}>{risk}</Text>
        </View>
      ))}
      <SectionLink label="How limits work" onPress={() => router.push(GUIDE)} />
    </View>
  );
}

/** The hire review's card, with the tick that gates the Hire button. */
export function RiskCard({ accepted, onToggle }: { accepted: boolean; onToggle: () => void }) {
  return (
    <Card>
      <Text style={text.title}>Risks</Text>
      <Bullets />
      <SelectRow title={RISK_ACK} selected={accepted} onPress={onToggle} />
    </Card>
  );
}

/** The same bullets once, before an older agent's first run or schedule. */
export function RiskConfirm({
  visible,
  agentName,
  busy,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  agentName: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title={`Before ${agentName} acts`} onClose={onClose}>
      <Bullets />
      <Text style={[text.body, styles.ack]}>{RISK_ACK}.</Text>
      <Button
        label="I understand, continue"
        kind="primary"
        busy={busy}
        onPress={onConfirm}
        style={styles.confirm}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8, marginTop: 10, marginBottom: 4 },
  item: { flexDirection: 'row', gap: 8 },
  dot: { color: color.textFaint },
  grow: { flex: 1 },
  ack: { marginTop: 14 },
  confirm: { marginTop: 12 },
});
