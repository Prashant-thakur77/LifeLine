import {
  ASSETS,
  MAX_QUOTE_AGE_SEC,
  MAX_QUOTE_SLIPPAGE_BPS,
  MAX_SNAPSHOT_AGE_SEC,
  type HealthSnapshot,
  type Policy,
  type PolicyDecision,
  type RescueRequest,
} from "@lifeline/shared";

/** Reasons beyond the plan's 12 codes, for input that can't be trusted at all. */
export const GUARD_CODES = ["MALFORMED_INPUT", "USER_MISMATCH", "SNAPSHOT_MISMATCH"] as const;

/**
 * A rescue plus the two quote facts the shared RescueRequest doesn't carry.
 * `usdNeeded` is what this rescue means to deliver, after any cut to the caps or
 * the reserve, so a deliberately partial rescue isn't blocked as slippage.
 */
export type PolicyRequest = RescueRequest & {
  destinationAsset: string; // the quote's destinationAsset
  minAmountOutUsd: number; // the quote's minAmountOut in USD: the least 1Click guarantees
};

export type RescueHistory = {
  rescues: { amount: string; at: string }[]; // base units and ISO time, in any order
  reserve: string; // the user's balance of request.token in the vault, base units
};

const DAY_MS = 24 * 3600 * 1000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RESERVE_TOKENS: readonly string[] = [ASSETS.NEAR_USDC.contractId, ASSETS.NEAR_WNEAR.contractId];

const parseUnits = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : null);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const exceeds = (value: bigint | null, limit: bigint | null) =>
  value !== null && limit !== null && value > limit;

/** Written so an unreadable time counts as stale. Skew in either direction counts too. */
const isStale = (at: string, nowMs: number, limitSec: number) =>
  !(Math.abs(nowMs - Date.parse(at)) <= limitSec * 1000);

/**
 * Decides whether the keeper may run this rescue. A pure function: no network,
 * no clock, no state. Every rule is checked and every failure reported, and
 * anything unreadable blocks. The vault repeats the money-critical checks
 * (recipient, caps, cooldown, pause), so a compromised keeper meets them twice.
 */
export function evaluate(
  request: PolicyRequest,
  policy: Policy,
  history: RescueHistory,
  freshSnapshot: HealthSnapshot,
  now: Date,
): PolicyDecision {
  const nowMs = now.getTime();
  const amount = parseUnits(request.amount);
  const maxPerRescue = parseUnits(policy.maxPerRescue);
  const maxPerDay = parseUnits(policy.maxPerDay);
  const reserve = parseUnits(history.reserve);
  const rescues = history.rescues.map((r) => ({ amount: parseUnits(r.amount), at: Date.parse(r.at) }));

  const spentToday = rescues
    .filter((r) => nowMs - r.at < DAY_MS)
    .reduce((sum, r) => sum + (r.amount ?? 0n), 0n);
  const newestRescue = Math.max(...rescues.map((r) => r.at).filter(Number.isFinite));
  const minimumOut = request.usdNeeded * (1 - MAX_QUOTE_SLIPPAGE_BPS / 10_000);

  const rules: [code: string, broken: boolean][] = [
    [
      "MALFORMED_INPUT",
      amount === null ||
        amount === 0n ||
        maxPerRescue === null ||
        maxPerDay === null ||
        reserve === null ||
        rescues.some((r) => r.amount === null || Number.isNaN(r.at)) ||
        !(request.usdNeeded > 0) ||
        !(policy.cooldownSec >= 0) ||
        !EVM_ADDRESS.test(policy.hlAddress),
    ],
    ["USER_MISMATCH", request.user !== policy.user],
    ["SNAPSHOT_MISMATCH", !sameAddress(freshSnapshot.hlAddress, policy.hlAddress)],
    ["RECIPIENT_MISMATCH", !sameAddress(request.recipient, policy.hlAddress)],
    ["WRONG_DEST_ASSET", request.destinationAsset !== ASSETS.HYPERLIQUID_USDC.assetId],
    ["PAUSED", policy.paused],
    ["OVER_PER_RESCUE", exceeds(amount, maxPerRescue)],
    ["OVER_DAILY", amount !== null && exceeds(spentToday + amount, maxPerDay)],
    ["COOLDOWN", nowMs - newestRescue < policy.cooldownSec * 1000],
    ["NOT_BELOW_TRIGGER", !(freshSnapshot.health < policy.trigger)],
    ["SNAPSHOT_STALE", isStale(freshSnapshot.at, nowMs, MAX_SNAPSHOT_AGE_SEC)],
    ["QUOTE_STALE", isStale(request.quoteAt, nowMs, MAX_QUOTE_AGE_SEC)],
    ["SLIPPAGE", !(request.minAmountOutUsd >= minimumOut)],
    ["INSUFFICIENT_RESERVE", exceeds(amount, reserve)],
    ["UNKNOWN_TOKEN", !RESERVE_TOKENS.includes(request.token)],
  ];

  const reasons = rules.filter(([, broken]) => broken).map(([code]) => code);
  return { verdict: reasons.length === 0 ? "allow" : "block", reasons };
}
