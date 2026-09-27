/**
 * Portfolio (SEN-109): the tab exists so the dock has its final shape; your
 * holdings and open positions, yours and your agents', land in U-12.
 */
import { StyleSheet, Text, View } from 'react-native';

import { ComingNext } from '@/ui/ComingNext';
import { Screen } from '@/ui/kit';
import { text } from '@/ui/theme';

export default function PortfolioScreen() {
  return (
    <Screen tabbed>
      <View style={styles.head}>
        <Text style={text.display}>Portfolio</Text>
      </View>
      <ComingNext
        icon="portfolio"
        title="Everything you hold, in one place"
        detail="Your wallet and every agent's, spot balances and open perps together."
        points={[
          'Total value, and what each agent holds',
          'Open positions with entry, target, stop and liquidation',
          'Close a position in one tap',
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { height: 48, justifyContent: 'flex-end', marginTop: 24 },
});
