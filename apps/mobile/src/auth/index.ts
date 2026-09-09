export { clearCredential, loadCredential, saveCredential } from './credentialStore';
export {
  deriveEvmKey,
  evmDerivationPath,
  PRF_NAMESPACES,
  PRF_OUTPUT_BYTES,
  prfSaltFor,
  zeroize,
  type PrfNamespace,
} from './derive';
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
