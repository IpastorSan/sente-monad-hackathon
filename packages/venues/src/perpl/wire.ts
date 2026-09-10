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

export interface BlockTimestamp {
  b?: number;
  t?: number;
}

export interface BlockTxLogTimestamp extends BlockTimestamp {
  tx?: number;
  txid?: string;
  l?: number;
}

export interface PerplToken {
  id?: number;
  address?: string;
  symbol: string;
  name: string;
  decimals: number;
  display_precision: number;
}

export interface PerplInstance {
  id: number;
  address: string;
  collateral_token_id: number;
  /** Raw collateral units, decimal string. */
  min_account_open_amount: string;
  min_deposit_amount: string;
  min_withdraw_amount: string;
  max_account_equity?: string;
}

export interface PerplMarketConfig {
  is_open: boolean;
  price_decimals: number;
  size_decimals: number;
  min_posting_amount: string;
  min_settle_amount: string;
  /**
   * Maximum leverage in hundredths — `1500` is 15x. The docs call it a
   * "fraction"; it is the IMF in `IMR = N / IMF`, so it reads as leverage.
   */
  initial_margin: number;
  /** Maintenance margin factor in hundredths — `2500` is 25, i.e. MMR = N/25 = 4%. */
  maintenance_margin: number;
  /** Micros (10^-6). `690` = 0.069%. */
  maker_fee: number;
  taker_fee: number;
  maker_fees?: number[];
  taker_fees?: number[];
  recycle_fee: string;
}

export interface PerplMarketState {
  at: BlockTimestamp;
  orl: number;
  mrk: number;
  lst: number;
  mid: number;
  bid: number;
  ask: number;
}

export interface PerplMarket {
  id: number;
  instance_id: number;
  perpetual_id: number;
  symbol: string;
  name: string;
  size_units: string;
  order_ttl_blocks: number;
  order_max_market_slippage_bps: number;
  order_max_neg_pnl_collat_bps: number;
  config: PerplMarketConfig;
  state: PerplMarketState;
}

export interface PerplContext {
  chain: { chain_id: number; gas?: { h?: number } };
  instances: PerplInstance[];
  tokens: PerplToken[];
  markets: PerplMarket[];
}

export interface PerplCandle {
  t: number;
  o: number;
  c: number;
  h: number;
  l: number;
  /** Volume in raw COLLATERAL units. Perpl publishes no base-unit volume. */
  v: string;
  n: number;
}

export interface PerplCandleSeries {
  r: number;
  d: PerplCandle[];
}

export interface PerplL2Level {
  p: number;
  s: number;
  o: number;
}

export interface PerplL2Book {
  mt: number;
  sid: number;
  sn?: number;
  at: BlockTimestamp;
  bid: PerplL2Level[];
  ask: PerplL2Level[];
}

export interface PerplAccount {
  in: number;
  id: number;
  fr: boolean;
  /** Order forwarding. Orders fail with `sr: 34` while this is false. */
  fw: boolean;
  ft: number;
  /** Last forwarded request id. `rq` must be strictly greater. */
  lfr: number;
  b: string;
  lb: string;
}

export interface PerplWalletSnapshot {
  mt: number;
  sn?: number;
  addr: string;
  as?: PerplAccount[];
}

export interface PerplOrder {
  at: BlockTxLogTimestamp;
  c?: BlockTxLogTimestamp;
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  st: number;
  sr?: number;
  fr?: number;
  t: number;
  r?: boolean;
  p?: number;
  os: number;
  fp?: number;
  fs?: number;
  f?: string;
  fl: number;
  lv: number;
}

export interface PerplPosition {
  at: BlockTxLogTimestamp;
  mkt: number;
  acc: number;
  pid: number;
  st: number;
  sr?: number;
  /** 1 long, 2 short. */
  sd: number;
  /** Collateral deposited in the position, raw collateral units. */
  c: string;
  ep: number;
  s: number;
  fee?: string;
  lv: number;
  dpnl?: string;
  fnd?: string;
  xp?: number;
}

export interface PerplStatusResponse {
  mt: 3;
  sid?: number;
  cid?: number;
  status: { code: number; error?: string };
}

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
} as const;

export const ORDER_TYPE = {
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const;

export const ORDER_FLAGS = {
  GoodTillCancel: 0,
  PostOnly: 1,
  FillOrKill: 2,
  ImmediateOrCancel: 4,
} as const;

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
} as const;

export const POSITION_STATUS = { Open: 1 } as const;
export const POSITION_SIDE = { Long: 1, Short: 2 } as const;

/** The `sr` values worth naming in an error. The full table is in api-docs types.md. */
export const ORDER_STATUS_REASON: Readonly<Record<number, string>> = {
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
export const ORDER_FAILURE_REASON: Readonly<Record<number, string>> = {
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

export interface ApiKeyPayloadResponse {
  typed_data: PerplTypedData;
  mac: string;
}

/** EIP-712 typed data exactly as Perpl returns it: hex-string chainId and `time`. */
export interface PerplTypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: {
    name: string;
    version: string;
    chainId: string;
    verifyingContract: string;
    salt: string;
  };
  message: Record<string, string>;
}

export interface ApiKeyInfo {
  api_key: string;
  address: string;
  scope_mask: number;
  label: string;
  origin: string;
  expires_at: number;
  created_at: number;
}
