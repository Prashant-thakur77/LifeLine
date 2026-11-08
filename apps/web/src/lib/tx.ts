import { outcomeFailure, outcomeHash, outcomeSettled, outcomeValue, type Outcome } from "./near-rpc";

/** Wallet popups throw when the user closes them; that isn't an error worth showing. */
export function isUserCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reject|cancel|closed|denied|user abort/i.test(message);
}

/** A thrown wallet error as one sentence, or null when the user simply backed out. */
export function describeTxError(error: unknown): string | null {
  if (isUserCancel(error)) return null;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const panic = /Smart contract panicked: ([^"\n]+)/.exec(message)?.[1];
  if (panic) return panic;
  return message ? `The wallet reported: ${message}` : "The wallet couldn't send the transaction.";
}

export type TxResult = { hash: string | null; failure: string | null };

/** An outcome that doesn't say how it ended is never reported as a success. */
export function txResult(outcome: Outcome | null | undefined): TxResult {
  const failure = outcomeFailure(outcome) ?? (outcomeSettled(outcome) ? null : "The wallet didn't say how the transaction ended. Check NearBlocks before trying again.");
  return { hash: outcomeHash(outcome), failure };
}

/**
 * ft_transfer_call returns how much the receiver kept. The vault keeps everything or
 * panics, and a panic means the token contract refunds it all, so "0" means the deposit
 * bounced straight back. That outcome still reads as a success to the wallet.
 */
export function depositBounced(outcome: Outcome | null | undefined): boolean {
  return outcomeValue(outcome) === "0";
}

/**
 * withdraw resolves to on_withdraw_transfer's answer: false means the token transfer
 * failed and the vault put the amount back in the reserve. The wallet still calls that a
 * success, so it has to be read from the value.
 */
export function withdrawRefunded(outcome: Outcome | null | undefined): boolean {
  return outcomeValue(outcome) === false;
}
