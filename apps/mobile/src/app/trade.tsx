/**
 * Trade (SEN-109): what the dock's round button opens, as a modal over
 * whichever tab you were on (`presentation: 'modal'` in `app/_layout.tsx`).
 * The order ticket — spot on Kuru first, then perps on Perpl — replaces this
 * in U-13.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { ComingNext } from '@/ui/ComingNext';
import { IconButton, Screen, TopBar } from '@/ui/kit';
import { text } from '@/ui/theme';

export default function TradeScreen() {
  const router = useRouter();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <Screen>
      <TopBar right={<IconButton icon="close" label="Close" onPress={close} />} />
      <Text style={[text.display, styles.title]}>Trade</Text>
      <ComingNext
        icon="trade"
        title="Place a trade yourself"
        detail="Your own orders from your own wallet, alongside your agents'."
        points={[
          'Buy and sell spot on Kuru',
          'Go long or short on Perpl perps, with leverage',
          'Set take-profit and stop on the ticket',
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
});
