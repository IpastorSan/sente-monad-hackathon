/**
 * Markets (SEN-109): the tab exists so the dock has its final shape; the list
 * of Kuru spot and Perpl perp markets, with search, lands in U-5.
 */
import { StyleSheet, Text, View } from 'react-native';

import { ComingNext } from '@/ui/ComingNext';
import { Screen } from '@/ui/kit';
import { text } from '@/ui/theme';

export default function MarketsScreen() {
  return (
    <Screen tabbed>
      <View style={styles.head}>
        <Text style={text.display}>Markets</Text>
      </View>
      <ComingNext
        icon="markets"
        title="Every market your agents can trade"
        detail="Spot on Kuru and perps on Perpl, priced live, in one list."
        points={[
          'Price, 24h change and a sparkline per market',
          'Search by symbol',
          'Open a market for its chart, and trade it yourself',
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { height: 48, justifyContent: 'flex-end', marginTop: 24 },
});
