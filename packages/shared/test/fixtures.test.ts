import { describe, expect, it } from "vitest";
import { fixtures } from "../fixtures/index";
import { POLICY_DEFAULTS, REASON_CODES, parseHealthSnapshot } from "../src/index";

const { healthSafe, healthWarn, healthBelowTrigger, healthNoPositions, healthUnknown } = fixtures;

describe("health fixtures", () => {
  const withSnapshots = [healthSafe, healthWarn, healthBelowTrigger];

  it("computes health as accountValue / maintenanceMarginUsed", () => {
    for (const { snapshot } of withSnapshots) {
      expect(snapshot).not.toBeNull();
      const { accountValue, maintenanceMarginUsed, health } = snapshot!;
      expect(health).toBeCloseTo(accountValue / maintenanceMarginUsed, 6);
    }
  });

  it("has one fixture for each band of the gauge", () => {
    const { warn, trigger } = POLICY_DEFAULTS;
    expect(healthSafe.snapshot!.health).toBeGreaterThan(warn);
    expect(healthWarn.snapshot!.health).toBeLessThan(warn);
    expect(healthWarn.snapshot!.health).toBeGreaterThan(trigger);
    expect(healthBelowTrigger.snapshot!.health).toBeLessThan(trigger);
  });

  it("carries no-positions as null on the wire and Infinity once parsed", () => {
    expect(healthNoPositions.status).toBe("ok");
    expect(healthNoPositions.snapshot!.health).toBeNull();
    expect(healthNoPositions.snapshot!.positions).toEqual([]);
    expect(parseHealthSnapshot(healthNoPositions.snapshot!).health).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("reports an API outage as unknown, with no snapshot to mistake for safe", () => {
    expect(healthUnknown.status).toBe("unknown");
    expect(healthUnknown.snapshot).toBeNull();
  });

  it("ties every snapshot to the address in its policy", () => {
    for (const { snapshot, policy } of [...withSnapshots, healthNoPositions]) {
      expect(snapshot!.hlAddress).toBe(policy.hlAddress);
    }
  });
});

describe("audit fixtures", () => {
  const records = fixtures.auditRecords;

  it("covers every record kind", () => {
    expect(new Set(records.map((r) => r.kind))).toEqual(
      new Set(["WARN", "RESCUE_ALLOWED", "RESCUE_BLOCKED", "RESCUE_DONE", "RESCUE_FAILED"]),
    );
  });

  it("is newest first, as the API returns it", () => {
    const times = records.map((r) => Date.parse(r.at));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("gives every rescue, block and failure record an explanation", () => {
    for (const r of records) {
      if (r.kind === "WARN" || r.kind === "RESCUE_ALLOWED") continue;
      expect(r.explanation, r.id).toBeTruthy();
    }
  });

  it("uses only reason codes the policy engine knows", () => {
    const known: readonly string[] = REASON_CODES;
    for (const r of records) {
      for (const reason of r.decision?.reasons ?? []) {
        expect(known).toContain(reason);
      }
    }
  });

  it("blocks the rescue whose recipient differs from the policy", () => {
    const blocked = records.find((r) => r.kind === "RESCUE_BLOCKED");
    expect(blocked?.decision?.verdict).toBe("block");
    expect(blocked?.decision?.reasons).toContain("RECIPIENT_MISMATCH");
    expect(blocked?.request?.recipient).not.toBe(healthSafe.policy.hlAddress);
  });

  it("shows a finished rescue with its tx, status, latency and restored health", () => {
    const done = records.find((r) => r.kind === "RESCUE_DONE");
    expect(done?.decision?.verdict).toBe("allow");
    expect(done?.request?.recipient).toBe(healthSafe.policy.hlAddress);
    expect(done?.nearTx).toBeTruthy();
    expect(done?.oneClickStatus).toBe("SUCCESS");
    expect(done?.latencyMs).toBeGreaterThan(0);
    expect(done?.healthAfter).toBeGreaterThan(done!.healthBefore!);
  });
});

describe("other endpoint fixtures", () => {
  it("has stats with latency percentiles in order", () => {
    const { latencyP50Ms, latencyP95Ms } = fixtures.stats;
    expect(latencyP50Ms).not.toBeNull();
    expect(latencyP95Ms!).toBeGreaterThanOrEqual(latencyP50Ms!);
  });

  it("has a verified attestation with every check listed and passing", () => {
    expect(fixtures.attestation.status).toBe("verified");
    expect(fixtures.attestation.checks.length).toBeGreaterThan(0);
    expect(fixtures.attestation.checks.every((c) => c.passed)).toBe(true);
  });

  it("has a Telegram link code with an expiry", () => {
    expect(fixtures.telegramLink.code).toBeTruthy();
    expect(Date.parse(fixtures.telegramLink.expiresAt)).not.toBeNaN();
  });
});
