import type { HealthResult } from "@lifeline/hyperliquid";
import type { Policy } from "@lifeline/shared";

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

export type RescueArgs = {
  user: string;
  token: string;
  amount: string;
  depositAddress: string;
  recipient: string;
  quoteId: string;
};

/** The chain says the vault refused. Any other error leaves the outcome unknown. */
export class VaultRejectedError extends Error {
  override readonly name = "VaultRejectedError";
}

export type Vault = {
  getPolicy(user: string): Promise<Policy | null>;
  getReserve(user: string, token: string): Promise<string>;
  getRescues(user: string): Promise<{ amount: string; at: string }[]>;
  rescue(args: RescueArgs): Promise<{ txHash: string }>;
};

export type ReadHealth = (hlAddress: string) => Promise<HealthResult>;
