import type { Policy } from "./types";

/** Default policy from the plan. Caps are USDC base units (6 decimals). */
export const POLICY_DEFAULTS = {
  warn: 1.8,
  trigger: 1.5,
  target: 2.0,
  maxPerRescue: "25000000", // 25 USDC
  maxPerDay: "50000000", // 50 USDC
  cooldownSec: 120,
} as const satisfies Omit<Policy, "user" | "hlAddress" | "paused">;

/**
 * Allowed policy ranges. Also: trigger must be below warn, and target must be
 * above trigger. The vault's set_policy enforces the same ranges.
 */
export const POLICY_RANGES = {
  warn: { min: 1.3, max: 3.0 },
  trigger: { min: 1.2, max: 2.5 },
  target: { max: 4.0 },
  cooldownSec: { min: 30, max: 3600 },
} as const;

export const KEEPER_POLL_INTERVAL_SEC = 5;
export const MAX_QUOTE_SLIPPAGE_BPS = 100; // 1%
export const MAX_QUOTE_AGE_SEC = 60;
export const MAX_SNAPSHOT_AGE_SEC = 15;
export const WARN_RECORD_INTERVAL_SEC = 600; // at most one WARN per 10 minutes

/** Every reason the policy engine can block a rescue for. */
export const REASON_CODES = [
  "RECIPIENT_MISMATCH",
  "WRONG_DEST_ASSET",
  "PAUSED",
  "OVER_PER_RESCUE",
  "OVER_DAILY",
  "COOLDOWN",
  "NOT_BELOW_TRIGGER",
  "SNAPSHOT_STALE",
  "QUOTE_STALE",
  "SLIPPAGE",
  "INSUFFICIENT_RESERVE",
  "UNKNOWN_TOKEN",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * From the live 1Click list, GET https://1click.chaindefuser.com/v0/tokens, on
 * 2026-11-06. Hypercore also lists a USDC at 1cs_v1:hypercore:erc20:…; that one
 * lands on HyperEVM, not in the perps balance, so it cannot rescue a position.
 */
export const ASSETS = {
  NEAR_USDC: {
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
  },
  NEAR_WNEAR: {
    assetId: "nep141:wrap.near",
    contractId: "wrap.near",
    decimals: 24,
  },
  HYPERLIQUID_USDC: {
    assetId: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
    decimals: 8,
  },
} as const;
