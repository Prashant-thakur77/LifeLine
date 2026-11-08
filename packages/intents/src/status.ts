import type { SwapStatus } from "./types";

/** After one of these, 1Click won't move the swap on by itself. */
export const FINAL_STATUSES: ReadonlySet<SwapStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

const MESSAGES: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit to arrive.",
  KNOWN_DEPOSIT_TX: "Your deposit was seen on its chain and is being confirmed.",
  PROCESSING: "Your deposit arrived and the swap is under way.",
  SUCCESS: "Done: the funds were delivered.",
  INCOMPLETE_DEPOSIT: "The deposit was less than the quote needs. Send the rest to the same address, or wait for the refund.",
  REFUNDED: "The swap couldn't complete, so the deposit went back to the refund address.",
  FAILED: "The swap failed. Check the deposit address on the NEAR Intents explorer.",
};

/** A sentence a person can act on, for every 1Click status. */
export function describeStatus(status: SwapStatus): string {
  return MESSAGES[status];
}

/**
 * Polls a deposit address until 1Click reports a final status or time runs out. A failed
 * poll is skipped, not treated as a failure: the swap is still going on at 1Click.
 */
export async function waitForFinal(
  depositAddress: string,
  options: {
    getStatus: (depositAddress: string) => Promise<SwapStatus>;
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onStatus?: (status: SwapStatus) => void;
  },
): Promise<{ status: SwapStatus | null; final: boolean }> {
  const { getStatus, timeoutMs = 10 * 60_000, intervalMs = 5_000, onStatus } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const giveUpAt = now() + timeoutMs;
  let last: SwapStatus | null = null;

  for (;;) {
    try {
      const status = await getStatus(depositAddress);
      if (status !== last) onStatus?.(status);
      last = status;
      if (FINAL_STATUSES.has(status)) return { status, final: true };
    } catch {
      // Keep the last status: one failed request says nothing about the swap.
    }
    if (now() + intervalMs > giveUpAt) return { status: last, final: false };
    await sleep(intervalMs);
  }
}
