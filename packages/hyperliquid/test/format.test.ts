import { describe, expect, it } from "vitest";
import { formatHealthResult } from "../src/index";

const snapshot = {
  hlAddress: "0x1111111111111111111111111111111111111111",
  accountValue: 50.32,
  maintenanceMarginUsed: 34,
  health: 1.48,
  positions: [{ coin: "ETH", size: 0.5, entryPx: 3400, liquidationPx: 3120.5 }],
  at: "2026-11-08T15:00:00.000Z",
};

describe("formatHealthResult", () => {
  it("prints health and each position", () => {
    const text = formatHealthResult({ status: "ok", snapshot, isolatedCoins: [] });
    expect(text).toContain("health: 1.48");
    expect(text).toContain("ETH");
    expect(text).toContain("3120.5");
  });

  it("spells out Infinity, which JSON would print as null", () => {
    const text = formatHealthResult({
      status: "ok",
      snapshot: { ...snapshot, health: Number.POSITIVE_INFINITY, positions: [] },
      isolatedCoins: [],
    });
    expect(text).toContain("health: Infinity (no positions)");
  });

  it("warns about isolated coins that a top-up cannot protect", () => {
    const text = formatHealthResult({ status: "ok", snapshot, isolatedCoins: ["SOL"] });
    expect(text).toMatch(/not protected.*SOL/i);
  });

  it("shows unknown as unknown, never as a number", () => {
    const text = formatHealthResult({ status: "unknown", reason: "API_ERROR", detail: "down" });
    expect(text).toContain("health: unknown");
    expect(text).toContain("API_ERROR");
    expect(text).toContain("down");
  });
});
