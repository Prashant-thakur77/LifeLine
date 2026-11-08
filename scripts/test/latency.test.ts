import { describe, expect, it } from "vitest";
import { formatReport, summarize, type DecisionSample, type NearSample } from "../src/latency-report";

const decision = (totalMs: number): DecisionSample => ({
  at: "2026-11-08T13:40:00.000Z",
  address: "0xabc",
  readMs: totalMs / 4,
  probeMs: totalMs / 4,
  quoteMs: totalMs / 4,
  freshMs: totalMs / 4,
  totalMs,
  timeEstimateSec: 30,
});

describe("summarize", () => {
  it("reports nearest-rank p50 and p95, so each is a time that really happened", () => {
    const summary = summarize([1000, 2000, 3000, 4000, 5000].map(decision), []);
    expect(summary.decision.count).toBe(5);
    expect(summary.decision.totalMs).toEqual({ p50: 3000, p95: 5000 });
    expect(summary.decision.readMs).toEqual({ p50: 750, p95: 1250 });
    expect(summary.oneClickEstimateSec).toBe(30);
    expect(summary.near).toBeNull();
  });

  it("summarizes NEAR transactions when there are any", () => {
    const near: NearSample[] = [1500, 1200, 2400].map((ms, i) => ({ at: "t", txHash: `h${i}`, ms, network: "testnet" }));
    expect(summarize([decision(1000)], near).near).toEqual({ count: 3, network: "testnet", ms: { p50: 1500, p95: 2400 } });
  });

  it("takes the most common 1Click estimate, not the first", () => {
    const samples = [decision(1), { ...decision(1), timeEstimateSec: 45 }, { ...decision(1), timeEstimateSec: 45 }];
    expect(summarize(samples, []).oneClickEstimateSec).toBe(45);
  });
});

describe("formatReport", () => {
  it("adds up an estimate of the whole rescue and says which parts were measured", () => {
    const near: NearSample[] = [{ at: "t", txHash: "h", ms: 2000, network: "testnet" }];
    const report = formatReport(summarize([decision(3000)], near), "2026-11-08T14:00:00.000Z");
    expect(report).toContain("| Keeper decision, mainnet APIs | 1 | 3.0 s | 3.0 s |");
    expect(report).toContain("| NEAR rescue transaction, testnet | 1 | 2.0 s | 2.0 s |");
    expect(report).toMatch(/1Click's own estimate.*30 s/);
    // detection up to 5 s + decision + NEAR + 1Click's estimate
    expect(report).toContain("about 37.5 s at p50 and 40.0 s at p95");
    expect(report).toMatch(/not measured/i);
  });

  it("counts the attempts that failed, with their reasons, instead of hiding them", () => {
    const report = formatReport(summarize([decision(3000)], [], [{ at: "t", error: "The operation was aborted due to timeout" }]), "t");
    expect(report).toContain("1 of 2 attempts failed");
    expect(report).toContain("The operation was aborted due to timeout");
  });

  it("counts NEAR transactions that never came back, instead of hiding them", () => {
    const near = [{ at: "t", txHash: "H", ms: 4300, network: "testnet" as const }];
    const report = formatReport(summarize([decision(3000)], near, [], [{ at: "t", error: "fetch failed" }]), "t");
    expect(report).toContain("1 of 2 rescue transactions didn't come back from the public node and aren't in the table: fetch failed.");
  });

  it("says so when the NEAR transaction wasn't sampled", () => {
    expect(formatReport(summarize([decision(3000)], []), "t")).toMatch(/NEAR transaction.*not sampled/i);
  });
});
