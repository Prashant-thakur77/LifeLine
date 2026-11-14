import { verifyQuote, type Quote, type SwapStatus } from "@lifeline/intents";

/**
 * What the proof demos share: a 1Click-shaped API to quote with, the key its quotes must be
 * signed with, the two assets, and the chain endpoints. `demo:tidepool` runs it on testnet
 * through Tidepool; `demo:mainnet` on mainnet through 1Click itself.
 */
export type Route = {
  name: string;
  apiUrl: string;
  quoteSigner: string;
  originAsset: string;
  destinationAsset: string;
  /** Base units per whole destination token, for display: 1e6 for 6 decimals. */
  destinationUnit: number;
  nearRpc: string;
  hlApi: string;
  nearExplorer: string;
  hlExplorer: string;
};

/** A fresh NEAR implicit account, which is what a live quote's deposit address must be. */
export const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
export const HL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Everything wrong with a signed quote, all at once; empty means it's safe to pay. The
 * client already checked the signature and that the request came back unchanged; this
 * reads what the quote promises: who gets paid, in what, how much, and the refund.
 */
export function quoteProblems(
  quote: Quote,
  expected: { recipient: string; refundTo: string; amount: string; destinationAsset: string; minAmountOut: string },
): string[] {
  const wrong = verifyQuote(quote, expected);
  const problems: string[] = wrong.map((field) =>
    field === "recipient"
      ? `it pays ${quote.recipient}, not ${expected.recipient}`
      : field === "destinationAsset"
        ? `it delivers ${quote.destinationAsset}, not ${expected.destinationAsset}`
        : `it promises at least ${quote.minAmountOut}, under the ${expected.minAmountOut} required`,
  );
  if (quote.refundTo !== expected.refundTo) problems.push(`it refunds ${quote.refundTo}, not ${expected.refundTo}`);
  if (quote.amountIn !== expected.amount) problems.push(`it takes ${quote.amountIn}, not ${expected.amount}`);
  if (quote.depositAddress === null || !IMPLICIT_ACCOUNT.test(quote.depositAddress)) problems.push("it has no fresh NEAR deposit address");
  return problems;
}

export const FINAL_STATUSES: readonly SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

type Clock = { now?: () => number; sleep?: (ms: number) => Promise<void>; intervalMs?: number };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls the swap's status until it's final or the time runs out. A failed read is retried, not fatal. */
export async function waitForFinalStatus(
  getStatus: () => Promise<SwapStatus>,
  { now = Date.now, sleep = realSleep, intervalMs = 2000, timeoutMs, onStatus }: Clock & { timeoutMs: number; onStatus?: (status: SwapStatus, at: number) => void },
): Promise<{ status: SwapStatus | null; at: number; final: boolean }> {
  const giveUpAt = now() + timeoutMs;
  let last: SwapStatus | null = null;
  for (;;) {
    try {
      const status = await getStatus();
      const at = now();
      if (status !== last) onStatus?.(status, at);
      last = status;
      if (FINAL_STATUSES.includes(status)) return { status, at, final: true };
    } catch {
      // A public API drops the odd request: ask again next round.
    }
    if (now() >= giveUpAt) return { status: last, at: now(), final: false };
    await sleep(intervalMs);
  }
}

/** Re-reads a balance until it differs from `before`, or `giveUpAt()` passes. null means it never changed. */
export async function waitForBalanceChange(
  read: () => Promise<number>,
  before: number,
  { now = Date.now, sleep = realSleep, intervalMs = 2000, giveUpAt }: Clock & { giveUpAt: () => number },
): Promise<{ value: number; at: number } | null> {
  for (;;) {
    try {
      const value = await read();
      if (value !== before) return { value, at: now() };
    } catch {
      // As above: one failed read isn't an answer.
    }
    if (now() >= giveUpAt()) return null;
    await sleep(intervalMs);
  }
}

export const nearTxLink = (route: Pick<Route, "nearExplorer">, hash: string) => `${route.nearExplorer}/txns/${hash}`;
export const hlAccountLink = (route: Pick<Route, "hlExplorer">, address: string) => `${route.hlExplorer}/address/${address}`;
export const statusLink = (route: Pick<Route, "apiUrl">, depositAddress: string) => `${route.apiUrl}/v0/status?depositAddress=${depositAddress}`;

export type Summary = {
  quoteId: string;
  depositAddress: string;
  nearTxHash: string;
  status: SwapStatus | null;
  balanceBefore: number;
  balanceAfter: number | null;
  /** From the deposit transaction's confirmation. null if it never happened in time. */
  msToFinal: number | null;
  msToBalance: number | null;
};

const seconds = (ms: number | null) => (ms === null ? "not seen" : `${(ms / 1000).toFixed(1)} s`);
const usdc = (value: number | null) => (value === null ? "unchanged" : `${value} USDC`);

export function formatSummary(route: Pick<Route, "name" | "apiUrl" | "nearExplorer">, s: Summary): string {
  return [
    `Quote:              ${s.quoteId}`,
    `Deposit address:    ${s.depositAddress}`,
    `NEAR tx:            ${s.nearTxHash}`,
    `                    ${nearTxLink(route, s.nearTxHash)}`,
    `${`${route.name} status:`.padEnd(20)}${s.status ?? "unknown"} (${statusLink(route, s.depositAddress)})`,
    `Hyperliquid before: ${usdc(s.balanceBefore)}`,
    `Hyperliquid after:  ${usdc(s.balanceAfter)}`,
    `Deposit to ${s.status ?? "final"}: ${seconds(s.msToFinal)}`,
    `Deposit to balance on Hyperliquid: ${seconds(s.msToBalance)}`,
  ].join("\n");
}
