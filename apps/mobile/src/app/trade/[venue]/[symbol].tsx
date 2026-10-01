/**
 * The spot order ticket's route (SEN-119). The ticket itself lives in
 * `trade/TicketScreen.tsx` because the market screen also embeds it beside
 * the chart on a wide web window (SEN-167), and a route file is no place to
 * import a component from.
 */
export { default } from '@/trade/TicketScreen';
