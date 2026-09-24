/**
 * What every device-key approval has in common.
 *
 * Two flows sign Privy requests with the phone's `device` key — a mandate change
 * (`agents/approval.ts`, SEN-44) and a transfer (`wallet/send.ts`, SEN-42) — and
 * both follow the same rule: `signPrivyAuthorization` signs the bytes it is
 * handed, so the phone must rebuild the request from the intent it is approving
 * and refuse anything else.
 *
 * The pieces below are the ones that must not differ between them. In
 * particular {@link NoDeviceKeyError} is ONE class: two classes of the same name
 * in one app would make `instanceof` silently flow-dependent, so the flow that
 * describes an error would not recognise the other flow's.
 *
 * Plain TS, no React Native: the specs of both flows run under plain node.
 */
import type { AuthorizationPayload } from './deviceKey.ts';

/** Privy's own API. The URL is part of the signed bytes, so it is pinned here. */
export const PRIVY_API_BASE = 'https://api.privy.io';

/**
 * Headers a payload may carry.
 *
 * The headers are signed too, and `privy.client.ts` sends exactly these — so
 * anything else in a payload is something this phone did not agree to.
 */
export const ALLOWED_HEADERS = ['privy-app-id', 'privy-idempotency-key'];

/** `ok` or a sentence a person can act on. Never "invalid". */
export type VerifyResult = { ok: true } | { ok: false; problem: string };

export const refuse = (problem: string): VerifyResult => ({ ok: false, problem });

/** Signs one Privy authorization payload with the device key, or `null` when signed out. */
export type Approver = (payload: AuthorizationPayload) => string;

/** No device key in this session — sign in again before approving anything. */
export class NoDeviceKeyError extends Error {
  constructor(action = 'approving anything') {
    super(`Sign in with your passkey before ${action}.`);
    this.name = 'NoDeviceKeyError';
  }
}
