import type { HealthResponse } from "@lifeline/shared";
import { fixtures } from "@lifeline/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  DIAL,
  SIM_STALE_AFTER_MS,
  STALE_AFTER_MS,
  classifyHealth,
  cushionUsd,
  dialArc,
  dialBands,
  dialPoint,
  healthToFraction,
  rescueNeededUsd,
} from "../src/lib/gauge";
import { simRestCountdown } from "../src/lib/sim";

// The fixtures are all read at 15:00:00.
const AT = Date.parse("2026-11-08T15:00:00.000Z");
const fresh = AT + 3_000;

const withPolicy = (response: HealthResponse, patch: Partial<HealthResponse["policy"]>): HealthResponse => ({
  ...response,
  policy: { ...response.policy, ...patch },
});

describe("healthToFraction", () => {
  it("runs from liquidation at 1.0 to 4.0 on a log scale", () => {
    expect(healthToFraction(1)).toBe(0);
    expect(healthToFraction(2)).toBeCloseTo(0.5, 10);
    expect(healthToFraction(4)).toBe(1);
  });
  it("gives the decision range most of the arc", () => {
    const span = healthToFraction(2.5) - healthToFraction(1.2);
    expect(span).toBeGreaterThan(0.5);
  });
  it("pins out-of-range values to the ends", () => {
    expect(healthToFraction(0.4)).toBe(0);
    expect(healthToFraction(9)).toBe(1);
    expect(healthToFraction(Number.POSITIVE_INFINITY)).toBe(1);
    expect(healthToFraction(Number.NaN)).toBe(0);
  });
  it("grows with health", () => {
    const values = [1.1, 1.3, 1.5, 1.8, 2, 3].map(healthToFraction);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});

describe("classifyHealth", () => {
  it("reads safe, warn and below-trigger fixtures into the right zones", () => {
    expect(classifyHealth(fixtures.healthSafe, fresh)).toMatchObject({ zone: "safe", health: 2.4, headline: "Safe" });
    expect(classifyHealth(fixtures.healthWarn, fresh)).toMatchObject({ zone: "warn", health: 1.62, headline: "Watch" });
    expect(classifyHealth(fixtures.healthBelowTrigger, fresh)).toMatchObject({ zone: "rescue", health: 1.48, headline: "Rescue zone" });
  });

  it("never shows unknown as safe", () => {
    const reading = classifyHealth(fixtures.healthUnknown, fresh);
    expect(reading.zone).toBe("unknown");
    expect(reading.health).toBeNull();
    expect(reading.detail).toMatch(/Don't treat it as safe/);
    expect(classifyHealth(null, fresh).zone).toBe("unknown");
  });

  it("treats an ok status without a snapshot as unknown", () => {
    expect(classifyHealth({ ...fixtures.healthSafe, snapshot: null }, fresh).zone).toBe("unknown");
  });

  it("shows no positions as its own state, with health ∞", () => {
    const reading = classifyHealth(fixtures.healthNoPositions, fresh);
    expect(reading.zone).toBe("none");
    expect(reading.health).toBe(Number.POSITIVE_INFINITY);
  });

  it("treats positions with no maintenance margin (isolated only) as unknown, not safe", () => {
    const isolated: HealthResponse = {
      ...fixtures.healthSafe,
      snapshot: { ...fixtures.healthSafe.snapshot!, maintenanceMarginUsed: 0, health: null },
    };
    expect(classifyHealth(isolated, fresh)).toMatchObject({ zone: "unknown", health: null });
  });

  it("marks an old reading stale and draws no health for it", () => {
    const reading = classifyHealth(fixtures.healthSafe, AT + STALE_AFTER_MS + 1);
    expect(reading).toMatchObject({ zone: "stale", health: null });
    expect(reading.detail).toMatch(/1 min ago/);
    expect(classifyHealth(fixtures.healthSafe, AT + STALE_AFTER_MS).zone).toBe("safe");
  });

  it("gives the sim, which rests 15 minutes between drops, a longer window", () => {
    const tenMinutesLater = AT + 10 * 60_000;
    expect(classifyHealth(fixtures.healthSafe, tenMinutesLater).zone).toBe("stale");
    expect(classifyHealth(fixtures.healthSafe, tenMinutesLater, SIM_STALE_AFTER_MS).zone).toBe("safe");
    expect(classifyHealth(fixtures.healthSafe, AT + SIM_STALE_AFTER_MS + 1, SIM_STALE_AFTER_MS).zone).toBe("stale");
  });

  it("marks a reading stale when the keeper has gone quiet, by this browser's clock alone", () => {
    // A clock running behind would make the reading look fresh; the silence still shows.
    const receivedAt = fresh - STALE_AFTER_MS - 1;
    const reading = classifyHealth(fixtures.healthSafe, fresh, STALE_AFTER_MS, receivedAt);
    expect(reading).toMatchObject({ zone: "stale", health: null });
    expect(reading.detail).toMatch(/hasn't answered/);
    expect(classifyHealth(fixtures.healthSafe, fresh, STALE_AFTER_MS, fresh - 5_000).zone).toBe("safe");
  });

  it("refuses a reading stamped well in the future", () => {
    expect(classifyHealth(fixtures.healthSafe, AT - STALE_AFTER_MS - 1).zone).toBe("stale");
    expect(classifyHealth(fixtures.healthSafe, AT - 5_000).zone).toBe("safe");
  });

  it("marks an unreadable timestamp stale", () => {
    const bad: HealthResponse = { ...fixtures.healthSafe, snapshot: { ...fixtures.healthSafe.snapshot!, at: "yesterday" } };
    expect(classifyHealth(bad, fresh).zone).toBe("stale");
  });

  it("follows the user's own levels, not the defaults", () => {
    const careful = withPolicy(fixtures.healthSafe, { warn: 2.6, trigger: 2.5, target: 3 });
    expect(classifyHealth(careful, fresh).zone).toBe("rescue");
    const tight = withPolicy(fixtures.healthBelowTrigger, { warn: 1.5, trigger: 1.3, target: 1.6 });
    expect(classifyHealth(tight, fresh).zone).toBe("warn");
  });

  it("puts a trigger-level reading at warn, not rescue: rescue is strictly below", () => {
    const atTrigger: HealthResponse = { ...fixtures.healthWarn, snapshot: { ...fixtures.healthWarn.snapshot!, health: 1.5 } };
    expect(classifyHealth(atTrigger, fresh).zone).toBe("warn");
  });

  it("calls out liquidation", () => {
    const gone: HealthResponse = { ...fixtures.healthBelowTrigger, snapshot: { ...fixtures.healthBelowTrigger.snapshot!, health: 0.98 } };
    expect(classifyHealth(gone, fresh)).toMatchObject({ zone: "liquidation", headline: "At liquidation" });
  });

  it("says when rescues are paused", () => {
    const paused = withPolicy(fixtures.healthBelowTrigger, { paused: true });
    const reading = classifyHealth(paused, fresh);
    expect(reading).toMatchObject({ zone: "rescue", paused: true, headline: "Below trigger, paused" });
    expect(reading.detail).toMatch(/paused/);
    expect(classifyHealth(withPolicy(fixtures.healthSafe, { paused: true }), fresh).headline).toBe("Safe, paused");
  });
});

describe("simRestCountdown", () => {
  const now = Date.parse("2026-11-08T13:10:23.000Z");
  it("counts down to the next drop while the sim rests", () => {
    expect(simRestCountdown("2026-11-08T13:19:18.411Z", now)).toBe("8:56");
  });
  it("says nothing during a drop, or without a time", () => {
    expect(simRestCountdown("2026-11-08T13:11:00.000Z", now)).toBeNull();
    expect(simRestCountdown(null, now)).toBeNull();
    expect(simRestCountdown("soon", now)).toBeNull();
  });
});

describe("cushion and rescue size", () => {
  const snapshot = { accountValue: 81.6, maintenanceMarginUsed: 34 };
  it("says how much can be lost before a level", () => {
    expect(cushionUsd(snapshot, 1.5)).toBeCloseTo(30.6, 10);
    expect(cushionUsd(snapshot, 1)).toBeCloseTo(47.6, 10);
    expect(cushionUsd({ accountValue: 50, maintenanceMarginUsed: 34 }, 1.5)).toBeLessThan(0);
  });
  it("sizes a rescue as target × MMU − account value, never negative", () => {
    expect(rescueNeededUsd({ accountValue: 50.32, maintenanceMarginUsed: 34 }, 2)).toBeCloseTo(17.68, 10);
    expect(rescueNeededUsd(snapshot, 2)).toBe(0);
  });
});

describe("dial geometry", () => {
  it("starts at the lower left and ends at the lower right of a 240° arc", () => {
    const start = dialPoint(DIAL, 0);
    const end = dialPoint(DIAL, 1);
    expect(start.x).toBeLessThan(DIAL.cx);
    expect(end.x).toBeGreaterThan(DIAL.cx);
    expect(start.y).toBeCloseTo(end.y, 10);
    expect(start.y).toBeGreaterThan(DIAL.cy);
    const top = dialPoint(DIAL, 0.5);
    expect(top.x).toBeCloseTo(DIAL.cx, 10);
    expect(top.y).toBeCloseTo(DIAL.cy - DIAL.r, 10);
  });
  it("draws long arcs with the large-arc flag", () => {
    expect(dialArc(DIAL, 0, 1)).toMatch(/ A 128 128 0 1 1 /);
    expect(dialArc(DIAL, 0, 0.5)).toMatch(/ A 128 128 0 0 1 /);
  });
  it("splits the dial into rescue, warn and safe bands at the user's levels", () => {
    const bands = dialBands({ warn: 1.8, trigger: 1.5 });
    expect(bands.map((b) => b.zone)).toEqual(["rescue", "warn", "safe"]);
    expect(bands[0]!.from).toBe(0);
    expect(bands[0]!.to).toBeCloseTo(healthToFraction(1.5), 10);
    expect(bands[1]!.to).toBeCloseTo(healthToFraction(1.8), 10);
    expect(bands[2]!.to).toBe(1);
  });
});
