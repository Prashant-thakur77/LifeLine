import type { Quote } from "@lifeline/intents";
import { HL_ADDRESS, IMPLICIT_ACCOUNT, quoteProblems as checkQuote, type Route } from "./proof";

/**
 * Tidepool (https://www.usetidepool.tech) is a community-run sandbox with 1Click's API on
 * NEAR testnet, since 1Click itself has no testnet. It isn't official NEAR Intents
 * infrastructure. Its quotes are signed like 1Click's, with its own maker key.
 */
export const TIDEPOOL = {
  name: "Tidepool",
  apiUrl: "https://www.usetidepool.tech",
  quoteSigner: "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY",
  usdcContract: "usdc.tidepool-sandbox.testnet",
  originAsset: "nep141:usdc.tidepool-sandbox.testnet",
  /** USDC paid into a Hyperliquid testnet perps balance, 6 decimals. */
  destinationAsset: "nep141:hypercore.tp-omft.testnet",
  destinationUnit: 1e6,
  nearRpc: "https://test.rpc.fastnear.com",
  hlApi: "https://api.hyperliquid-testnet.xyz",
  nearExplorer: "https://testnet.nearblocks.io",
  hlExplorer: "https://app.hyperliquid-testnet.xyz/explorer",
} as const satisfies Route & { usdcContract: string };

/** 3 USDC (6 decimals): above Tidepool's 2 USDC minimum payout, under its 5 USDC cap. */
export const AMOUNT = "3000000";
const MAX_AMOUNT = 5_000_000n;
/** The signed quote must deliver at least this share of what's sent, in percent. */
const MIN_OUT_PERCENT = 97n;
/** Where a dry run's quote would refund to. Nothing is ever sent to its deposit address. */
export const DRY_REFUND_ACCOUNT = "lifeline-team.testnet";

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

/** The least a quote may promise: 97% of what's sent. Both sides are 6-decimal USDC. */
export const tidepoolMinOut = (amount: string) => ((BigInt(amount) * MIN_OUT_PERCENT) / 100n).toString();

/** The shared quote checks, with Tidepool's asset and minimum. */
export function quoteProblems(quote: Quote, expected: { recipient: string; refundTo: string; amount: string }): string[] {
  return checkQuote(quote, { ...expected, destinationAsset: TIDEPOOL.destinationAsset, minAmountOut: tidepoolMinOut(expected.amount) });
}

export type DepositAction = { method: string; args: Record<string, unknown>; depositYocto: bigint; gasTgas: number };

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
