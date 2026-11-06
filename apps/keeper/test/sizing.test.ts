import { POLICY_DEFAULTS, type HealthSnapshot, type Policy } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { MIN_RESCUE_UNITS, sizeRescue } from "../src/sizing";

const snapshot = (accountValue: number, maintenanceMarginUsed: number): HealthSnapshot => ({
  hlAddress: "0x1111111111111111111111111111111111111111",
  accountValue,
  maintenanceMarginUsed,
  health: accountValue / maintenanceMarginUsed,
  positions: [],
  at: "2026-11-08T15:00:00.000Z",
});

const policy: Policy = {
  user: "alice.near",
  hlAddress: "0x1111111111111111111111111111111111111111",
  ...POLICY_DEFAULTS,
  paused: false,
};

const FEE = 0.3153;
const size = (o: { snapshot: HealthSnapshot; policy?: Partial<Policy>; reserve?: string; spent?: bigint }) =>
  sizeRescue({
    snapshot: o.snapshot,
    policy: { ...policy, ...o.policy },
    withdrawFeeUsd: FEE,
    reserve: o.reserve ?? "100000000",
    spentToday: o.spent ?? 0n,
  });

describe("sizeRescue", () => {
  it("sends the need plus the live fee plus 1%", () => {
    // target 2 × 10 − 17 = 3 needed; (3 + 0.3153) × 1.01 = 3.348453
    const result = size({ snapshot: snapshot(17, 10) });
    expect(result.amount).toBe("3348453");
    expect(result.neededUsd).toBeCloseTo(3, 6);
    expect(result.usdNeeded).toBeCloseTo(3, 4);
    expect(result.capped).toBe(false);
  });

  it("uses the policy's target", () => {
    // target 3 × 10 − 17 = 13 needed; (13 + 0.3153) × 1.01 = 13.448453
    expect(size({ snapshot: snapshot(17, 10), policy: { target: 3 } }).amount).toBe("13448453");
  });

  it("uses the fee it is given, not a fixed one", () => {
    const result = sizeRescue({
      snapshot: snapshot(17, 10),
      policy,
      withdrawFeeUsd: 1,
      reserve: "100000000",
      spentToday: 0n,
    });
    expect(result.amount).toBe("4040000"); // (3 + 1) × 1.01
  });

  it("cuts to the per-rescue cap and lowers usdNeeded to match", () => {
    // 40 needed, but the cap is 25.
    const result = size({ snapshot: snapshot(10, 25) });
    expect(result.amount).toBe("25000000");
    expect(result.capped).toBe(true);
    expect(result.usdNeeded).toBeCloseTo(25 / 1.01 - FEE, 6);
    expect(result.neededUsd).toBeCloseTo(40, 6);
  });

  it("cuts to what is left of the daily cap", () => {
    const result = size({ snapshot: snapshot(10, 25), spent: 40_000_000n });
    expect(result.amount).toBe("10000000");
    expect(result.capped).toBe(true);
  });

  it("cuts to the reserve", () => {
    const result = size({ snapshot: snapshot(10, 25), reserve: "8000000" });
    expect(result.amount).toBe("8000000");
    expect(result.capped).toBe(true);
  });

  it("raises a tiny rescue to the minimum 1Click accepts", () => {
    // 0.1 needed, which would quote below the minimum and be rejected.
    const result = size({ snapshot: snapshot(19.9, 10) });
    expect(result.amount).toBe(String(MIN_RESCUE_UNITS));
    expect(result.usdNeeded).toBeGreaterThan(0);
  });

  it("keeps the amount when a limit is below the minimum, so the engine names that limit", () => {
    // A cut to 0.5 USDC couldn't be quoted, and the reason would be lost.
    expect(BigInt(size({ snapshot: snapshot(17, 10), reserve: "500000" }).amount)).toBeGreaterThan(500_000n);
    expect(BigInt(size({ snapshot: snapshot(17, 10), spent: 50_000_000n }).amount)).toBeGreaterThan(0n);
    expect(BigInt(size({ snapshot: snapshot(17, 10), policy: { maxPerRescue: "0" } }).amount)).toBeGreaterThan(0n);
  });

  it("always asks to deliver something positive", () => {
    for (const reserve of ["2000000", "3000000", "100000000"]) {
      expect(size({ snapshot: snapshot(10, 25), reserve }).usdNeeded).toBeGreaterThan(0);
    }
  });

  it("never returns a fractional base unit", () => {
    expect(size({ snapshot: snapshot(17.123456789, 10.987654321) }).amount).toMatch(/^\d+$/);
  });
});
