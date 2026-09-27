import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader/400Regular_Italic';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { SessionProvider } from '@/session';
import { color } from '@/ui/theme';

export default function RootLayout() {
  // Per-weight imports: a package root would bundle every face it ships. These
  // seven are the whole type system (`ui/theme.ts` → `font`).
  const [fontsLoaded, fontError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    Newsreader_400Regular_Italic,
    GeistMono_400Regular,
  });

  return (
    <SessionProvider>
      <StatusBar style="light" />
      {fontsLoaded || fontError ? (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.ink } }}>
          {/* The dock's Trade button (SEN-109): a ticket over the tab you were on. */}
          <Stack.Screen name="trade" options={{ presentation: 'modal' }} />
        </Stack>
      ) : (
        <View style={{ flex: 1, backgroundColor: color.ink }} />
      )}
    </SessionProvider>
  );
}
