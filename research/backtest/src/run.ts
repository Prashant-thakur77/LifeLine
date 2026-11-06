import type { Bar } from "./data";
import { randomPositions } from "./positions";
import {
  BASE_POLICY,
  COINS,
  DAY_MS,
  FLASH_ADVERSE_MS,
  INTERVAL_MS,
  LEVERAGES,
  MAINTENANCE_RATE,
  MARGIN_USD,
  POSITIONS_PER_CELL,
  seedFor,
  SIDES,
  type Coin,
  type Interval,
  type Run,
} from "./scenario";
import { simulate, type Outcome, type Side, type SimPosition } from "./sim";

export type Latency = { p50Ms: number; p95Ms: number };

export type Cell = {
  coin: Coin;
  leverage: number;
  side: Side;
  bars: Bar[];
  positions: SimPosition[];
  none: Outcome[];
  p50: Outcome[];
  p95: Outcome[];
};

export type RunResult = { run: Run; from: number; to: number; cells: Cell[] };

/** Runs the same positions through all three scenarios, so every comparison is paired. */
export function runGrid(
  run: Run,
  loadBars: (coin: Coin, interval: Interval) => Bar[],
  latency: Latency,
  options: { coins?: readonly Coin[]; leverages?: readonly number[]; count?: number } = {},
): RunResult {
  const { coins = COINS, leverages = LEVERAGES, count = POSITIONS_PER_CELL } = options;
  const barMs = INTERVAL_MS[run.interval];
  const adverseLegMs = run.flash ? FLASH_ADVERSE_MS : undefined;
  const cells: Cell[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = 0;

  for (const coin of coins) {
    const bars = loadBars(coin, run.interval);
    from = Math.min(from, bars[0]?.t ?? from);
    to = Math.max(to, bars.at(-1)?.t ?? to);
    for (const leverage of leverages) {
      for (const side of SIDES) {
        const positions = randomPositions({
          count,
          side,
          leverage,
          bars,
          marginUsd: MARGIN_USD,
          maintenanceRate: MAINTENANCE_RATE[coin],
          holdMs: run.holdDays * DAY_MS,
          seed: seedFor(coin, leverage, side),
        });
        const scenario = (latencyMs: number | null) =>
          positions.map((position) =>
            simulate(position, bars, barMs, latencyMs === null ? null : { ...BASE_POLICY, latencyMs }, adverseLegMs),
          );
        cells.push({
          coin,
          leverage,
          side,
          bars,
          positions,
          none: scenario(null),
          p50: scenario(latency.p50Ms),
          p95: scenario(latency.p95Ms),
        });
      }
    }
  }
  return { run, from, to, cells };
}
