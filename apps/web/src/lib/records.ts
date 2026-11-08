import { ASSETS, type AuditRecord, type RescueRequest } from "@lifeline/shared";
import { formatUnits } from "./format";

/** The sim keeper marks its pretend deposits and transactions with a "sim-" prefix. */
export function isSimulatedRecord(record: AuditRecord): boolean {
  return record.nearTx?.startsWith("sim-") === true || record.request?.depositAddress.startsWith("sim-") === true;
}

const REASONS: Record<string, string> = {
  RECIPIENT_MISMATCH: "The quote paid someone other than the registered Hyperliquid address.",
  REFUND_MISMATCH: "A refund on this quote wouldn't have gone back to the user's own account.",
  WRONG_DEST_ASSET: "The quote didn't deliver Hyperliquid perps USDC.",
  PAUSED: "Rescues were paused.",
  OVER_PER_RESCUE: "The rescue was over the limit per rescue.",
  OVER_DAILY: "The rescue would have passed the 24-hour limit.",
  COOLDOWN: "The cooldown since the last rescue hadn't passed.",
  NOT_BELOW_TRIGGER: "Health was no longer below the trigger, so no rescue was needed.",
  SNAPSHOT_STALE: "The health reading was too old to trust.",
  QUOTE_STALE: "The quote was too old to trust.",
  SLIPPAGE: "The quote guaranteed too little of what was needed.",
  INSUFFICIENT_RESERVE: "The reserve didn't hold enough for this rescue.",
  UNKNOWN_TOKEN: "The reserve token isn't one Lifeline can rescue with.",
  MALFORMED_INPUT: "Something in the rescue couldn't be read, so it was refused.",
  USER_MISMATCH: "The rescue was for a different account.",
  SNAPSHOT_MISMATCH: "The health reading was for a different address.",
};

export function describeReason(code: string): string {
  return REASONS[code] ?? `The policy engine refused it (${code}).`;
}

export type TokenMeta = { symbol: string; decimals: number };

/** The reserve tokens of the first version. Anything else shows its raw base units. */
export function tokenMeta(contractId: string): TokenMeta {
  if (contractId === ASSETS.NEAR_USDC.contractId) return { symbol: "USDC", decimals: ASSETS.NEAR_USDC.decimals };
  if (contractId === ASSETS.NEAR_WNEAR.contractId) return { symbol: "wNEAR", decimals: ASSETS.NEAR_WNEAR.decimals };
  return { symbol: contractId, decimals: 0 };
}

/** "3.47 USDC" for a rescue request's amount. */
export function requestAmount(request: Pick<RescueRequest, "amount" | "token">): string {
  const meta = tokenMeta(request.token);
  return `${formatUnits(request.amount, meta.decimals, meta.decimals === 0 ? 0 : 2)} ${meta.symbol}`;
}

export type Outcome = "done" | "failed" | "in-progress" | "blocked" | "warn";

/** One thing that happened: a warning, a blocked attempt, or a rescue with its steps. */
export type LedgerEvent = {
  key: string;
  user: string;
  outcome: Outcome;
  /** Oldest first. */
  records: AuditRecord[];
  latest: AuditRecord;
  at: string;
  request: RescueRequest | null;
  reasons: string[];
  healthBefore: number | null;
  healthAfter: number | null;
  latencyMs: number | null;
  nearTx: string | null;
  oneClickStatus: string | null;
  explanation: string | null;
  simulated: boolean;
};

const OUTCOME: Record<AuditRecord["kind"], Outcome> = {
  WARN: "warn",
  RESCUE_ALLOWED: "in-progress",
  RESCUE_BLOCKED: "blocked",
  RESCUE_DONE: "done",
  RESCUE_FAILED: "failed",
};

const lastDefined = <T>(records: AuditRecord[], pick: (r: AuditRecord) => T | undefined): T | null => {
  for (let i = records.length - 1; i >= 0; i--) {
    const value = pick(records[i]!);
    if (value !== undefined) return value;
  }
  return null;
};

/**
 * Folds the audit log into events, newest first. A rescue's RESCUE_ALLOWED and its
 * RESCUE_DONE or RESCUE_FAILED share a request id and become one event. If a page of
 * the log cuts a rescue in half, the half that's there still shows.
 */
export function groupRecords(records: readonly AuditRecord[]): LedgerEvent[] {
  const groups = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const key = record.kind === "WARN" || record.kind === "RESCUE_BLOCKED" || !record.request ? `record:${record.id}` : `request:${record.request.id}`;
    const list = groups.get(key);
    if (list) list.push(record);
    else groups.set(key, [record]);
  }

  const events: LedgerEvent[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = sorted[sorted.length - 1]!;
    events.push({
      key,
      user: latest.user,
      outcome: OUTCOME[latest.kind],
      records: sorted,
      latest,
      at: latest.at,
      request: lastDefined(sorted, (r) => r.request),
      reasons: lastDefined(sorted, (r) => r.decision?.reasons) ?? [],
      healthBefore: sorted.find((r) => r.healthBefore !== undefined)?.healthBefore ?? null,
      healthAfter: lastDefined(sorted, (r) => r.healthAfter),
      latencyMs: lastDefined(sorted, (r) => r.latencyMs),
      nearTx: lastDefined(sorted, (r) => r.nearTx),
      oneClickStatus: lastDefined(sorted, (r) => r.oneClickStatus),
      explanation: lastDefined(sorted, (r) => r.explanation),
      simulated: sorted.some(isSimulatedRecord),
    });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export type LedgerFilter = "all" | "rescued" | "blocked" | "failed" | "warnings";

export const LEDGER_FILTERS: { id: LedgerFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "rescued", label: "Rescued" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" },
  { id: "warnings", label: "Warnings" },
];

export function matchesFilter(event: LedgerEvent, filter: LedgerFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "rescued":
      return event.outcome === "done" || event.outcome === "in-progress";
    case "blocked":
      return event.outcome === "blocked";
    case "failed":
      return event.outcome === "failed";
    case "warnings":
      return event.outcome === "warn";
  }
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  done: "Rescued",
  failed: "Failed",
  "in-progress": "In progress",
  blocked: "Blocked",
  warn: "Warning",
};

/** A one-line summary of an event, for the timeline heading. */
export function eventTitle(event: LedgerEvent): string {
  const amount = event.request ? requestAmount(event.request) : null;
  switch (event.outcome) {
    case "done":
      return amount ? `Sent ${amount} to Hyperliquid` : "Rescue done";
    case "in-progress":
      return amount ? `Sending ${amount} to Hyperliquid` : "Rescue under way";
    case "failed":
      return amount ? `Rescue of ${amount} failed` : "Rescue failed";
    case "blocked":
      return amount ? `Refused a rescue of ${amount}` : "Rescue refused";
    case "warn":
      return "Health crossed the warn line";
  }
}
