/** A 1Click quote: every field is what 1Click answered, not what we asked for. */
export type Quote = {
  quoteId: string; // 1Click's correlationId: quotes have no quoteId field
  depositAddress: string | null; // null on a dry quote
  amountIn: string; // origin base units (USDC: 6 decimals)
  minAmountOut: string; // destination base units (8 decimals): the least 1Click guarantees
  withdrawFee: string; // destination base units (8 decimals)
  recipient: string;
  refundTo: string;
  destinationAsset: string;
  quotedAt: string; // ISO time
};

export type QuoteParams = {
  amount: string;
  recipient: string;
  refundTo: string;
  dry: boolean;
};

export const SWAP_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

export type Intents = {
  getQuote(params: QuoteParams): Promise<Quote>;
  getStatus(depositAddress: string): Promise<SwapStatus>;
  /** Optional hint that the deposit was sent. It only speeds 1Click up. */
  submitDeposit(params: { txHash: string; depositAddress: string }): Promise<void>;
};

/** 1Click answered, but no usable quote came of it. Its reason is safe to show publicly. */
export class QuoteRefusedError extends Error {
  override readonly name = "QuoteRefusedError";
}
