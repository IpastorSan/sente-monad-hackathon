/**
 * "How the limits work": the explainer behind the mandate step (SEN-177).
 *
 * Every sentence here is a claim about enforcement, so each one is held to the
 * code that does the enforcing: `packages/mandate/src/policy.ts` for what the
 * enclave signs, `enforce.ts` for Sente's pre-check, and the module comment of
 * `packages/mandate/src/mandate.ts` for the honest limits of the first. The
 * preset values and the Kuru market list are read from code, not retyped.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Section, Sheet, Tag } from '@/ui/kit';
import { text } from '@/ui/theme';

import { KURU_MARKETS, type Enforcer } from './mandate';
import { describePreset, PRESET_PURPOSE, type PresetId } from './presets';

const PRESETS: readonly { id: PresetId; label: string }[] = [
  { id: 'cautious', label: 'Cautious' },
  { id: 'standard', label: 'Standard' },
  { id: 'wide', label: 'Wide' },
];

const LIMITS: readonly { title: string; by: Enforcer; detail: string }[] = [
  {
    title: 'Where it trades',
    by: 'enclave',
    detail:
      'Kuru is a spot order book; Perpl trades perps with leverage. A venue you leave off gets no signing rules at all.',
  },
  {
    title: 'Kuru markets',
    by: 'enclave',
    detail:
      'Each market you pick lets the agent place orders on that market’s contract, and on no other.',
  },
  {
    title: 'Kuru deposit caps',
    by: 'enclave',
    detail:
      'The most one deposit may move into Kuru, per token. A token left blank can’t be deposited.',
  },
  {
    title: 'Perpl collateral per transfer',
    by: 'enclave',
    detail: 'The most AUSD, Perpl’s collateral, one transfer may move into Perpl.',
  },
  {
    title: 'Perpl markets',
    by: 'sente',
    detail: 'Symbols such as BTC-PERP. Orders on any other market are refused.',
  },
  {
    title: 'Max leverage',
    by: 'sente',
    detail: 'The highest leverage a Perpl order may use.',
  },
  {
    title: 'Largest single order',
    by: 'sente',
    detail: 'The size of one order, in the market’s quote token: USDC on Kuru, AUSD on Perpl.',
  },
  {
    title: 'Mandate ends',
    by: 'enclave',
    detail:
      'After this time the enclave, by its own clock, stops signing deposits and Kuru orders, and Sente refuses every new order. The agent can still withdraw from Kuru and send funds back to your wallet.',
  },
  {
    title: 'Where funds can go',
    by: 'enclave',
    detail:
      'Not a setting. Apart from deposits into the venues, the agent can send tokens only to your own wallet, even after the mandate ends or you revoke it.',
  },
];

const BY: Record<Enforcer, string> = { enclave: 'Enclave', sente: 'Sente' };

export function MandateExplainer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const kuruMarkets = KURU_MARKETS.map((market) => market.symbol);
  return (
    <Sheet visible={visible} title="How the limits work" onClose={onClose}>
      <Text style={text.body}>
        A mandate is the set of limits you give one agent. Sente turns it into the signing policy of
        the agent’s own wallet, whose key lives in Privy’s secure enclave. The agent decides what to
        trade; the mandate decides what it is allowed to.
      </Text>

      <Section label="Who enforces what">
        <View style={styles.block}>
          <View style={styles.head}>
            <Text style={text.strong}>The enclave</Text>
            <Tag label={BY.enclave} filled />
          </View>
          <Text style={text.dim}>
            Checks every transaction the agent’s wallet signs. Its key can’t sign one that breaks
            these limits, whatever the agent is told. Each cap applies to one transaction: it bounds
            a single deposit, not the total over time.
          </Text>
        </View>
        <View style={styles.block}>
          <View style={styles.head}>
            <Text style={text.strong}>Sente</Text>
            <Tag label={BY.sente} />
          </View>
          <Text style={text.dim}>
            Checks each order before it goes out. Perpl orders are signed API calls rather than
            wallet transactions, and Kuru order sizes sit inside batched calldata the policy can’t
            read, so the enclave never sees them. On Perpl the enclave bounds the money that can
            reach the exchange, not what is done with it there.
          </Text>
        </View>
      </Section>

      <Section label="Presets">
        {PRESETS.map((preset) => (
          <View key={preset.id} style={styles.block}>
            <Text style={text.strong}>{preset.label}</Text>
            <Text style={text.dim}>{PRESET_PURPOSE[preset.id]}</Text>
            <Text style={[text.caption, text.num]}>{describePreset(preset.id).join(' · ')}</Text>
          </View>
        ))}
        <View style={styles.block}>
          <Text style={text.strong}>Custom</Text>
          <Text style={text.dim}>
            Change any field and the preset turns Custom: every value is what you set.
          </Text>
        </View>
      </Section>

      <Section label="Each limit">
        {LIMITS.map((limit) => (
          <View key={limit.title} style={styles.block}>
            <View style={styles.head}>
              <Text style={text.strong}>{limit.title}</Text>
              <Tag label={BY[limit.by]} filled={limit.by === 'enclave'} />
            </View>
            <Text style={text.dim}>{limit.detail}</Text>
          </View>
        ))}
      </Section>

      <Section label="Why only these markets">
        <Text style={text.dim}>
          The enclave can only allow a market it can name by contract address, so every Kuru market
          in a mandate is pinned to its order book’s address. Sente knows {kuruMarkets.length} Kuru
          markets on Monad testnet ({kuruMarkets.join(', ')}), with their contracts and settings
          checked on chain, and refuses a mandate naming any other.
        </Text>
        <Text style={[text.dim, styles.after]}>
          Perpl markets are typed rather than picked. Perpl orders are API calls, not wallet
          transactions, so the enclave can’t pin a Perpl market; Sente checks the list before each
          order instead.
        </Text>
      </Section>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { gap: 4, marginBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  after: { marginTop: 10 },
});
