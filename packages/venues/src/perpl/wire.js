/**
 * Perpl's wire format, as it actually arrives.
 *
 * Transcribed from `PerplFoundation/api-docs` (types.md / websocket.md) and
 * checked field-by-field against live testnet frames on 2026-09-10. Prices and
 * sizes are scaled INTEGERS — divide by `10^price_decimals` / `10^size_decimals`
 * from the market config — and collateral amounts are decimal strings in raw
 * token units (AUSD: 6 decimals). Nothing here is a float, and nothing outside
 * `perpl/` should ever see these shapes.
 */
/** `mt` values. Only the ones this client sends or reads. */
export const MT = {
  Ping: 1,
  StatusResponse: 3,
  SubscriptionRequest: 5,
  SubscriptionResponse: 6,
  L2BookSnapshot: 15,
  WalletSnapshot: 19,
  WalletUpdate: 20,
  AccountUpdate: 21,
  OrderRequest: 22,
  OrdersSnapshot: 23,
  OrdersUpdate: 24,
  FillsUpdate: 25,
  PositionsSnapshot: 26,
  PositionsUpdate: 27,
  ApiKeySignIn: 29,
  Heartbeat: 100,
};
export const ORDER_TYPE = {
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
};
export const ORDER_FLAGS = {
  GoodTillCancel: 0,
  PostOnly: 1,
  FillOrKill: 2,
  ImmediateOrCancel: 4,
};
export const ORDER_STATUS = {
  Pending: 1,
  Open: 2,
  PartiallyFilled: 3,
  Filled: 4,
  Canceled: 5,
  Expired: 6,
  Failed: 7,
  Untriggered: 8,
  Triggered: 9,
  Executed: 10,
};
export const POSITION_STATUS = { Open: 1 };
export const POSITION_SIDE = { Long: 1, Short: 2 };
/** The `sr` values worth naming in an error. The full table is in api-docs types.md. */
export const ORDER_STATUS_REASON = {
  1: 'AmountExceedsAvailableBalance',
  13: 'CrossesBook',
  14: 'ExceedsLastExecutionBlock',
  16: 'ImmediateOrCancelExecuted',
  32: 'OrderDescIdTooLow',
  34: 'OrderForwardingNotAllowed',
  36: 'OrderPostFailed',
  40: 'PriceOutOfRange',
  42: 'SizeOutOfRange',
  44: 'TakerOrderSettlementFailed',
};
/** `fr`, the reason behind a post/settlement failure. */
export const ORDER_FAILURE_REASON = {
  1: 'InsufficientBalance',
  2: 'InsufficientCollateralIncrease',
  3: 'InsufficientCollateralInvert',
  4: 'NoPositionToClose',
  5: 'PerpetualSolvency',
  6: 'NegativePositionValue',
  7: 'ReferencePriceStale',
  8: 'ExceedsMaxNegPnlCollat',
  9: 'Other',
};
