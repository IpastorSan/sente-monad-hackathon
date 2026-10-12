/**
 * The words of the signed-out landing (SEN-196): Welcome on a wide web window,
 * for someone who arrives at sente.lol knowing nothing about it.
 *
 * Plain data, no React Native, so `landing.test.ts` runs under node and can
 * check every "how it works" link against the anchors `/how-it-works` really
 * has. Every claim is sourced from `howItWorks/content.ts` or the README; keep
 * it that way — a claim the How it works page cannot back does not go here.
 */
import { HOW_IT_WORKS_PATH } from '../howItWorks/content.ts';
import type { IconName } from '../ui/iconPaths.ts';

export const LANDING_HEADLINE = 'Hire an AI trader that can’t break your rules.';

export const LANDING_LEDE =
  'Agents trade for you on Monad. The limits you set are enforced by a signing enclave, however the agent is prompted.';

/** Where passkeys are measured to work (README "Try it", content.ts `providers`). */
export const BROWSER_NOTE =
  'Use Google Chrome and save the passkey to Google Password Manager. Other passkey providers are not measured yet.';

export type LandingPoint = {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  /** An anchor on `/how-it-works`. */
  readonly anchor: string;
  /** The link's words. */
  readonly more: string;
};

export const POINTS: readonly LandingPoint[] = [
  {
    icon: 'shield',
    title: 'Limits enforced at signing',
    body: 'Which contracts an agent may call, how much it may deposit per transaction and when its mandate expires are checked inside Privy’s enclave before it signs. Perpl order size and leverage are invisible there, so Sente checks those first.',
    anchor: 'limits',
    more: 'What the enclave checks',
  },
  {
    icon: 'trade',
    title: 'Real fills, on testnet',
    body: 'Agents trade spot on Kuru’s order book and perps on Perpl, from their own wallets on Monad testnet.',
    anchor: 'proven',
    more: 'What has been proven live',
  },
  {
    icon: 'key',
    title: 'No seed phrase',
    body: 'One passkey derives your keys. Gas for your wallet is sponsored, and each new wallet gets testnet starter funds.',
    anchor: 'no-seed-phrase',
    more: 'How one passkey gives you a wallet',
  },
];

export type LandingStep = {
  readonly title: string;
  readonly body: string;
  readonly anchor: string;
};

/** A real sequence: you cannot hire before you write the mandate, nor watch before you hire. */
export const STEPS: readonly LandingStep[] = [
  {
    title: 'Set a mandate',
    body: 'Pick the venues and markets, the size per transaction, the leverage on Perpl and an expiry. Sente compiles it into a policy on the agent’s wallet.',
    anchor: 'mandate',
  },
  {
    title: 'Hire and fund an agent',
    body: 'Start from a preset or write your own instructions. The agent gets its own wallet, funded as you hire it, and runs on demand or on a schedule.',
    anchor: 'runs',
  },
  {
    title: 'Watch it trade',
    body: 'Each run streams into a live terminal, every decision lands on its ledger, and its public page shows the mandate whose hash is anchored on chain.',
    anchor: 'verify-mandate',
  },
];

export const GITHUB_URL = 'https://github.com/IpastorSan/sente-monad-hackathon';
export const APK_URL = 'https://sente.lol/download/sente.apk';

/** `/how-it-works#<anchor>`. */
export function howItWorksHref(anchor: string): string {
  return `${HOW_IT_WORKS_PATH}#${anchor}`;
}

/**
 * The public page of the agent the landing shows off, from the build-time
 * `EXPO_PUBLIC_SHOWCASE_AGENT_ID`. `null` (and the section hidden) when it is
 * unset, blank, or not something that could be an agent id.
 */
export function showcaseAgentHref(raw: string | undefined | null): string | null {
  const id = raw?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return `/a/${id}`;
}
