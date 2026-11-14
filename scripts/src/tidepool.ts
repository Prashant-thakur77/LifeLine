import { verifyQuote, type Quote, type SwapStatus } from "@lifeline/intents";

/**
 * Tidepool (https://www.usetidepool.tech) is a community-run sandbox with 1Click's API on
 * NEAR testnet, since 1Click itself has no testnet. It isn't official NEAR Intents
 * infrastructure. Its quotes are signed like 1Click's, with its own maker key.
 */
export const TIDEPOOL = {
  apiUrl: "https://www.usetidepool.tech",
  quoteSigner: "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY",
  usdcContract: "usdc.tidepool-sandbox.testnet",
  originAsset: "nep141:usdc.tidepool-sandbox.testnet",
  /** USDC paid into a Hyperliquid testnet perps balance, 6 decimals. */
  destinationAsset: "nep141:hypercore.tp-omft.testnet",
} as const;

export const NEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
export const HL_TESTNET_API = "https://api.hyperliquid-testnet.xyz";

/** 3 USDC (6 decimals): above Tidepool's 2 USDC minimum payout, under its 5 USDC cap. */
export const AMOUNT = "3000000";
const MAX_AMOUNT = 5_000_000n;
/** The signed quote must deliver at least this share of what's sent, in percent. */
const MIN_OUT_PERCENT = 97n;
/** Where a dry run's quote would refund to. Nothing is ever sent to its deposit address. */
export const DRY_REFUND_ACCOUNT = "lifeline-team.testnet";

const HL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A fresh NEAR implicit account, which is what a live quote's deposit address must be. */
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export type Settings = { dry: boolean; hlAddress: string; nearAccount: string; nearKey: string | null };

/**
 * `--dry [0xaddress]` needs only a Hyperliquid address. The real run also needs the NEAR
 * testnet account that pays and its key. Everything here is testnet: a mainnet account
 * is refused.
 */
export function readSettings(argv: string[], env: Record<string, string | undefined>): Settings {
  const dry = argv.includes("--dry");
  const rest = argv.filter((arg) => arg !== "--dry");
  const unknown = rest.filter((arg) => !HL_ADDRESS.test(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}. Usage: pnpm demo:tidepool [--dry] [0xHyperliquidTestnetAddress]`);

  const hlAddress = rest[0] ?? env.HL_TESTNET_ADDRESS?.trim() ?? "";
  if (!HL_ADDRESS.test(hlAddress)) throw new Error("set HL_TESTNET_ADDRESS in .env, or pass a 0x address");

  const account = env.NEAR_TESTNET_ACCOUNT?.trim() || null;
  const key = env.NEAR_TESTNET_PRIVATE_KEY?.trim() || null;
  if (!dry && (account === null || key === null)) throw new Error("the real run needs NEAR_TESTNET_ACCOUNT and NEAR_TESTNET_PRIVATE_KEY in .env; --dry needs neither");
  const nearAccount = account ?? DRY_REFUND_ACCOUNT;
  if (!nearAccount.endsWith(".testnet")) throw new Error(`${nearAccount} isn't a testnet account: this demo only runs on testnet`);
  if (!dry && !key!.startsWith("ed25519:")) throw new Error("NEAR_TESTNET_PRIVATE_KEY must start with ed25519:");
  return { dry, hlAddress, nearAccount, nearKey: dry ? null : key };
}

/**
 * Everything wrong with a signed quote, all at once; empty means it's safe to pay. The
 * client already checked the signature and that the request came back unchanged; this
 * reads what Tidepool promised: who gets paid, in what, how much, and the refund.
 */
export function quoteProblems(quote: Quote, expected: { recipient: string; refundTo: string; amount: string }): string[] {
  const minAmountOut = ((BigInt(expected.amount) * MIN_OUT_PERCENT) / 100n).toString();
  const wrong = verifyQuote(quote, { recipient: expected.recipient, destinationAsset: TIDEPOOL.destinationAsset, minAmountOut });
  const problems: string[] = wrong.map((field) =>
    field === "recipient"
      ? `it pays ${quote.recipient}, not ${expected.recipient}`
      : field === "destinationAsset"
        ? `it delivers ${quote.destinationAsset}, not ${TIDEPOOL.destinationAsset}`
        : `it promises at least ${quote.minAmountOut}, under ${MIN_OUT_PERCENT}% of ${expected.amount}`,
  );
  if (quote.refundTo !== expected.refundTo) problems.push(`it refunds ${quote.refundTo}, not ${expected.refundTo}`);
  if (quote.amountIn !== expected.amount) problems.push(`it takes ${quote.amountIn}, not ${expected.amount}`);
  if (quote.depositAddress === null || !IMPLICIT_ACCOUNT.test(quote.depositAddress)) problems.push("it has no fresh NEAR deposit address");
  return problems;
}

export type DepositAction = { method: "storage_deposit" | "ft_transfer"; args: Record<string, unknown>; depositYocto: bigint; gasTgas: number };

/**
 * The one transaction that pays a quote's deposit address, on the USDC contract. A fresh
 * deposit address isn't registered with USDC, so storage is paid first, in the same
 * transaction: either both actions happen or neither does.
 */
export function depositActions(depositAddress: string, amount: string, storageYocto: bigint | null): DepositAction[] {
  if (!IMPLICIT_ACCOUNT.test(depositAddress)) throw new Error(`${depositAddress} isn't a fresh deposit address`);
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > MAX_AMOUNT) throw new Error(`refusing to send ${amount}: more than 5 USDC, Tidepool's cap`);
  const transfer: DepositAction = { method: "ft_transfer", args: { receiver_id: depositAddress, amount }, depositYocto: 1n, gasTgas: 30 };
  if (storageYocto === null) return [transfer];
  return [{ method: "storage_deposit", args: { account_id: depositAddress, registration_only: true }, depositYocto: storageYocto, gasTgas: 30 }, transfer];
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

export const nearTxLink = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const hlAccountLink = (address: string) => `https://app.hyperliquid-testnet.xyz/explorer/address/${address}`;
export const statusLink = (depositAddress: string) => `${TIDEPOOL.apiUrl}/v0/status?depositAddress=${depositAddress}`;

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

export function formatSummary(s: Summary): string {
  return [
    `Quote:              ${s.quoteId}`,
    `Deposit address:    ${s.depositAddress}`,
    `NEAR testnet tx:    ${s.nearTxHash}`,
    `                    ${nearTxLink(s.nearTxHash)}`,
    `Tidepool status:    ${s.status ?? "unknown"} (${statusLink(s.depositAddress)})`,
    `Hyperliquid before: ${usdc(s.balanceBefore)}`,
    `Hyperliquid after:  ${usdc(s.balanceAfter)}`,
    `Deposit to ${s.status ?? "final"}: ${seconds(s.msToFinal)}`,
    `Deposit to balance on Hyperliquid: ${seconds(s.msToBalance)}`,
  ].join("\n");
}
