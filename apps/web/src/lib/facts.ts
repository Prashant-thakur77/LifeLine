import { ASSETS, type AuditRecord } from "@lifeline/shared";

// The facts the keeper sends the model for a record (apps/keeper/src/explain.ts factsFor),
// rebuilt in the browser so the verify page can check the model was told this record's
// facts and nothing else. A keeper test holds this equal to the keeper's own.

/** The bot's reason texts (apps/bot/src/messages.ts), which are what the model is given. */
const REASONS: Record<string, string> = {
  RECIPIENT_MISMATCH: "The quote pays someone other than your Hyperliquid address.",
  REFUND_MISMATCH: "A refund on this quote wouldn't go back to your own account.",
  WRONG_DEST_ASSET: "The quote doesn't deliver Hyperliquid perps USDC.",
  PAUSED: "You've paused rescues.",
  OVER_PER_RESCUE: "This rescue is over your limit per rescue.",
  OVER_DAILY: "This rescue would pass your 24-hour limit.",
  COOLDOWN: "Your cooldown since the last rescue hasn't passed yet.",
  NOT_BELOW_TRIGGER: "Your health is no longer below your trigger, so no rescue is needed.",
  SNAPSHOT_STALE: "The health reading was too old to trust.",
  QUOTE_STALE: "The quote was too old to trust.",
  SLIPPAGE: "The quote guarantees too little of what's needed.",
  INSUFFICIENT_RESERVE: "Your reserve doesn't hold enough USDC for this rescue.",
  UNKNOWN_TOKEN: "This reserve token isn't one Lifeline can rescue with.",
  MALFORMED_INPUT: "Something in this rescue couldn't be read, so it was refused.",
  USER_MISMATCH: "This rescue was for a different account.",
  SNAPSHOT_MISMATCH: "The health reading was for a different address.",
};

const describe = (code: string) => REASONS[code] ?? `The policy engine refused it (${code}).`;

const EVENTS: Partial<Record<AuditRecord["kind"], string>> = {
  RESCUE_ALLOWED: "A rescue has started.",
  RESCUE_DONE: "A rescue finished.",
  RESCUE_BLOCKED: "A rescue was refused by the safety rules, and no money moved.",
  RESCUE_FAILED: "A rescue failed.",
};

export function factsFor(record: AuditRecord): Record<string, unknown> {
  const { kind, healthBefore, healthAfter, latencyMs, oneClickStatus, request, decision } = record;
  const coins = request?.snapshot.positions.map((position) => position.coin);
  return {
    event: EVENTS[kind] ?? kind,
    ...(healthBefore === undefined ? {} : { healthBefore }),
    ...(healthAfter === undefined ? {} : { healthAfter }),
    ...(request === undefined
      ? {}
      : {
          amountUsdc: Number(request.amount) / 10 ** ASSETS.NEAR_USDC.decimals,
          expectedToDeliverUsd: request.usdNeeded,
        }),
    ...(latencyMs === undefined ? {} : { seconds: Math.round(latencyMs / 1000) }),
    ...(oneClickStatus === undefined ? {} : { oneClickStatus }),
    ...(coins === undefined || coins.length === 0 ? {} : { coins }),
    ...(decision === undefined || decision.reasons.length === 0 ? {} : { reasons: decision.reasons.map(describe) }),
  };
}
