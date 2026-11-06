import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data";
import { barPath, priceAt, simulate, type SimPolicy, type SimPosition } from "../src/sim";

const HOUR = 3_600_000;

const flat = (t: number, price: number): Bar => ({ t, o: price, h: price, l: price, c: price });
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });

/** 100 USDC at 10× on a 100 coin: 10 coins, 1,000 notional, 2.5% maintenance. */
const position = (o: Partial<SimPosition> = {}): SimPosition => ({
  side: 1,
  leverage: 10,
  entryIndex: 0,
  marginUsd: 100,
  maintenanceRate: 0.025,
  holdMs: 10 * HOUR,
  ...o,
});

const policy = (o: Partial<SimPolicy> = {}): SimPolicy => ({
  trigger: 1.5,
  target: 2,
  maxPerRescueUsd: 25,
  maxPerDayUsd: 50,
  cooldownMs: 120_000,
  reserveUsd: 50,
  feeUsd: 0.3153,
  spreadRate: 0.00011,
  minSendUsd: 2,
  latencyMs: 30_000,
  pollMs: 5_000,
  ...o,
});

/*
 * On that position: equity = 100 + 10 (p − 100), maintenance = 0.25 p.
 * Health 1.5 is at p ≈ 93.51, and liquidation (health 1) at p ≈ 92.31.
 */
describe("barPath", () => {
  it("visits the adverse extreme first for a long", () => {
    const points = barPath(bar(0, 100, 110, 90, 105), HOUR, 1);
    expect(points.map((p) => p.price)).toEqual([100, 90, 110, 105]);
  });

  it("visits the adverse extreme first for a short", () => {
    const points = barPath(bar(0, 100, 110, 90, 105), HOUR, -1);
    expect(points.map((p) => p.price)).toEqual([100, 110, 90, 105]);
  });

  it("moves at an even pace by default, across the whole bar", () => {
    const points = barPath(bar(0, 100, 110, 90, 100), 40 * 60_000, 1);
    // Path length 10 + 20 + 10 = 40, so 1 of price per minute.
    expect(points.map((p) => p.t)).toEqual([0, 10 * 60_000, 30 * 60_000, 40 * 60_000]);
  });

  it("squeezes the adverse move into a flash when asked", () => {
    const points = barPath(bar(0, 100, 110, 90, 100), HOUR, 1, 60_000);
    expect(points[1]).toEqual({ t: 60_000, price: 90 });
    expect(points.at(-1)?.t).toBe(HOUR);
  });

  it("copes with a bar where the price never moved", () => {
    const points = barPath(flat(0, 100), HOUR, 1);
    expect(priceAt(points, HOUR / 2)).toBe(100);
  });
});

describe("priceAt", () => {
  const points = [
    { t: 0, price: 100 },
    { t: 10, price: 90 },
    { t: 20, price: 110 },
  ];

  it("interpolates along a leg", () => {
    expect(priceAt(points, 5)).toBe(95);
    expect(priceAt(points, 15)).toBe(100);
  });

  it("stays at the ends outside the path", () => {
    expect(priceAt(points, -1)).toBe(100);
    expect(priceAt(points, 99)).toBe(110);
  });
});

describe("with no protection", () => {
  it("survives if the price stays above liquidation", () => {
    const bars = [bar(0, 100, 100, 93, 95), flat(HOUR, 95)];
    const outcome = simulate(position(), bars, HOUR, null);
    expect(outcome.liquidated).toBe(false);
    expect(outcome.rescuesFired).toBe(0);
  });

  it("is liquidated when the price reaches the liquidation level", () => {
    const bars = [bar(0, 100, 100, 92, 92), flat(HOUR, 92)];
    const outcome = simulate(position(), bars, HOUR, null);
    expect(outcome.liquidated).toBe(true);
    expect(outcome.liquidatedAt).toBeLessThan(HOUR);
  });

  it("gets the mirror image right for a short", () => {
    // Short: equity = 100 − 10 (p − 100), maintenance = 0.25 p. Liquidation is at p ≈ 107.3.
    const up = [bar(0, 100, 108, 100, 108), flat(HOUR, 108)];
    const down = [bar(0, 100, 100, 80, 80), flat(HOUR, 80)];
    expect(simulate(position({ side: -1 }), up, HOUR, null).liquidated).toBe(true);
    expect(simulate(position({ side: -1 }), down, HOUR, null).liquidated).toBe(false);
  });

  it("only counts bars during the hold", () => {
    const bars = [flat(0, 100), flat(HOUR, 100), bar(2 * HOUR, 100, 100, 50, 50)];
    expect(simulate(position({ holdMs: 2 * HOUR }), bars, HOUR, null).liquidated).toBe(false);
    expect(simulate(position({ holdMs: 3 * HOUR }), bars, HOUR, null).liquidated).toBe(true);
  });

  it("enters at the entry bar's open", () => {
    const bars = [bar(0, 50, 50, 50, 50), flat(HOUR, 100), flat(2 * HOUR, 100)];
    const outcome = simulate(position({ entryIndex: 1, holdMs: HOUR }), bars, HOUR, null);
    expect(outcome.pnlUsd).toBeCloseTo(0);
  });

  it("works out profit and loss", () => {
    const bars = [flat(0, 110), flat(HOUR, 110)];
    const up = [flat(0, 100), bar(HOUR, 100, 110, 100, 110)];
    expect(simulate(position({ holdMs: HOUR }), bars, HOUR, null).pnlUsd).toBeCloseTo(0);
    expect(simulate(position({ holdMs: 2 * HOUR }), up, HOUR, null).pnlUsd).toBeCloseTo(100);
  });

  it("leaves the remaining collateral with the trader when liquidated, as Hyperliquid's docs say", () => {
    const bars = [bar(0, 100, 100, 80, 80)];
    const outcome = simulate(position({ holdMs: HOUR }), bars, HOUR, null);
    // Maintenance at about 92.3 is about 23, so about 77 of the 100 is lost.
    expect(outcome.pnlUsd).toBeGreaterThan(-80);
    expect(outcome.pnlUsd).toBeLessThan(-75);
  });
});

describe("with Lifeline", () => {
  it("does nothing while health stays above the trigger", () => {
    const bars = [bar(0, 100, 100, 94, 95), flat(HOUR, 95)];
    const outcome = simulate(position(), bars, HOUR, policy());
    expect(outcome.rescuesFired).toBe(0);
    expect(outcome.reserveUsedUsd).toBe(0);
    expect(outcome.liquidated).toBe(false);
  });

  it("saves a position that would be liquidated by a slow slide", () => {
    const bars = [bar(0, 100, 100, 92, 92), flat(HOUR, 92), flat(2 * HOUR, 92)];
    expect(simulate(position(), bars, HOUR, null).liquidated).toBe(true);
    const outcome = simulate(position(), bars, HOUR, policy());
    expect(outcome.liquidated).toBe(false);
    expect(outcome.rescuesFired).toBeGreaterThanOrEqual(1);
    expect(outcome.rescuesLate).toBe(0);
    expect(outcome.reserveUsedUsd).toBeGreaterThan(0);
  });

  it("sends (needed + fee) × 1.01, cut to the per-rescue cap", () => {
    // At health 1.5 with maintenance about 23.3, needed to reach 2 is about 11.7.
    const bars = [bar(0, 100, 100, 93.3, 93.3)];
    const outcome = simulate(position({ holdMs: HOUR }), bars, HOUR, policy());
    expect(outcome.rescuesFired).toBe(1);
    expect(outcome.reserveUsedUsd).toBeGreaterThan(11);
    expect(outcome.reserveUsedUsd).toBeLessThan(13);

    const capped = simulate(position({ holdMs: HOUR }), bars, HOUR, policy({ maxPerRescueUsd: 5 }));
    expect(capped.reserveUsedUsd).toBe(5);
  });

  it("counts a rescue as too late when liquidation beats its arrival", () => {
    // Drops through trigger and liquidation in one minute, against a 10-minute arrival.
    const bars = [bar(0, 100, 100, 80, 80)];
    const outcome = simulate(position({ holdMs: HOUR }), bars, HOUR, policy({ latencyMs: 600_000 }), 60_000);
    expect(outcome.rescuesFired).toBe(1);
    expect(outcome.rescuesLate).toBe(1);
    expect(outcome.liquidated).toBe(true);
  });

  it("keeps money that arrives too late, so it isn't counted as lost twice", () => {
    const bars = [bar(0, 100, 100, 80, 80)];
    const outcome = simulate(position({ holdMs: HOUR }), bars, HOUR, policy({ latencyMs: 600_000 }), 60_000);
    const unprotected = simulate(position({ holdMs: HOUR }), bars, HOUR, null, 60_000);
    // The only extra loss is the 1Click fee and spread, not the whole rescue.
    expect(outcome.pnlUsd - unprotected.pnlUsd).toBeGreaterThan(-1);
    expect(outcome.pnlUsd - unprotected.pnlUsd).toBeLessThan(0);
  });

  it("waits for the cooldown between rescues", () => {
    const bars = [bar(0, 100, 100, 92.5, 92.5), flat(HOUR, 92.5)];
    const fast = simulate(position(), bars, HOUR, policy({ maxPerRescueUsd: 2.5, cooldownMs: 30_000, latencyMs: 1_000 }));
    const slow = simulate(position(), bars, HOUR, policy({ maxPerRescueUsd: 2.5, cooldownMs: 3_600_000, latencyMs: 1_000 }));
    expect(slow.rescuesFired).toBeLessThan(fast.rescuesFired);
  });

  it("stops at the daily cap, even with reserve left", () => {
    const bars = [bar(0, 100, 100, 88, 88), flat(HOUR, 88), flat(2 * HOUR, 88)];
    const outcome = simulate(position(), bars, HOUR, policy({ maxPerDayUsd: 10, maxPerRescueUsd: 5, reserveUsd: 500 }));
    expect(outcome.reserveUsedUsd).toBeLessThanOrEqual(10);
  });

  it("lets the daily cap refill after 24 hours", () => {
    const slide = (t: number, price: number) => flat(t, price);
    const bars = [bar(0, 100, 100, 93, 93), ...Array.from({ length: 30 }, (_, i) => slide((i + 1) * HOUR, 93 - i * 0.01))];
    const outcome = simulate(
      position({ holdMs: 30 * HOUR }),
      bars,
      HOUR,
      policy({ maxPerRescueUsd: 2, maxPerDayUsd: 2, target: 3, reserveUsd: 500 }),
    );
    expect(outcome.rescuesFired).toBeGreaterThanOrEqual(2);
  });

  const slowSlide = Array.from({ length: 20 }, (_, i) => bar(i * HOUR, 100 - i, 100 - i, 99 - i, 99 - i));

  it("runs out of reserve in a slow slide, and is liquidated after spending it all", () => {
    const outcome = simulate(position({ holdMs: 20 * HOUR }), slowSlide, HOUR, policy({ reserveUsd: 20 }));
    expect(outcome.liquidated).toBe(true);
    expect(outcome.rescuesFired).toBe(2);
    expect(outcome.reserveUsedUsd).toBeCloseTo(20);
    expect(outcome.reserveExhausted).toBe(true);
  });

  it("can't get a second rescue in before a fast slide finishes, because of the cooldown", () => {
    const fast = [bar(0, 100, 100, 70, 70), flat(HOUR, 70)];
    const outcome = simulate(position({ holdMs: 2 * HOUR }), fast, HOUR, policy({ reserveUsd: 50 }));
    expect(outcome.liquidated).toBe(true);
    expect(outcome.rescuesFired).toBe(1);
    expect(outcome.reserveExhausted).toBe(false);
  });

  it("loses more than no protection when the money only delays the end", () => {
    const bars = [bar(0, 100, 100, 70, 70), flat(HOUR, 70)];
    const withLifeline = simulate(position({ holdMs: 2 * HOUR }), bars, HOUR, policy({ latencyMs: 1_000 }));
    const without = simulate(position({ holdMs: 2 * HOUR }), bars, HOUR, null);
    expect(withLifeline.liquidated).toBe(true);
    expect(without.liquidated).toBe(true);
    expect(withLifeline.pnlUsd).toBeLessThan(without.pnlUsd);
  });

  it("doesn't fire on a reserve too small for 1Click to accept", () => {
    const bars = [bar(0, 100, 100, 92.5, 92.5), flat(HOUR, 92.5)];
    const outcome = simulate(position(), bars, HOUR, policy({ reserveUsd: 1 }));
    expect(outcome.rescuesFired).toBe(0);
  });

  it("is a deterministic pure function", () => {
    const bars = [bar(0, 100, 100, 90, 95), bar(HOUR, 95, 96, 88, 90)];
    expect(simulate(position(), bars, HOUR, policy())).toEqual(simulate(position(), bars, HOUR, policy()));
  });
});
