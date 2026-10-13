/**
 * What a return of an agent's funds (`POST /agents/:id/return`, SEN-17) did,
 * said plainly. Pure, so `returnOutcome.test.ts` pins it without a device.
 *
 * Each asset has up to two legs, each its own transaction with its own
 * `success`: the Kuru withdraw, then the wallet transfer. Either can land while
 * the other reverts (gotcha 8's corollary), so "sent" names only what arrived
 * and any reverted leg makes the outcome an error (SEN-203: a reverted withdraw
 * beside a landed transfer used to read as a clean "Sent").
 *
 * Where a landed withdraw paid out depends on the deployment: on Set D it pays
 * the owner directly; on Set C it pays the agent's own wallet, and the transfer
 * carries it home (`return-funds.service.ts`).
 */
import { KURU_DEPLOYMENT } from '@sente/venues/kuru';

import type { ReturnFundsResult } from './api.ts';
import { sumDecimals } from './ledgerView.ts';

export type ReturnNotice = {
  tone: 'ok' | 'info' | 'error';
  title: string;
  detail?: string;
};

export function describeReturn(
  result: ReturnFundsResult,
  withdrawPaysOwner: boolean = KURU_DEPLOYMENT.custody === 'account-id',
): ReturnNotice {
  const arrived: string[] = [];
  const failed: string[] = [];
  for (const asset of result.assets) {
    const amounts: string[] = [];
    if (asset.withdrawn?.success && withdrawPaysOwner) amounts.push(asset.withdrawn.amount);
    if (asset.returned?.success) amounts.push(asset.returned.amount);
    const total = amounts.length > 0 ? sumDecimals(amounts) : null;
    if (total !== null) arrived.push(`${total} ${asset.asset}`);

    if (asset.withdrawn && !asset.withdrawn.success) failed.push(`${asset.asset} (Kuru withdraw)`);
    if (asset.returned && !asset.returned.success) failed.push(asset.asset);
  }
  const summary = arrived.join(', ');

  if (failed.length > 0) {
    return {
      tone: 'error',
      title: 'Part of it didn’t go through',
      detail:
        `${failed.join(', ')} reverted on chain, so that part didn’t move` +
        `${summary ? `. ${summary} did` : ''}. Try again.`,
    };
  }
  if (arrived.length > 0) {
    return {
      tone: 'ok',
      title: `Sent ${summary} back to your wallet`,
      detail: `Gas cost the agent ${result.monSpent} MON. Balances update once the chain catches up.`,
    };
  }
  return {
    tone: 'info',
    title: 'There was nothing to send back',
    detail:
      'This agent holds no tokens. Its leftover MON stays with it: no rule lets an ' +
      'agent move native MON, so gas cannot be swept.',
  };
}
