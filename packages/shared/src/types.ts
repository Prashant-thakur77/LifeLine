// The agreed interfaces from the plan's "Shared interfaces" section. Both
// teammates build against these. Do not change one without telling the other.

export type Policy = {
  user: string; // NEAR account, e.g. alice.near
  hlAddress: string; // 0x… Hyperliquid address; the ONLY allowed recipient
  warn: number; // 1.8
  trigger: number; // 1.5
  target: number; // 2.0
  maxPerRescue: string; // token base units, as a string
  maxPerDay: string;
  cooldownSec: number; // 120
  paused: boolean;
};

export type HealthSnapshot = {
  hlAddress: string;
  accountValue: number; // USD
  maintenanceMarginUsed: number; // USD
  health: number; // accountValue / maintenanceMarginUsed (Infinity if no positions)
  positions: { coin: string; size: number; entryPx: number; liquidationPx: number | null }[];
  at: string; // ISO time
};

export type RescueRequest = {
  id: string; // uuid, also the 1Click requestId
  user: string;
  token: string; // reserve token contract id
  amount: string; // base units sent into 1Click
  usdNeeded: number;
  quoteId: string;
  depositAddress: string; // 1Click deposit address
  recipient: string; // must equal policy.hlAddress
  quoteAt: string;
  snapshot: HealthSnapshot;
};

export type PolicyDecision = {
  verdict: "allow" | "block";
  reasons: string[]; // machine codes, e.g. "RECIPIENT_MISMATCH", "DAILY_CAP"
};

export type AuditRecord = {
  id: string;
  user: string;
  kind: "WARN" | "RESCUE_ALLOWED" | "RESCUE_BLOCKED" | "RESCUE_DONE" | "RESCUE_FAILED";
  request?: RescueRequest;
  decision?: PolicyDecision;
  nearTx?: string;
  oneClickStatus?: string; // SUCCESS | REFUNDED | FAILED | …
  healthBefore?: number;
  healthAfter?: number;
  explanation?: string; // plain-language text from NEAR AI Cloud
  latencyMs?: number; // trigger detected → USDC credited on Hyperliquid
  at: string;
};
