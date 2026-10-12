/**
 * The spot order ticket's route (SEN-119). The ticket itself lives in
 * `trade/TicketScreen.tsx` because the market screen also embeds it beside
 * the chart on a wide web window (SEN-167), and a route file is no place to
 * import a component from. The tab title is set here, not in the ticket, so
 * the embedded copy leaves the market page's title alone (SEN-200).
 */
import { useLocalSearchParams } from 'expo-router';

import TicketScreen from '@/trade/TicketScreen';
import { PageTitle, symbolTitle } from '@/ui/PageTitle';

export default function TicketRoute() {
  const { symbol } = useLocalSearchParams<{ symbol?: string }>();
  return (
    <>
      <PageTitle title={symbolTitle(symbol)} />
      <TicketScreen />
    </>
  );
}
