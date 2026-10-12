/**
 * The browser tab's title on web, as "<title> · Sente". `Head` renders nothing
 * on Android. The deepest mounted one wins, so a screen pushed over the tabs
 * names itself instead of keeping the tab's title (SEN-198).
 */
import Head from 'expo-router/head';

export function PageTitle({ title }: { title: string }) {
  return (
    <Head>
      <title>{`${title} · Sente`}</title>
    </Head>
  );
}

/** A market symbol from a route param, readable in a tab title ("BTC-PERP"). */
export function symbolTitle(symbol: string | undefined): string {
  if (!symbol) return 'Market';
  try {
    return decodeURIComponent(symbol);
  } catch {
    return symbol;
  }
}
