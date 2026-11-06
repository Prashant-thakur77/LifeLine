import { describe, expect, it } from "vitest";
import { describeAudit, describeQuote } from "../src/demo-format";

describe("describeQuote", () => {
  it("shows what a real quote says, in USDC", () => {
    const text = describeQuote({
      quoteId: "corr-1",
      depositAddress: null,
      amountIn: "3469700",
      minAmountOut: "311000000",
      withdrawFee: "31530000",
      recipient: "0x1111111111111111111111111111111111111111",
      refundTo: "demo.near",
      destinationAsset: "x",
      quotedAt: "2026-11-08T15:00:00.000Z",
    });
    expect(text).toContain("3.47 USDC in");
    expect(text).toContain("3.11 USDC guaranteed");
    expect(text).toContain("0.3153 USDC fee");
    expect(text).toContain("corr-1");
    expect(text).toContain("signature checked");
  });
});

describe("describeAudit", () => {
  it("shows the record's main facts", () => {
    const text = describeAudit({
      id: "r",
      user: "demo.near",
      kind: "RESCUE_DONE",
      healthBefore: 1.44,
      healthAfter: 2.01,
      latencyMs: 5600,
      oneClickStatus: "SUCCESS",
      decision: { verdict: "allow", reasons: [] },
      at: "2026-11-08T15:00:00.000Z",
    });
    expect(text).toContain("RESCUE_DONE");
    expect(text).toContain('"verdict": "allow"');
    expect(text).toContain("2.01");
  });
});
