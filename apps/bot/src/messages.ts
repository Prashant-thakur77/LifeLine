import { ASSETS, type AuditRecord, type HealthResponse } from "@lifeline/shared";

export type Network = "mainnet" | "testnet";

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

export const describeReason = (code: string) => REASONS[code] ?? `The policy engine refused it (${code}).`;

const health = (value: number) => value.toFixed(2);

function links(record: AuditRecord, network: Network): string[] {
  const lines: string[] = [];
  if (record.nearTx) {
    const host = network === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
    lines.push(`NEAR transaction: https://${host}/txns/${record.nearTx}`);
  }
  if (record.request) {
    lines.push(`Hyperliquid account: https://app.hyperliquid.xyz/explorer/address/${record.request.recipient}`);
    lines.push(`1Click swap: https://explorer.near-intents.org (search ${record.request.depositAddress})`);
  }
  return lines;
}

/** Plain text, because Telegram turns URLs into links and there's nothing to escape. */
export function formatRecord(record: AuditRecord, network: Network): string {
  const { kind, user, healthBefore, healthAfter, latencyMs, request, decision, explanation } = record;
  const atHealth = healthBefore === undefined ? "" : ` at health ${health(healthBefore)}`;
  const lines: string[] = [];

  switch (kind) {
    case "WARN":
      lines.push(`Lifeline warning for ${user}${atHealth}. A rescue fires if it falls below your trigger, unless you've paused.`);
      break;
    case "RESCUE_ALLOWED": {
      const usdc = Number(request?.amount ?? 0) / 10 ** ASSETS.NEAR_USDC.decimals;
      lines.push(`Rescue started for ${user}${atHealth}: sending ${usdc.toFixed(2)} USDC from your reserve to Hyperliquid.`);
      break;
    }
    case "RESCUE_DONE": {
      const change = healthBefore !== undefined && healthAfter !== undefined ? `: health ${health(healthBefore)} to ${health(healthAfter)}` : "";
      const time = latencyMs === undefined ? "" : ` in ${Math.round(latencyMs / 1000)} s`;
      lines.push(`Rescue done for ${user}${change}${time}.`);
      lines.push(...links(record, network));
      break;
    }
    case "RESCUE_BLOCKED":
      lines.push(`Rescue blocked for ${user}${atHealth}. No funds moved.`);
      lines.push(...(decision?.reasons ?? []).map((reason) => `- ${describeReason(reason)}`));
      break;
    case "RESCUE_FAILED":
      lines.push(`Rescue failed for ${user}${atHealth}.`);
      lines.push(...links(record, network));
      break;
  }

  if (explanation) lines.push(explanation);
  return lines.join("\n");
}

/** Never lets an account that can't be read look safe. */
export function formatStatus(user: string, response: HealthResponse | null): string {
  if (response === null) return `${user}: the keeper hasn't read this account yet.`;
  if (response.status !== "ok" || response.snapshot === null) {
    return `${user}: Lifeline can't read this account right now, so don't treat it as safe.`;
  }
  const { policy, snapshot } = response;
  const paused = policy.paused ? " Rescues are paused." : "";
  if (snapshot.health === null) return `${user}: no open positions.${paused}`;
  return `${user}: health ${health(snapshot.health)}. Warn at ${policy.warn}, rescue below ${policy.trigger}, up to ${policy.target}.${paused}`;
}
