import { ASSETS, type AuditRecord } from "@lifeline/shared";

const health = (value: number | undefined) => (value === undefined ? "?" : value.toFixed(2));

/** One line for the terminal. */
export function describeRecord(record: AuditRecord): string {
  const { kind, healthBefore, healthAfter, latencyMs, oneClickStatus, request, decision, explanation } = record;
  const head = `${kind.padEnd(15)} health ${health(healthBefore)}`;

  switch (kind) {
    case "RESCUE_ALLOWED": {
      const usdc = Number(request?.amount ?? 0) / 10 ** ASSETS.NEAR_USDC.decimals;
      return `${head}, sending ${usdc.toFixed(4)} USDC`;
    }
    case "RESCUE_DONE": {
      if (healthAfter === undefined) return head;
      const seconds = ((latencyMs ?? 0) / 1000).toFixed(1);
      return `${head} to ${health(healthAfter)} in ${seconds} s (${oneClickStatus})`;
    }
    case "RESCUE_BLOCKED":
      return `${head}: ${decision?.reasons.join(", ")}`;
    case "RESCUE_FAILED":
      return `${head}: ${explanation}`;
    default:
      return head;
  }
}
