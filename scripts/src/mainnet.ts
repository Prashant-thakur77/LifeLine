import { ONE_CLICK_QUOTE_SIGNER, type Quote } from "@lifeline/intents";
import { HL_ADDRESS, IMPLICIT_ACCOUNT, type Route } from "./proof";
import type { DepositAction } from "./tidepool";

/** Real 1Click on mainnet: wNEAR on NEAR to Hyperliquid perps USDC. Real money. */
export const MAINNET = {
  name: "1Click",
  apiUrl: "https://1click.chaindefuser.com",
  quoteSigner: ONE_CLICK_QUOTE_SIGNER,
  // Both read from 1Click's GET /v0/tokens on 2026-11-13: wNEAR has 24 decimals, and the
  // hip1 USDC (8 decimals) credits the perps balance. The erc20 USDC lands on HyperEVM instead.
  originAsset: "nep141:wrap.near",
  destinationAsset: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
  destinationUnit: 1e8,
  nearRpc: "https://free.rpc.fastnear.com",
  hlApi: "https://api.hyperliquid.xyz",
  nearExplorer: "https://nearblocks.io",
  hlExplorer: "https://app.hyperliquid.xyz/explorer",
  wnear: "wrap.near",
} as const satisfies Route & { wnear: string };

export const ONE_NEAR = 10n ** 24n;
/** The most this demo will ever send, wrapped or not. */
export const MAX_SEND = (15n * ONE_NEAR) / 10n;
/** NEAR left in the account after the run, for gas and storage. */
export const RESERVE = (15n * ONE_NEAR) / 100n;
/** Set aside for the transaction's gas when checking the reserve; a 4-call transaction costs far less. */
const GAS_ALLOWANCE = ONE_NEAR / 20n;
/** About 2.5 USDC out (8 decimals). Hyperliquid keeps about 1 USDC of a first transfer to a new address. */
export const TARGET_OUT = 250_000_000n;
/** The least the live quote may promise: 2.3 USDC, leaving room for the price to move between the two quotes. */
export const MIN_OUT = 230_000_000n;
const ROUND_TO = ONE_NEAR / 100n;

export type MainnetSettings = { dry: boolean; hlAddress: string; nearAccount: string; nearKey: string | null };

/**
 * `--dry` quotes and checks; `--send` spends. With neither it refuses, so a bare
 * `pnpm demo:mainnet` can never move money. The account is the NEAR implicit account in .env.
 */
export function readMainnetSettings(argv: string[], env: Record<string, string | undefined>): MainnetSettings {
  const dry = argv.includes("--dry");
  const send = argv.includes("--send");
  const unknown = argv.filter((arg) => arg !== "--dry" && arg !== "--send");
  if (unknown.length > 0 || dry === send) throw new Error("usage: pnpm demo:mainnet --dry (quote and check, sends nothing) or pnpm demo:mainnet --send (spends real NEAR, at most 1.5)");
  const hlAddress = env.HL_MAINNET_ADDRESS?.trim() ?? "";
  if (!HL_ADDRESS.test(hlAddress)) throw new Error("set HL_MAINNET_ADDRESS in .env to the Hyperliquid account to pay");
  const nearAccount = env.MAINNET_NEAR_ACCOUNT?.trim() ?? "";
  if (!IMPLICIT_ACCOUNT.test(nearAccount)) throw new Error("set MAINNET_NEAR_ACCOUNT in .env to the 64-hex implicit account");
  const key = env.MAINNET_NEAR_PRIVATE_KEY?.trim() || null;
  if (send && (key === null || !key.startsWith("ed25519:"))) throw new Error("--send needs MAINNET_NEAR_PRIVATE_KEY (ed25519:…) in .env");
  return { dry, hlAddress, nearAccount, nearKey: send ? key : null };
}

/**
 * How much wNEAR to quote for about `target` out, from a dry quote for a sample amount.
 * Out is linear in what's sent, less one flat fee, so `in = sample × (target + fee) / (sampleMin + fee)`,
 * rounded up to 0.01 NEAR. Refuses anything over MAX_SEND.
 */
export function sizeAmount(sample: Pick<Quote, "amountIn" | "minAmountOut" | "withdrawFee">, target: bigint = TARGET_OUT): string {
  const fee = BigInt(sample.withdrawFee);
  const perSample = BigInt(sample.minAmountOut) + fee;
  if (perSample <= 0n) throw new Error("the sample quote delivers nothing");
  const exact = (BigInt(sample.amountIn) * (target + fee) + perSample - 1n) / perSample;
  const rounded = ((exact + ROUND_TO - 1n) / ROUND_TO) * ROUND_TO;
  if (rounded > MAX_SEND) throw new Error(`about ${formatNear(rounded)} NEAR would be needed, over the 1.5 NEAR cap`);
  return rounded.toString();
}

/**
 * The one transaction on wrap.near that pays a quote's deposit address with wNEAR: register
 * this account if it isn't, wrap only what it doesn't hold yet, register the deposit address,
 * then transfer. All or nothing.
 */
export function wrapAndDepositActions(p: {
  account: string;
  depositAddress: string;
  amount: string;
  wnearBalance: string;
  accountRegistered: boolean;
  depositRegistered: boolean;
  storageYocto: bigint;
}): DepositAction[] {
  if (!IMPLICIT_ACCOUNT.test(p.depositAddress)) throw new Error(`${p.depositAddress} isn't a fresh deposit address`);
  if (!/^\d+$/.test(p.amount) || BigInt(p.amount) <= 0n) throw new Error(`refusing to send ${p.amount}`);
  if (BigInt(p.amount) > MAX_SEND) throw new Error(`refusing to send ${formatNear(BigInt(p.amount))} NEAR: the cap is 1.5`);
  const register = (accountId: string): DepositAction => ({ method: "storage_deposit", args: { account_id: accountId, registration_only: true }, depositYocto: p.storageYocto, gasTgas: 30 });
  const toWrap = BigInt(p.amount) - BigInt(p.wnearBalance);
  return [
    ...(p.accountRegistered ? [] : [register(p.account)]),
    ...(toWrap > 0n ? [{ method: "near_deposit", args: {}, depositYocto: toWrap, gasTgas: 30 }] : []),
    ...(p.depositRegistered ? [] : [register(p.depositAddress)]),
    { method: "ft_transfer", args: { receiver_id: p.depositAddress, amount: p.amount }, depositYocto: 1n, gasTgas: 30 },
  ];
}

/** Throws unless the account keeps at least RESERVE after these actions and their gas. */
export function checkReserve(balanceYocto: bigint, steps: DepositAction[]): bigint {
  const spend = steps.reduce((sum, s) => sum + s.depositYocto, 0n);
  const left = balanceYocto - spend - GAS_ALLOWANCE;
  if (left < RESERVE) throw new Error(`that would leave ${formatNear(left)} NEAR, under the ${formatNear(RESERVE)} NEAR kept for gas and storage`);
  return left;
}

export function formatNear(yocto: bigint): string {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const whole = abs / ONE_NEAR;
  const frac = ((abs % ONE_NEAR) / 10n ** 20n).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}
