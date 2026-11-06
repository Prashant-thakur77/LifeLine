import { MAX_QUOTE_SLIPPAGE_BPS, type HealthSnapshot, type Policy } from "@lifeline/shared";

const USDC_UNITS = 1_000_000;
const BUFFER = 1 + MAX_QUOTE_SLIPPAGE_BPS / 10_000;

/**
 * 2 USDC. On 2026-11-06 1Click rejected 1 USDC to Hyperliquid as too low and
 * accepted 2, so a smaller rescue would fail at the quote.
 */
export const MIN_RESCUE_UNITS = 2_000_000n;

export type RescueSize = {
  amount: string; // USDC base units to send into 1Click
  neededUsd: number; // what it would take to reach the policy's target
  usdNeeded: number; // what this amount should deliver, for the policy engine
  capped: boolean; // a cap or the reserve cut this below the full need
};

const toUnits = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : null);

/**
 * How much to send: (needed + the quote's withdrawFee) × 1.01, cut to the caps
 * and the reserve. A limit too small to quote leaves the amount alone, so the
 * policy engine blocks it and names that limit instead of 1Click rejecting it.
 */
export function sizeRescue(input: {
  snapshot: HealthSnapshot;
  policy: Policy;
  withdrawFeeUsd: number;
  reserve: string;
  spentToday: bigint;
}): RescueSize {
  const { snapshot, policy, withdrawFeeUsd, reserve, spentToday } = input;
  const neededUsd = policy.target * snapshot.maintenanceMarginUsed - snapshot.accountValue;

  // The small subtraction stops float noise from rounding a whole unit up.
  const wantedUnits = (Math.max(neededUsd, 0) + withdrawFeeUsd) * BUFFER * USDC_UNITS;
  const wanted = BigInt(Math.ceil(wantedUnits - 1e-6));

  const maxPerDay = toUnits(policy.maxPerDay);
  const limits = [
    toUnits(policy.maxPerRescue),
    maxPerDay === null ? null : maxPerDay - spentToday,
    toUnits(reserve),
  ];

  let amount = wanted > MIN_RESCUE_UNITS ? wanted : MIN_RESCUE_UNITS;
  for (const limit of limits) {
    if (limit !== null && limit >= MIN_RESCUE_UNITS && amount > limit) amount = limit;
  }

  return {
    amount: amount.toString(),
    neededUsd,
    usdNeeded: Number(amount) / USDC_UNITS / BUFFER - withdrawFeeUsd,
    capped: amount < wanted,
  };
}
