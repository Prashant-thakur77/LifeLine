import { describe, expect, it } from "vitest";
import { liquidationPrice, playground, type PlaygroundInput } from "../src/lib/playground";

const base: PlaygroundInput = {
  startPrice: 3000,
  notionalUsd: 1000,
  leverage: 10,
  dropPct: 0,
  lifeline: true,
  trigger: 1.5,
  target: 2,
  reserveUsd: 200,
  perRescueUsd: 25,
  perDayUsd: 50,
};

describe("liquidationPrice", () => {
  it("is where account value equals maintenance margin", () => {
    // 10x on $1,000 of ETH at $3,000: margin $100, size 1/3 ETH, maintenance 2%.
    const p = liquidationPrice({ startPrice: 3000, notionalUsd: 1000, marginUsd: 100 });
    const size = 1000 / 3000;
    expect(100 + size * (p - 3000)).toBeCloseTo(size * p * 0.02, 6);
    expect(p).toBeCloseTo(2755.1, 0);
  });
});

describe("playground", () => {
  it("reads health as account value over maintenance margin, before any move", () => {
    const r = playground({ ...base, dropPct: 0 });
    expect(r.healthWithout).toBeCloseTo(100 / 20, 6);
    expect(r.rescues).toHaveLength(0);
  });

  it("without Lifeline, a deep enough drop liquidates", () => {
    const r = playground({ ...base, lifeline: false, dropPct: 9 });
    expect(r.liquidatedWithout).toBe(true);
    expect(r.liquidationDropPct).toBeCloseTo(8.16, 1);
  });

  it("with Lifeline, rescues refill toward the target and the position survives the same drop", () => {
    const r = playground({ ...base, dropPct: 9 });
    expect(r.liquidatedWith).toBe(false);
    expect(r.rescues.length).toBeGreaterThan(0);
    expect(r.healthWith).toBeGreaterThan(1);
    for (const rescue of r.rescues) {
      expect(rescue.healthAfter).toBeGreaterThan(rescue.healthBefore);
      expect(rescue.amountUsd).toBeLessThanOrEqual(25);
      expect(rescue.amountUsd).toBeGreaterThanOrEqual(2);
    }
  });

  it("never spends more than the per-day cap or the reserve", () => {
    const r = playground({ ...base, dropPct: 30, reserveUsd: 1000 });
    expect(r.spentUsd).toBeLessThanOrEqual(50 + 1e-9);
    const small = playground({ ...base, dropPct: 30, reserveUsd: 10, perDayUsd: 1000 });
    expect(small.spentUsd).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("goes under once the caps run out, and says how far it got", () => {
    const r = playground({ ...base, dropPct: 30 });
    expect(r.liquidatedWith).toBe(true);
    expect(r.survivesToDropPct).toBeGreaterThan(r.liquidationDropPct);
    expect(r.survivesToDropPct).toBeLessThan(30);
  });

  it("pays 1Click's flat fee out of each rescue, so less margin lands than leaves the reserve", () => {
    const r = playground({ ...base, dropPct: 9 });
    const first = r.rescues[0]!;
    expect(first.landedUsd).toBeLessThan(first.amountUsd);
    expect(first.amountUsd - first.landedUsd).toBeGreaterThanOrEqual(0.3);
  });
});
