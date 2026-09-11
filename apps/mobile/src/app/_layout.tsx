import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { SessionProvider } from '@/session';
import { color } from '@/ui/theme';

export default function RootLayout() {
  // Per-weight imports: the package root would bundle all eighteen faces.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  return (
    <SessionProvider>
      <StatusBar style="light" />
      {fontsLoaded || fontError ? (
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.ground } }}
        />
      ) : (
        <View style={{ flex: 1, backgroundColor: color.ground }} />
      )}
    </SessionProvider>
  );
}
