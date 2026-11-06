import type { Bar } from "./data";
import type { Side, SimPosition } from "./sim";

/** mulberry32: small, and the same numbers every run, so the report can be reproduced exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random entry times across the window, each with room left for the whole hold. */
export function randomPositions(options: {
  count: number;
  side: Side;
  leverage: number;
  bars: Bar[];
  marginUsd: number;
  maintenanceRate: number;
  holdMs: number;
  seed: number;
}): SimPosition[] {
  const { count, side, leverage, bars, marginUsd, maintenanceRate, holdMs, seed } = options;
  const lastT = (bars.at(-1)?.t ?? 0) - holdMs;
  const lastEntry = bars.findLastIndex((bar) => bar.t <= lastT);
  if (lastEntry < 0) throw new Error("the candle window is shorter than the hold");

  const random = seededRandom(seed);
  return Array.from({ length: count }, () => ({
    side,
    leverage,
    entryIndex: Math.floor(random() * (lastEntry + 1)),
    marginUsd,
    maintenanceRate,
    holdMs,
  }));
}
