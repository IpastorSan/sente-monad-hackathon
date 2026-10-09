import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SessionProvider } from '@/session';
import { useWide } from '@/ui/kit';
import { color, RADIUS } from '@/ui/theme';

export default function RootLayout() {
  // Per-weight imports: a package root would bundle every face it ships. These
  // six are the whole type system (`ui/theme.ts` → `font`).
  const [fontsLoaded, fontError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    GeistMono_400Regular,
  });
  const wide = useWide();

  return (
    <SessionProvider>
      <StatusBar style="light" />
      {fontsLoaded || fontError ? (
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.ink } }}
          screenLayout={wide ? desktopSheetLayout : undefined}
        >
          {/* The dock's Trade button (SEN-109): a ticket over the tab you were on. */}
          <Stack.Screen name="trade" options={wide ? DESKTOP_MODAL : { presentation: 'modal' }} />
          {/* A ticket (SEN-167): on a wide window a sheet too, over the picker or the page. */}
          <Stack.Screen name="trade/[venue]/[symbol]" options={wide ? DESKTOP_MODAL : {}} />
          {/* Perps setup (SEN-120): the same sheet, over the ticket that opened it. */}
          <Stack.Screen name="trade/perpl-setup" options={wide ? DESKTOP_MODAL : {}} />
        </Stack>
      ) : (
        <View style={{ flex: 1, backgroundColor: color.ink }} />
      )}
    </SessionProvider>
  );
}

/**
 * A modal on a wide web window (SEN-166): a centred sheet over the dimmed page
 * it came from, instead of a page that fills the viewport. expo-router 57's
 * web stack (its fork of native-stack) keeps the screen below visible only
 * under a `transparentModal`; `contentStyle` makes the modal's own ground
 * transparent, and the Stack's `screenLayout` draws the sheet around it.
 * (`EXPO_UNSTABLE_WEB_MODAL` would swap in expo-router's own drawer modal,
 * but it is a build-time flag marked unstable.) Narrow and native keep
 * `presentation: 'modal'`.
 */
const DESKTOP_MODAL = {
  presentation: 'transparentModal',
  contentStyle: { backgroundColor: 'transparent' },
} as const;

/** The sheet's width; the trade picker is a list, not a dashboard. */
const SHEET_MAX = 520;

function desktopSheetLayout({
  options,
  navigation,
  children,
}: {
  options: { presentation?: string };
  navigation: { goBack: () => void; isFocused: () => boolean };
  children: ReactNode;
}) {
  if (options.presentation !== DESKTOP_MODAL.presentation) return <>{children}</>;
  return <DesktopSheet navigation={navigation}>{children}</DesktopSheet>;
}

function DesktopSheet({
  navigation,
  children,
}: {
  navigation: { goBack: () => void; isFocused: () => boolean };
  children: ReactNode;
}) {
  const onClose = () => navigation.goBack();
  useEffect(() => {
    // The sheet stays mounted under a screen pushed from it (a market's
    // ticket), and going back from here would pop that screen too.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && navigation.isFocused()) navigation.goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigation]);

  return (
    <View style={sheet.root}>
      <Pressable style={sheet.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={sheet.card} accessibilityViewIsModal>
        {children}
      </View>
    </View>
  );
}

const sheet = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim, cursor: 'auto' },
  card: {
    width: '100%',
    maxWidth: SHEET_MAX,
    height: '100%',
    maxHeight: 820,
    overflow: 'hidden',
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.ink,
    boxShadow: '0 40px 80px -24px rgba(0, 0, 0, 0.85)',
  },
});
