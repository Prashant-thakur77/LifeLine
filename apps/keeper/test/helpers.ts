import { ASSETS, POLICY_DEFAULTS, type AuditRecord, type HealthSnapshot, type Policy, type RescueRequest } from "@lifeline/shared";

export const USER = "alice.near";
export const HL = "0x1111111111111111111111111111111111111111";
export const AT = "2026-11-08T15:00:00.000Z";

export const policy = (o: Partial<Policy> = {}): Policy => ({
  user: USER,
  hlAddress: HL,
  ...POLICY_DEFAULTS,
  paused: false,
  ...o,
});

export const snapshot = (accountValue: number, maintenanceMarginUsed: number, at = AT): HealthSnapshot => ({
  hlAddress: HL,
  accountValue,
  maintenanceMarginUsed,
  health: maintenanceMarginUsed === 0 ? Number.POSITIVE_INFINITY : accountValue / maintenanceMarginUsed,
  positions: [{ coin: "ETH", size: 0.1, entryPx: 3000, liquidationPx: 2500 }],
  at,
});

export const rescueRequest = (o: Partial<RescueRequest> = {}): RescueRequest => ({
  id: "req-1",
  user: USER,
  token: ASSETS.NEAR_USDC.contractId,
  amount: "5000000",
  usdNeeded: 4.6,
  quoteId: "quote-1",
  depositAddress: "deposit-1",
  recipient: HL,
  quoteAt: AT,
  snapshot: snapshot(50, 34),
  ...o,
});

export const record = (o: Partial<AuditRecord> & { id: string; kind: AuditRecord["kind"] }): AuditRecord => ({
  user: USER,
  at: AT,
  ...o,
});
