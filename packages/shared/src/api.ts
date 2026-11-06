// Response bodies for the keeper REST API. The plan's endpoint table says what
// each one returns; these are the exact shapes, so the dashboard can build on
// the fixtures before the keeper is live.

import type { AuditRecord, HealthSnapshot, Policy } from "./types";

/**
 * A HealthSnapshot after a trip through JSON. JSON has no Infinity, and
 * JSON.stringify writes it as null, so an account with no positions arrives
 * with `health: null`. Pass it through parseHealthSnapshot before using it.
 */
export type HealthSnapshotJson = Omit<HealthSnapshot, "health"> & {
  health: number | null;
};

export function parseHealthSnapshot(json: HealthSnapshotJson): HealthSnapshot {
  return { ...json, health: json.health ?? Number.POSITIVE_INFINITY };
}

/**
 * GET /api/health/:user
 *
 * `status: "unknown"` means Hyperliquid could not be read after retries. There
 * is no snapshot then, and the UI must say so. Never show it as safe.
 */
export type HealthResponse = {
  status: "ok" | "unknown";
  snapshot: HealthSnapshotJson | null;
  policy: Policy;
};

/** GET /api/audit?user=&limit= and GET /api/ledger?limit=, newest first. */
export type AuditResponse = AuditRecord[];

/** GET /api/stats. Latency is null until there is at least one sample. */
export type StatsResponse = {
  totalRescues: number;
  totalUsdRescued: number;
  blockedCount: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

/** POST /api/telegram/link. The user sends `code` to the bot to link their chat. */
export type TelegramLinkResponse = {
  code: string;
  expiresAt: string; // ISO time
  botUsername: string;
};

/** GET /api/attestation. "not available" is the fallback if NEAR AI Cloud is down. */
export type AttestationResponse = {
  status: "verified" | "failed" | "not available";
  checkedAt: string | null; // ISO time
  model: string | null;
  checks: { name: string; passed: boolean; detail?: string }[];
};
