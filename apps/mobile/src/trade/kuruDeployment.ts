/**
 * Which Kuru testnet deployment this build trades (SEN-189).
 *
 * Kuru runs two: Set D, the one it lists, whose test USDC only Kuru can mint,
 * and Set C, the previous one, still trading on chain with a public faucet.
 * `EXPO_PUBLIC_KURU_DEPLOYMENT` picks one at build time, and every Kuru check
 * the phone makes before signing — the books a leg may touch, the AccountCore,
 * the deposit and withdraw ABIs a policy may carry — is that deployment's
 * (`@sente/venues/kuru` reads the same variable). The API trades the one its
 * `KURU_DEPLOYMENT` names and says so in `GET /trade/capabilities`; when the
 * two differ, manual Kuru trading is off rather than refused at the signature,
 * like a Sente fee mismatch (SEN-184).
 *
 * Pure TS: `kuruDeployment.test.ts` runs under plain node.
 */
import { KURU_DEPLOYMENT, parseKuruDeploymentId, type KuruDeploymentId } from '@sente/venues/kuru';
import { isAddressEqual, type Address } from 'viem';

/** `EXPO_PUBLIC_KURU_DEPLOYMENT` as an id; `null` (fail closed) when it is not one. */
export function parseKuruDeploymentPin(raw: string | undefined): KuruDeploymentId | null {
  try {
    return parseKuruDeploymentId(raw);
  } catch {
    return null;
  }
}

/**
 * This build's pin, written out in full because Expo inlines only literal
 * `process.env.EXPO_PUBLIC_*` references. `@sente/venues/kuru` reads the same
 * variable; {@link kuruDeploymentAgrees} also checks the two came out equal.
 */
export const KURU_DEPLOYMENT_PIN: KuruDeploymentId | null = parseKuruDeploymentPin(
  process.env.EXPO_PUBLIC_KURU_DEPLOYMENT,
);

/** What `/trade/capabilities` says about Kuru (SEN-189); absent from an older API, which is Set D. */
export type ServerKuruDeployment = { readonly id: string; readonly accountCore: Address };

/**
 * Whether the API trades the Kuru deployment this build verifies against: the
 * same id and the same AccountCore, and the venues package resolved the same
 * deployment as the app's own pin.
 */
export function kuruDeploymentAgrees(
  server: ServerKuruDeployment | null | undefined,
  pin: KuruDeploymentId | null = KURU_DEPLOYMENT_PIN,
  active: {
    readonly id: KuruDeploymentId;
    readonly contracts: { readonly accountCore: Address };
  } = KURU_DEPLOYMENT,
): boolean {
  if (pin === null || active.id !== pin) return false;
  if (!server) return pin === 'set-d';
  return server.id === pin && isAddressEqual(server.accountCore, active.contracts.accountCore);
}

/**
 * The honest line for Markets and the ticket when this build trades Set C —
 * "Kuru testnet: Sente trades Kuru's previous testnet deployment while the new
 * one's test USDC is invite-only." — as a notice title and detail; `null` on
 * Set D.
 */
export function kuruDeploymentNote(
  id: KuruDeploymentId = KURU_DEPLOYMENT.id,
): { readonly title: string; readonly detail: string } | null {
  return id === 'set-c'
    ? {
        title: 'Kuru testnet',
        detail:
          "Sente trades Kuru's previous testnet deployment while the new one's test USDC is invite-only.",
      }
    : null;
}

/** This build's note, computed once. */
export const KURU_DEPLOYMENT_NOTE = kuruDeploymentNote();
