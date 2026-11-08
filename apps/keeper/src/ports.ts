import type { HealthResult } from "@lifeline/hyperliquid";
import type { Policy } from "@lifeline/shared";

// The 1Click types live with the 1Click client in packages/intents.
export { QuoteRefusedError, SWAP_STATUSES } from "@lifeline/intents";
export type { Intents, Quote, QuoteParams, SwapStatus } from "@lifeline/intents";

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

/** A past rescue. `quoteId` is how the keeper tells whether a rescue landed. */
export type RescueRecord = { amount: string; at: string; quoteId?: string };

export type Vault = {
  getPolicy(user: string): Promise<Policy | null>;
  getReserve(user: string, token: string): Promise<string>;
  getRescues(user: string): Promise<RescueRecord[]>;
  rescue(args: RescueArgs): Promise<{ txHash: string }>;
  /** Everyone registered in the vault. Optional: a stand-in vault may not list anyone. */
  getUsers?(): Promise<string[]>;
};

export type ReadHealth = (hlAddress: string) => Promise<HealthResult>;
