import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data";
import { randomPositions, seededRandom } from "../src/positions";

const HOUR = 3_600_000;
const bars: Bar[] = Array.from({ length: 200 }, (_, i) => ({ t: i * HOUR, o: 100, h: 100, l: 100, c: 100 }));
const options = { count: 500, side: 1 as const, leverage: 10, bars, marginUsd: 100, maintenanceRate: 0.025, holdMs: 24 * HOUR, seed: 1 };

describe("seededRandom", () => {
  it("repeats for the same seed, and differs for another", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
  });

  it("stays between 0 and 1", () => {
    const random = seededRandom(1);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("randomPositions", () => {
  it("makes the number asked for, with the settings asked for", () => {
    const positions = randomPositions(options);
    expect(positions).toHaveLength(500);
    expect(positions[0]).toMatchObject({ side: 1, leverage: 10, marginUsd: 100, maintenanceRate: 0.025, holdMs: 24 * HOUR });
  });

  it("is reproducible", () => {
    expect(randomPositions(options)).toEqual(randomPositions(options));
  });

  it("leaves room for the whole hold after every entry", () => {
    const entries = randomPositions(options).map((p) => p.entryIndex);
    expect(Math.max(...entries)).toBeLessThanOrEqual(200 - 24);
    expect(Math.min(...entries)).toBeGreaterThanOrEqual(0);
  });

  it("spreads entries across the whole window", () => {
    const entries = randomPositions(options).map((p) => p.entryIndex);
    expect(Math.min(...entries)).toBeLessThan(20);
    expect(Math.max(...entries)).toBeGreaterThan(155);
  });

  it("refuses a window shorter than the hold, rather than testing a shorter one", () => {
    expect(() => randomPositions({ ...options, bars: bars.slice(0, 10) })).toThrow(/window/i);
  });
});
