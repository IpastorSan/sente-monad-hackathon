export { clearCredential, loadCredential, saveCredential } from './credentialStore';
export {
  deriveDeviceKey,
  deriveEvmKey,
  evmDerivationPath,
  PRF_NAMESPACES,
  PRF_OUTPUT_BYTES,
  prfSaltFor,
  zeroize,
  type PrfNamespace,
} from './derive';
// Only the type. The device key's public form and its signatures are reached
// through a live `WalletSession`, never by handing raw key bytes around, and a
// second `canonicalize` on the app's public surface would compete with
// `@sente/mandate`'s with nothing steering a caller to the right one.
export type { AuthorizationPayload } from './deviceKey';
export {
  createWallet,
  describeAuthError,
  RP_ID,
  RP_NAME,
  signIn,
  withWalletSession,
  type AuthErrorDescription,
  type CreateWalletOptions,
  type SignInOptions,
  type StoredCredential,
  type WalletSession,
} from './mera';
export { useAccount, type AccountStatus, type UseAccount } from './useAccount';
