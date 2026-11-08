import type { AuditRecord } from "@lifeline/shared";
import { fixtures } from "@lifeline/shared/fixtures";
import { describe, expect, it } from "vitest";
import { eventLinks, hyperliquidAddress, intentsExplorer, nearblocksAccount, nearblocksTx, pageHref, telegramStart } from "../src/lib/links";
import { describeReason, eventTitle, groupRecords, isSimulatedRecord, matchesFilter, requestAmount, tokenMeta } from "../src/lib/records";

const records = fixtures.auditRecords;
const done = records.find((r) => r.kind === "RESCUE_DONE")!;

/** A sim keeper record, shaped like the live one at lifeline-sim.prashantthakur.dev. */
const simulated = (record: AuditRecord, id: string): AuditRecord => ({
  ...record,
  id,
  user: "demo.near",
  ...(record.nearTx ? { nearTx: "sim-tx-1" } : {}),
  ...(record.request ? { request: { ...record.request, depositAddress: `sim-${record.request.id}` } } : {}),
});

describe("isSimulatedRecord", () => {
  it("spots the sim keeper's prefixes on the transaction or the deposit address", () => {
    expect(isSimulatedRecord(simulated(done, "s1"))).toBe(true);
    expect(isSimulatedRecord({ ...done, nearTx: "sim-tx-1" })).toBe(true);
    expect(isSimulatedRecord({ ...done, request: { ...done.request!, depositAddress: "sim-abc" } })).toBe(true);
  });
  it("leaves real records alone, including ones with no transaction", () => {
    expect(records.some(isSimulatedRecord)).toBe(false);
    expect(isSimulatedRecord({ id: "w", user: "a.near", kind: "WARN", at: done.at })).toBe(false);
  });
});

describe("groupRecords", () => {
  const events = groupRecords(records);

  it("joins a rescue's allowed and done records into one event, newest first", () => {
    expect(events.map((e) => e.outcome)).toEqual(["blocked", "done", "warn", "failed"]);
    const rescue = events[1]!;
    expect(rescue.records.map((r) => r.kind)).toEqual(["RESCUE_ALLOWED", "RESCUE_DONE"]);
    expect(rescue).toMatchObject({
      user: "alice.near",
      healthBefore: 1.48,
      healthAfter: 2.0,
      latencyMs: 42000,
      nearTx: "FakeNearTx1111111111111111111111111111111111",
      oneClickStatus: "SUCCESS",
      simulated: false,
    });
    expect(rescue.explanation).toMatch(/ETH fell 6%/);
  });

  it("keeps the block's reasons", () => {
    expect(events[0]!.reasons).toEqual(["RECIPIENT_MISMATCH"]);
  });

  it("shows a rescue still under way when only the allowed record is there", () => {
    const allowedOnly = groupRecords(records.filter((r) => r.kind === "RESCUE_ALLOWED"));
    expect(allowedOnly).toHaveLength(1);
    expect(allowedOnly[0]!.outcome).toBe("in-progress");
  });

  it("orders by time even when the log comes back out of order", () => {
    const shuffled = [records[3]!, records[0]!, records[4]!, records[2]!, records[1]!];
    expect(groupRecords(shuffled).map((e) => e.key)).toEqual(events.map((e) => e.key));
  });

  it("flags a simulated rescue", () => {
    const sim = groupRecords([simulated(records[2]!, "s-allowed"), simulated(records[1]!, "s-done")]);
    expect(sim).toHaveLength(1);
    expect(sim[0]!.simulated).toBe(true);
  });

  it("handles an empty log", () => {
    expect(groupRecords([])).toEqual([]);
  });
});

describe("filters and titles", () => {
  const events = groupRecords(records);
  it("filters by outcome", () => {
    expect(events.filter((e) => matchesFilter(e, "rescued")).map((e) => e.outcome)).toEqual(["done"]);
    expect(events.filter((e) => matchesFilter(e, "blocked"))).toHaveLength(1);
    expect(events.filter((e) => matchesFilter(e, "failed"))).toHaveLength(1);
    expect(events.filter((e) => matchesFilter(e, "warnings"))).toHaveLength(1);
    expect(events.filter((e) => matchesFilter(e, "all"))).toHaveLength(4);
  });
  it("titles each event with its amount", () => {
    expect(events.map((e) => eventTitle(e))).toEqual([
      "Refused a rescue of 18.06 USDC",
      "Sent 18.06 USDC to Hyperliquid",
      "Health crossed the warn line",
      "Rescue of 9.00 USDC failed",
    ]);
  });
  it("formats amounts by token", () => {
    expect(requestAmount({ amount: "3469653", token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" })).toBe("3.47 USDC");
    expect(requestAmount({ amount: "2500000000000000000000000", token: "wrap.near" })).toBe("2.50 wNEAR");
    expect(requestAmount({ amount: "7", token: "other.near" })).toBe("7 other.near");
    expect(tokenMeta("wrap.near").decimals).toBe(24);
  });
  it("knows the configured USDC on testnet, so amounts aren't shown 10^6 too large", () => {
    expect(tokenMeta("usdc.fakes.testnet", "usdc.fakes.testnet")).toEqual({ symbol: "USDC", decimals: 6 });
    expect(tokenMeta("usdc.fakes.testnet")).toEqual({ symbol: "usdc.fakes.testnet", decimals: 0 });
    expect(tokenMeta("wrap.testnet")).toEqual({ symbol: "wNEAR", decimals: 24 });
    const testnetEvent = { ...events[1]!, request: { ...events[1]!.request!, token: "usdc.fakes.testnet" } };
    expect(eventTitle(testnetEvent, "usdc.fakes.testnet")).toBe("Sent 18.06 USDC to Hyperliquid");
  });

  it("describes block reasons, and falls back for new codes", () => {
    expect(describeReason("RECIPIENT_MISMATCH")).toMatch(/someone other than/);
    expect(describeReason("SOMETHING_NEW")).toBe("The policy engine refused it (SOMETHING_NEW).");
  });
});

describe("links", () => {
  const events = groupRecords(records);
  it("builds explorer URLs", () => {
    expect(nearblocksTx("ABC", "mainnet")).toBe("https://nearblocks.io/txns/ABC");
    expect(nearblocksTx("ABC", "testnet")).toBe("https://testnet.nearblocks.io/txns/ABC");
    expect(nearblocksAccount("vault.lifeline.near", "mainnet")).toBe("https://nearblocks.io/address/vault.lifeline.near");
    expect(intentsExplorer("0xabc")).toBe("https://explorer.near-intents.org/transactions/0xabc");
    expect(hyperliquidAddress("0x11")).toBe("https://app.hyperliquid.xyz/explorer/address/0x11");
    expect(telegramStart("lifeline_bot", "AB23CD45")).toBe("https://t.me/lifeline_bot?start=AB23CD45");
    expect(pageHref("/position", "demo.near")).toBe("/position?user=demo.near");
    expect(pageHref("/position", null)).toBe("/position");
  });

  it("links a done rescue to NearBlocks, the 1Click swap and Hyperliquid", () => {
    expect(eventLinks(events[1]!, "mainnet")).toEqual([
      { label: "NEAR transaction", href: "https://nearblocks.io/txns/FakeNearTx1111111111111111111111111111111111" },
      {
        label: "1Click swap",
        href: "https://explorer.near-intents.org/transactions/fake0000000000000000000000000000000000000000000000000000deposit1",
      },
      { label: "Hyperliquid account", href: "https://app.hyperliquid.xyz/explorer/address/0x1111111111111111111111111111111111111111" },
    ]);
  });

  it("links a blocked rescue to the user's own address, never the refused recipient", () => {
    const links = eventLinks(events[0]!, "mainnet");
    expect(links).toEqual([{ label: "Hyperliquid account", href: "https://app.hyperliquid.xyz/explorer/address/0x1111111111111111111111111111111111111111" }]);
    expect(JSON.stringify(links)).not.toContain("0x9999");
  });

  it("doesn't link the reading's address when the block was for a reading of some other address", () => {
    const mismatch = { ...events[0]!, reasons: ["SNAPSHOT_MISMATCH"] };
    expect(eventLinks(mismatch, "mainnet")).toEqual([]);
  });

  it("never links a simulated event to an explorer", () => {
    const sim = groupRecords([simulated(records[2]!, "s-allowed"), simulated(records[1]!, "s-done")]);
    expect(eventLinks(sim[0]!, "mainnet")).toEqual([]);
  });
});
