import { describe, expect, it } from "vitest";
import type { Outcome } from "../src/sim";
import { compare, median, summarize } from "../src/summary";

const outcome = (o: Partial<Outcome> = {}): Outcome => ({
  liquidated: false,
  liquidatedAt: null,
  rescuesFired: 0,
  rescuesLate: 0,
  reserveUsedUsd: 0,
  reserveExhausted: false,
  pnlUsd: 0,
  ...o,
});

describe("summarize", () => {
  it("works out the liquidation rate as a percentage", () => {
    const summary = summarize([outcome({ liquidated: true }), outcome(), outcome(), outcome()]);
    expect(summary.positions).toBe(4);
    expect(summary.liquidationRate).toBe(25);
  });

  it("measures late rescues against rescues fired", () => {
    const summary = summarize([
      outcome({ rescuesFired: 3, rescuesLate: 1, liquidated: true }),
      outcome({ rescuesFired: 1 }),
    ]);
    expect(summary.rescuesFired).toBe(4);
    expect(summary.rescuesLate).toBe(1);
    expect(summary.lateRate).toBe(25);
  });

  it("averages reserve used over positions that were actually rescued", () => {
    const summary = summarize([outcome({ rescuesFired: 1, reserveUsedUsd: 30 }), outcome({ rescuesFired: 1, reserveUsedUsd: 10 }), outcome()]);
    expect(summary.protectedPositions).toBe(2);
    expect(summary.meanReserveUsedUsd).toBe(20);
    expect(summary.medianReserveUsedUsd).toBe(20);
  });

  it("averages profit and loss over every position", () => {
    expect(summarize([outcome({ pnlUsd: 10 }), outcome({ pnlUsd: -20 })]).meanPnlUsd).toBe(-5);
  });

  it("sorts liquidations by why the rescue didn't save them", () => {
    const summary = summarize([
      outcome({ liquidated: true, rescuesFired: 1, rescuesLate: 1 }),
      outcome({ liquidated: true, rescuesFired: 2, reserveExhausted: true }),
      outcome({ liquidated: true, rescuesFired: 1 }),
      outcome({ liquidated: true }),
      outcome({ rescuesFired: 1 }),
    ]);
    expect(summary.liquidatedLate).toBe(1);
    expect(summary.liquidatedOutOfReserve).toBe(1);
    expect(summary.liquidatedOtherLimit).toBe(2);
  });

  it("has no late rate or reserve figures when nothing fired", () => {
    const summary = summarize([outcome()]);
    expect(summary.lateRate).toBeNull();
    expect(summary.meanReserveUsedUsd).toBeNull();
    expect(summary.medianReserveUsedUsd).toBeNull();
  });
});

describe("compare", () => {
  it("counts positions saved, and positions Lifeline made worse", () => {
    const without = [
      outcome({ liquidated: true, pnlUsd: -80 }), // saved, and better off
      outcome({ liquidated: true, pnlUsd: -80 }), // liquidated anyway, and lost more
      outcome({ liquidated: false, pnlUsd: 5 }), // untouched
      outcome({ liquidated: true, pnlUsd: -80 }), // saved, but closed at a bigger loss
    ];
    const withLifeline = [
      outcome({ liquidated: false, pnlUsd: 10 }),
      outcome({ liquidated: true, pnlUsd: -100 }),
      outcome({ liquidated: false, pnlUsd: 5 }),
      outcome({ liquidated: false, pnlUsd: -90 }),
    ];
    expect(compare(without, withLifeline)).toMatchObject({ saved: 2, liquidatedAnyway: 1, worseOff: 2, betterOff: 1 });
  });

  it("works out what each kind of outcome really cost or earned", () => {
    const without = [
      outcome({ liquidated: true, pnlUsd: -80 }),
      outcome({ liquidated: true, pnlUsd: -80 }),
      outcome({ liquidated: true, pnlUsd: -80 }),
      outcome({ liquidated: true, pnlUsd: -80 }),
    ];
    const withLifeline = [
      outcome({ liquidated: false, pnlUsd: 20 }), // saved: +100
      outcome({ liquidated: false, pnlUsd: -60 }), // saved: +20
      outcome({ liquidated: true, pnlUsd: -130 }), // liquidated anyway: -50
      outcome({ liquidated: true, pnlUsd: -100 }), // liquidated anyway: -20
    ];
    const result = compare(without, withLifeline);
    expect(result.meanChangeWhenSavedUsd).toBe(60);
    expect(result.meanChangeWhenLiquidatedAnywayUsd).toBe(-35);
    expect(result.savedAndBetterOff).toBe(2);
  });

  it("tells a fee apart from a real loss", () => {
    const without = [outcome({ pnlUsd: 5 }), outcome({ pnlUsd: 5 }), outcome({ pnlUsd: 5 })];
    const withLifeline = [outcome({ pnlUsd: 4.68 }), outcome({ pnlUsd: -20 }), outcome({ pnlUsd: 5 })];
    expect(compare(without, withLifeline)).toMatchObject({ worseOff: 2, worseOffByMoreThanFee: 1 });
  });

  it("has no averages for outcomes that never happened", () => {
    expect(compare([outcome()], [outcome()])).toMatchObject({ meanChangeWhenSavedUsd: null, meanChangeWhenLiquidatedAnywayUsd: null });
  });

  it("refuses lists of different lengths, because the runs must be paired", () => {
    expect(() => compare([outcome()], [])).toThrow(/paired/i);
  });
});

describe("median", () => {
  it("finds the middle, odd or even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
