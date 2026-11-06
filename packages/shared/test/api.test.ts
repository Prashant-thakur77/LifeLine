import { describe, expect, it } from "vitest";
import { parseHealthSnapshot, type HealthSnapshot } from "../src/index";

const base: HealthSnapshot = {
  hlAddress: "0x1111111111111111111111111111111111111111",
  accountValue: 100,
  maintenanceMarginUsed: 0,
  health: Number.POSITIVE_INFINITY,
  positions: [],
  at: "2026-11-08T15:00:00.000Z",
};

describe("parseHealthSnapshot", () => {
  it("documents why it exists: JSON turns Infinity into null", () => {
    expect(JSON.parse(JSON.stringify(base)).health).toBeNull();
  });

  it("restores Infinity for an account with no positions", () => {
    const wire = JSON.parse(JSON.stringify(base));
    expect(parseHealthSnapshot(wire).health).toBe(Number.POSITIVE_INFINITY);
  });

  it("leaves a real health number alone", () => {
    const wire = { ...base, maintenanceMarginUsed: 50, health: 1.48 };
    expect(parseHealthSnapshot(wire).health).toBe(1.48);
  });

  it("keeps a health of 0, which is not the same as no positions", () => {
    const wire = { ...base, maintenanceMarginUsed: 50, health: 0 };
    expect(parseHealthSnapshot(wire).health).toBe(0);
  });

  it("does not change the object it was given", () => {
    const wire = { ...base, health: null };
    parseHealthSnapshot(wire);
    expect(wire.health).toBeNull();
  });
});
