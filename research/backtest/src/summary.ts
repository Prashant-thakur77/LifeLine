import type { Outcome } from "./sim";

export type Summary = {
  positions: number;
  liquidated: number;
  liquidationRate: number; // percent
  rescuesFired: number;
  rescuesLate: number;
  lateRate: number | null; // percent of rescues fired, null if none fired
  protectedPositions: number; // positions where at least one rescue fired
  meanReserveUsedUsd: number | null;
  medianReserveUsedUsd: number | null;
  meanPnlUsd: number;
  liquidatedLate: number; // liquidated with a rescue still on its way
  liquidatedOutOfReserve: number; // the reserve ran out first
  liquidatedOtherLimit: number; // reserve left, but a cap or the cooldown held the next rescue back
};

export type Comparison = {
  saved: number; // liquidated without Lifeline, not with it
  savedAndBetterOff: number; // saved, and also finished with more money
  liquidatedAnyway: number;
  betterOff: number; // finished with more money
  worseOff: number; // finished with less money
  worseOffByMoreThanFee: number; // less by more than 1Click's fee: real money went with the position
  meanChangeWhenSavedUsd: number | null;
  meanChangeWhenLiquidatedAnywayUsd: number | null;
};

/** A few rescues' worth of 1Click fees, so a fee doesn't count as losing the top-up. */
const FEE_ONLY_USD = 1;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[Math.floor(mid)]!;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function summarize(outcomes: Outcome[]): Summary {
  const liquidated = outcomes.filter((o) => o.liquidated);
  const rescued = outcomes.filter((o) => o.rescuesFired > 0);
  const rescuesFired = sum(outcomes.map((o) => o.rescuesFired));
  const rescuesLate = sum(outcomes.map((o) => o.rescuesLate));
  const used = rescued.map((o) => o.reserveUsedUsd);
  const late = liquidated.filter((o) => o.rescuesLate > 0);
  const outOfReserve = liquidated.filter((o) => o.rescuesLate === 0 && o.reserveExhausted);

  return {
    positions: outcomes.length,
    liquidated: liquidated.length,
    liquidationRate: (liquidated.length / outcomes.length) * 100,
    rescuesFired,
    rescuesLate,
    lateRate: rescuesFired === 0 ? null : (rescuesLate / rescuesFired) * 100,
    protectedPositions: rescued.length,
    meanReserveUsedUsd: used.length === 0 ? null : sum(used) / used.length,
    medianReserveUsedUsd: median(used),
    meanPnlUsd: sum(outcomes.map((o) => o.pnlUsd)) / outcomes.length,
    liquidatedLate: late.length,
    liquidatedOutOfReserve: outOfReserve.length,
    liquidatedOtherLimit: liquidated.length - late.length - outOfReserve.length,
  };
}

/** Compares runs of the same positions, one by one. */
export function compare(without: Outcome[], withLifeline: Outcome[]): Comparison {
  if (without.length !== withLifeline.length) throw new Error("the runs must be paired, position by position");
  const whenSaved: number[] = [];
  const whenLiquidatedAnyway: number[] = [];
  let betterOff = 0;
  let worseOff = 0;
  let worseOffByMoreThanFee = 0;

  without.forEach((before, i) => {
    const after = withLifeline[i]!;
    const change = after.pnlUsd - before.pnlUsd;
    if (before.liquidated && !after.liquidated) whenSaved.push(change);
    if (before.liquidated && after.liquidated) whenLiquidatedAnyway.push(change);
    if (change > 1e-9) betterOff += 1;
    if (change < -1e-9) worseOff += 1;
    if (change < -FEE_ONLY_USD) worseOffByMoreThanFee += 1;
  });

  const mean = (values: number[]) => (values.length === 0 ? null : sum(values) / values.length);
  return {
    saved: whenSaved.length,
    savedAndBetterOff: whenSaved.filter((change) => change > 1e-9).length,
    liquidatedAnyway: whenLiquidatedAnyway.length,
    betterOff,
    worseOff,
    worseOffByMoreThanFee,
    meanChangeWhenSavedUsd: mean(whenSaved),
    meanChangeWhenLiquidatedAnywayUsd: mean(whenLiquidatedAnyway),
  };
}
