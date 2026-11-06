import { describe, expect, it } from "vitest";
import { describeRecord } from "../src/format";
import { record, rescueRequest } from "./helpers";

describe("describeRecord", () => {
  it("shows a warning's health", () => {
    expect(describeRecord(record({ id: "a", kind: "WARN", healthBefore: 1.7 }))).toBe("WARN            health 1.70");
  });

  it("shows how much an allowed rescue sends", () => {
    const line = describeRecord(record({ id: "a", kind: "RESCUE_ALLOWED", healthBefore: 1.43, request: rescueRequest({ amount: "4358453" }) }));
    expect(line).toBe("RESCUE_ALLOWED  health 1.43, sending 4.3585 USDC");
  });

  it("shows a finished rescue's result", () => {
    const line = describeRecord(
      record({ id: "a", kind: "RESCUE_DONE", healthBefore: 1.43, healthAfter: 2.01, latencyMs: 5300, oneClickStatus: "SUCCESS" }),
    );
    expect(line).toBe("RESCUE_DONE     health 1.43 to 2.01 in 5.3 s (SUCCESS)");
  });

  it("shows why a rescue was blocked", () => {
    const line = describeRecord(record({ id: "a", kind: "RESCUE_BLOCKED", healthBefore: 1.43, decision: { verdict: "block", reasons: ["PAUSED", "COOLDOWN"] } }));
    expect(line).toBe("RESCUE_BLOCKED  health 1.43: PAUSED, COOLDOWN");
  });

  it("shows why a rescue failed", () => {
    const line = describeRecord(record({ id: "a", kind: "RESCUE_FAILED", healthBefore: 1.43, explanation: "1Click reported REFUNDED." }));
    expect(line).toBe("RESCUE_FAILED   health 1.43: 1Click reported REFUNDED.");
  });

  it("copes with a record that has none of the optional fields", () => {
    expect(describeRecord(record({ id: "a", kind: "RESCUE_DONE" }))).toBe("RESCUE_DONE     health ?");
  });
});
