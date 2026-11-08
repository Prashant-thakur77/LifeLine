import { REASON_CODES, type AuditRecord, type RescueRequest } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { describeReason, formatRecord, formatStatus } from "../src/messages";

const HL = "0x1111111111111111111111111111111111111111";
const request = { amount: "4358453", recipient: HL, depositAddress: "abc123" } as RescueRequest;
const record = (o: Partial<AuditRecord>): AuditRecord => ({ id: "r", user: "alice.near", kind: "WARN", at: "2026-11-08T15:00:00.000Z", ...o });
const policy = { user: "alice.near", hlAddress: HL, warn: 1.8, trigger: 1.5, target: 2, maxPerRescue: "25000000", maxPerDay: "50000000", cooldownSec: 120, paused: false };

describe("formatRecord", () => {
  it("warns with the health", () => {
    const text = formatRecord(record({ kind: "WARN", healthBefore: 1.7 }), "mainnet");
    expect(text).toContain("alice.near");
    expect(text).toContain("1.70");
  });

  it("doesn't promise a rescue on a warning, because the user may have paused", () => {
    expect(formatRecord(record({ kind: "WARN", healthBefore: 1.7 }), "mainnet")).toMatch(/unless you've paused/i);
  });

  it("says a rescue started, and how much", () => {
    const text = formatRecord(record({ kind: "RESCUE_ALLOWED", healthBefore: 1.43, request }), "mainnet");
    expect(text).toMatch(/rescue started/i);
    expect(text).toContain("4.36 USDC");
    expect(text).toContain("1.43");
  });

  it("links a finished rescue on mainnet", () => {
    const text = formatRecord(
      record({ kind: "RESCUE_DONE", healthBefore: 1.43, healthAfter: 2.01, latencyMs: 41_000, nearTx: "HASH", request }),
      "mainnet",
    );
    expect(text).toMatch(/rescue done/i);
    expect(text).toContain("2.01");
    expect(text).toContain("41 s");
    expect(text).toContain("https://nearblocks.io/txns/HASH");
    expect(text).toContain(`https://app.hyperliquid.xyz/explorer/address/${HL}`);
    expect(text).toContain("https://explorer.near-intents.org");
    expect(text).toContain("abc123");
  });

  it("links to the testnet explorer on testnet", () => {
    const text = formatRecord(record({ kind: "RESCUE_DONE", nearTx: "HASH", request }), "testnet");
    expect(text).toContain("https://testnet.nearblocks.io/txns/HASH");
  });

  it("marks a simulated rescue as one, with no links to transactions that don't exist", () => {
    const sim = { ...request, depositAddress: "sim-7f3a" } as RescueRequest;
    for (const kind of ["RESCUE_DONE", "RESCUE_FAILED"] as const) {
      const text = formatRecord(record({ kind, healthBefore: 1.43, healthAfter: 2.01, nearTx: "sim-tx-1", request: sim }), "mainnet");
      expect(text).toMatch(/simulation/i);
      expect(text).not.toContain("http");
    }
  });

  it("doesn't claim a time or a health it doesn't have", () => {
    const text = formatRecord(record({ kind: "RESCUE_DONE", explanation: "It didn't show on Hyperliquid." }), "mainnet");
    expect(text).not.toMatch(/undefined|NaN/);
    expect(text).toContain("It didn't show on Hyperliquid.");
  });

  it("gives every blocked reason in plain words", () => {
    const text = formatRecord(
      record({ kind: "RESCUE_BLOCKED", healthBefore: 1.43, decision: { verdict: "block", reasons: ["PAUSED", "COOLDOWN"] } }),
      "mainnet",
    );
    expect(text).toMatch(/rescue blocked/i);
    expect(text).toContain(describeReason("PAUSED"));
    expect(text).toContain(describeReason("COOLDOWN"));
    expect(text).not.toContain("PAUSED");
  });

  it("says a rescue failed, and why", () => {
    const text = formatRecord(record({ kind: "RESCUE_FAILED", healthBefore: 1.43, explanation: "1Click reported REFUNDED.", nearTx: "HASH" }), "mainnet");
    expect(text).toMatch(/rescue failed/i);
    expect(text).toContain("1Click reported REFUNDED.");
    expect(text).toContain("https://nearblocks.io/txns/HASH");
  });

  it("adds the explanation when a record has one", () => {
    const text = formatRecord(record({ kind: "RESCUE_ALLOWED", request, explanation: "ETH fell 6% in 20 minutes." }), "mainnet");
    expect(text).toContain("ETH fell 6% in 20 minutes.");
  });
});

describe("describeReason", () => {
  it("has plain words for every reason the engine can give", () => {
    const codes = [...REASON_CODES, "MALFORMED_INPUT", "USER_MISMATCH", "SNAPSHOT_MISMATCH", "REFUND_MISMATCH"];
    for (const code of codes) {
      expect(describeReason(code)).not.toBe(code);
      expect(describeReason(code).length).toBeGreaterThan(5);
    }
  });

  it("shows a code it doesn't know, rather than hiding it", () => {
    expect(describeReason("SOMETHING_NEW")).toContain("SOMETHING_NEW");
  });
});

describe("formatStatus", () => {
  it("shows health against the policy", () => {
    const text = formatStatus("alice.near", { status: "ok", snapshot: { hlAddress: HL, accountValue: 50, maintenanceMarginUsed: 30, health: 1.67, positions: [], at: "" }, policy });
    expect(text).toContain("1.67");
    expect(text).toContain("1.5");
  });

  it("never reports an unreadable account as safe", () => {
    const text = formatStatus("alice.near", { status: "unknown", snapshot: null, policy });
    expect(text).toMatch(/can't read/i);
    expect(text).toMatch(/don't treat/i);
  });

  it("says no open positions rather than an infinite health", () => {
    const text = formatStatus("alice.near", { status: "ok", snapshot: { hlAddress: HL, accountValue: 50, maintenanceMarginUsed: 0, health: null, positions: [], at: "" }, policy });
    expect(text).toMatch(/no open positions/i);
    expect(text).not.toMatch(/null|Infinity/);
  });

  it("says when rescues are paused", () => {
    const text = formatStatus("alice.near", { status: "ok", snapshot: { hlAddress: HL, accountValue: 50, maintenanceMarginUsed: 30, health: 1.67, positions: [], at: "" }, policy: { ...policy, paused: true } });
    expect(text).toMatch(/paused/i);
  });

  it("says when the keeper hasn't read the account yet", () => {
    expect(formatStatus("alice.near", null)).toMatch(/hasn't read/i);
  });
});
