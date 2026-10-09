/**
 * "How the limits work": the explainer behind the mandate step (SEN-177).
 *
 * Every sentence here is a claim about enforcement, so each one is held to the
 * code that does the enforcing: `packages/mandate/src/policy.ts` for what the
 * enclave signs, `enforce.ts` for Sente's pre-check, and the module comment of
 * `packages/mandate/src/mandate.ts` for the honest limits of the first. The
 * preset values and the Kuru market list are read from code, not retyped.
 *
 * Short on purpose: the long version is the in-app guide's mandate section
 * (`/how-it-works#mandate`, SEN-181), which "See more" opens.
 */
import { useRouter, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Section, SectionLink, Sheet, Tag } from '@/ui/kit';
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
    detail: `Each market you pick lets the agent place orders on that market’s contract, and on no other. The enclave can only allow a market it can name by contract address, so the choice is the ${KURU_MARKETS.length} Kuru testnet markets Sente has checked on chain.`,
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
    detail:
      'Symbols such as BTC-PERP. Typed rather than picked: Perpl orders are API calls the enclave never sees, so Sente refuses any other market itself.',
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

/** SEN-181's in-app guide; its mandate section carries the long version. */
const GUIDE = '/how-it-works#mandate' as Href;

export function MandateExplainer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const seeMore = () => {
    onClose();
    router.push(GUIDE);
  };
  return (
    <Sheet visible={visible} title="How the limits work" onClose={onClose}>
      <Text style={text.body}>
        A mandate is the set of limits you give one agent. Limits tagged Enclave are compiled into
        the signing policy of the agent’s wallet, whose key lives in Privy’s secure enclave: it
        can’t sign past them, whatever the agent is told. Limits tagged Sente are checked by Sente
        before each order, because those orders never reach the enclave. Caps apply per transaction,
        not to a total over time.
      </Text>

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

      <SectionLink label="See more" onPress={seeMore} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { gap: 4, marginBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});
