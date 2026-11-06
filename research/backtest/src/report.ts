import { barChart } from "./chart";
import { BASE_POLICY, LEVERAGES, MARGIN_USD, POSITIONS_PER_CELL, RESERVE_USD } from "./scenario";
import type { Cell, Latency, RunResult } from "./run";
import type { Outcome } from "./sim";
import { compare, summarize } from "./summary";

export type LatencyInfo = Latency & { measured: boolean; source: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const moment = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export const pct = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(1)}%`);
export const usd = (value: number | null) => {
  if (value === null) return "n/a";
  const fixed = Math.abs(value).toFixed(2);
  return value < 0 ? `-$${fixed}` : `$${fixed}`;
};
const count = (value: number) => value.toLocaleString("en-US");
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export function markdownTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

type Scenario = "none" | "p50" | "p95";
const pool = (cells: Cell[], scenario: Scenario): Outcome[] => cells.flatMap((cell) => cell[scenario]);

const byLeverage = (cells: Cell[], leverage: number) => cells.filter((cell) => cell.leverage === leverage);

function rateRows(cells: Cell[], keys: { label: string; cells: Cell[] }[]): string[][] {
  return [...keys, { label: "All", cells }].map(({ label, cells: group }) => [
    label,
    ...(["none", "p50", "p95"] as const).map((scenario) => pct(summarize(pool(group, scenario)).liquidationRate)),
  ]);
}

export type Failure = { cell: Cell; index: number };

/** The position that lost the most by using Lifeline, among those matching a test. */
export function worstFailure(cells: Cell[], scenario: "p50" | "p95", matches: (outcome: Outcome, without: Outcome) => boolean): Failure | null {
  let worst: Failure | null = null;
  let worstGap = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    cell[scenario].forEach((outcome, index) => {
      const without = cell.none[index]!;
      if (!matches(outcome, without)) return;
      const gap = without.pnlUsd - outcome.pnlUsd;
      if (gap > worstGap) {
        worstGap = gap;
        worst = { cell, index };
      }
    });
  }
  return worst;
}

function describeFailure(failure: Failure | null, scenario: "p50" | "p95", latencyMs: number): string {
  if (failure === null) return "No position in this run failed this way.";
  const { cell, index } = failure;
  const position = cell.positions[index]!;
  const entry = cell.bars[position.entryIndex]!;
  const outcome = cell[scenario][index]!;
  const without = cell.none[index]!;
  const side = position.side > 0 ? "long" : "short";
  const at = outcome.liquidatedAt ?? 0;
  const bar = cell.bars.findLast((candidate) => candidate.t <= at)!;
  const extreme = position.side > 0 ? bar.l : bar.h;
  const word = position.side > 0 ? "low" : "high";

  return [
    `${cell.coin} ${position.leverage}× ${side}, opened ${moment(entry.t)} at $${entry.o.toLocaleString("en-US")} with ${usd(MARGIN_USD)} margin and ${usd(RESERVE_USD)} reserve.`,
    `The candle that ended it opened ${moment(bar.t)} and reached a ${word} of $${extreme.toLocaleString("en-US")}.`,
    `Lifeline fired ${outcome.rescuesFired} rescue${outcome.rescuesFired === 1 ? "" : "s"} at ${seconds(latencyMs)} latency, spent ${usd(outcome.reserveUsedUsd)} of the reserve, and the position was still liquidated.`,
    `Result: ${usd(outcome.pnlUsd)} with Lifeline, ${usd(without.pnlUsd)} without.`,
  ].join(" ");
}

export function buildReport(runs: RunResult[], latency: LatencyInfo): { markdown: string; charts: Record<string, string> } {
  const find = (id: string) => {
    const found = runs.find((run) => run.run.id === id);
    if (!found) throw new Error(`missing run ${id}`);
    return found;
  };
  const primary = find("primary");
  const flash = find("primary-flash");
  const { cells } = primary;
  const window = `${day(primary.from)} to ${day(primary.to)}`;

  const none = summarize(pool(cells, "none"));
  const p50 = summarize(pool(cells, "p50"));
  const p95 = summarize(pool(cells, "p95"));
  const flashNone = summarize(pool(flash.cells, "none"));
  const flashP50 = summarize(pool(flash.cells, "p50"));
  const flashP95 = summarize(pool(flash.cells, "p95"));
  const pairedP50 = compare(pool(cells, "none"), pool(cells, "p50"));
  const pairedP95 = compare(pool(cells, "none"), pool(cells, "p95"));

  const leverageKeys = (group: Cell[]) => LEVERAGES.map((leverage) => ({ label: `${leverage}×`, cells: byLeverage(group, leverage) }));
  const coins = [...new Set(cells.map((cell) => cell.coin))];
  const coinKeys = coins.map((coin) => ({ label: coin, cells: cells.filter((cell) => cell.coin === coin) }));
  const headers = ["", "No protection", `Lifeline, p50 (${seconds(latency.p50Ms)})`, `Lifeline, p95 (${seconds(latency.p95Ms)})`];

  const seriesNames = ["No protection", `Lifeline, ${seconds(latency.p50Ms)} latency`, `Lifeline, ${seconds(latency.p95Ms)} latency`];
  const chartGroups = (group: Cell[]) =>
    LEVERAGES.map((leverage) => ({
      label: `${leverage}×`,
      values: (["none", "p50", "p95"] as const).map((scenario) => summarize(pool(byLeverage(group, leverage), scenario)).liquidationRate),
    }));
  const maxValue = Math.ceil(
    Math.max(...[...chartGroups(cells), ...chartGroups(flash.cells)].flatMap((group) => group.values), 1),
  );
  const charts = {
    "liquidation-rate.svg": barChart({
      title: "Liquidation rate by leverage",
      subtitle: `Percent of positions liquidated within 7 days, real 4h candles, ${window}`,
      series: seriesNames,
      groups: chartGroups(cells),
      maxValue,
      unit: "%",
    }),
    "liquidation-rate-flash.svg": barChart({
      title: "The same positions in a flash-crash stress test",
      subtitle: "Each candle's adverse move is squeezed into one minute",
      series: seriesNames,
      groups: chartGroups(flash.cells),
      maxValue,
      unit: "%",
    }),
  };

  const rescueRows = [...leverageKeys(cells), { label: "All", cells }].map(({ label, cells: group }) => {
    const a = summarize(pool(group, "p50"));
    const b = summarize(pool(group, "p95"));
    return [
      label,
      count(a.rescuesFired),
      pct(a.lateRate),
      pct(b.lateRate),
      usd(a.meanReserveUsedUsd),
      usd(a.medianReserveUsedUsd),
    ];
  });

  const flashRescueRows = [...leverageKeys(flash.cells), { label: "All", cells: flash.cells }].map(({ label, cells: group }) => {
    const a = summarize(pool(group, "p50"));
    const b = summarize(pool(group, "p95"));
    return [label, count(a.rescuesFired), pct(a.lateRate), pct(b.lateRate)];
  });

  const whyRows = (
    [
      ["Even pace, p50", p50],
      ["Even pace, p95", p95],
      ["Flash crash, p50", flashP50],
      ["Flash crash, p95", flashP95],
    ] as const
  ).map(([label, s]) => [label, count(s.liquidated), count(s.liquidatedLate), count(s.liquidatedOutOfReserve), count(s.liquidatedOtherLimit)]);

  const sensitivityRows = runs.map(({ run, from, to, cells: group }) => {
    const a = summarize(pool(group, "none"));
    const b = summarize(pool(group, "p50"));
    const c = summarize(pool(group, "p95"));
    return [run.label, `${day(from)} to ${day(to)}`, pct(a.liquidationRate), pct(b.liquidationRate), pct(c.liquidationRate), pct(b.lateRate), pct(c.lateRate)];
  });

  const outOfReserve = worstFailure(cells, "p50", (o, w) => o.liquidated && w.liquidated && o.reserveExhausted && o.rescuesLate === 0);
  const heldBack = worstFailure(cells, "p50", (o, w) => o.liquidated && w.liquidated && !o.reserveExhausted && o.rescuesLate === 0 && o.rescuesFired > 0);
  const tooLate = worstFailure(flash.cells, "p50", (o) => o.rescuesLate > 0 && o.rescuesFired === 1);

  const totalPositions = none.positions;
  const finest = find("1m");
  const finestP50 = summarize(pool(finest.cells, "p50"));
  const finestP95 = summarize(pool(finest.cells, "p95"));
  const costsOnAverage = p50.meanPnlUsd < none.meanPnlUsd;

  const markdown = `# Backtest results

Generated by \`pnpm backtest\` from the candles saved in \`candles/\`. Don't edit this file by hand: rerun the command.

**${latency.measured ? "Latency is measured." : "Latency is assumed, not measured yet."}** ${latency.source}

## The result

On ${count(totalPositions)} random BTC, ETH and SOL positions, using real Hyperliquid 4h candles from ${window}, each held for 7 days:

- **Without protection, ${pct(none.liquidationRate)} were liquidated. With Lifeline, ${pct(p50.liquidationRate)} at ${seconds(latency.p50Ms)} latency and ${pct(p95.liquidationRate)} at ${seconds(latency.p95Ms)}.**
- **If every candle's adverse move takes one minute, a stress test harsher than most real markets, those become ${pct(flashNone.liquidationRate)}, ${pct(flashP50.liquidationRate)} and ${pct(flashP95.liquidationRate)}.** The real figure sits between the two runs.
- **On average, Lifeline ${costsOnAverage ? "costs money, because it buys survival, not profit" : "didn't cost money in this run"}: ${usd(none.meanPnlUsd)} per position without it, ${usd(p50.meanPnlUsd)} with it.** When it saved a position, that position finished ${usd(pairedP50.meanChangeWhenSavedUsd)} better on average. When the position was liquidated anyway, it finished ${usd(pairedP50.meanChangeWhenLiquidatedAnywayUsd)} on average against no protection, because the reserve went with it. ${count(pairedP50.worseOffByMoreThanFee)} of ${count(totalPositions)} positions lost more than the fee this way.

![Liquidation rate by leverage](charts/liquidation-rate.svg)

${markdownTable(headers, rateRows(cells, leverageKeys(cells)))}

By coin:

${markdownTable(headers, rateRows(cells, coinKeys))}

## Rescues and the reserve

Each position has ${usd(MARGIN_USD)} margin and a ${usd(RESERVE_USD)} reserve (50% of margin), with the default caps of ${usd(BASE_POLICY.maxPerRescueUsd)} per rescue and ${usd(BASE_POLICY.maxPerDayUsd)} per day.

${markdownTable(["Leverage", "Rescues fired (p50)", "Too late (p50)", "Too late (p95)", "Reserve used per rescued position, mean", "Median"], rescueRows)}

"Too late" means the position was liquidated while a rescue was still on its way. **On 4h candles this number is too low by construction**, because a 4h candle can't show how fast the price moved inside it. The closest thing to real speed is 1m candles, where ${pct(finestP50.lateRate)} of rescues were too late at ${seconds(latency.p50Ms)} and ${pct(finestP95.lateRate)} at ${seconds(latency.p95Ms)}, but those cover only ${day(finest.from)} to ${day(finest.to)}, so they say little about crashes. The next section tests a crash directly.

## Flash-crash stress test

Candles hide speed, so this run makes the opposite assumption: every candle's adverse move happens in its first minute. That's harsher than most real markets, so read it as a bound on how much speed can hurt, not as a forecast. At that pace the fall from trigger to liquidation usually takes only seconds, so a rescue rarely gets there first, and the gap between the two latencies matters less than the crash itself.

![Flash-crash stress test](charts/liquidation-rate-flash.svg)

${markdownTable(headers, rateRows(flash.cells, leverageKeys(flash.cells)))}

${markdownTable(["Leverage", "Rescues fired (p50)", "Too late (p50)", "Too late (p95)"], flashRescueRows)}

## Why rescued positions still got liquidated

${markdownTable(["Run", "Liquidated", "Rescue still on its way", "Reserve ran out", "Reserve left, but a cap or the cooldown held the next rescue back"], whyRows)}

## Honest failure cases

Real positions from these runs where Lifeline didn't help.

**The reserve ran out in a falling market.** ${describeFailure(outOfReserve, "p50", latency.p50Ms)}

**A cap or the cooldown held the next rescue back.** ${describeFailure(heldBack, "p50", latency.p50Ms)}

**The crash beat the rescue (flash stress test).** ${describeFailure(tooLate, "p50", latency.p50Ms)}

## How much the answer depends on our choices

${markdownTable(["Run", "Window", "No protection", "Lifeline p50", "Lifeline p95", "Too late, p50", "Too late, p95"], sensitivityRows)}

Paired counts for the headline run, out of ${count(totalPositions)} positions:

${markdownTable(["", "Saved from liquidation", "Saved and finished with more money", "Liquidated anyway", "Finished with more money", "Finished with less", "Less by more than the fee"], [
  [`Lifeline, p50`, count(pairedP50.saved), count(pairedP50.savedAndBetterOff), count(pairedP50.liquidatedAnyway), count(pairedP50.betterOff), count(pairedP50.worseOff), count(pairedP50.worseOffByMoreThanFee)],
  [`Lifeline, p95`, count(pairedP95.saved), count(pairedP95.savedAndBetterOff), count(pairedP95.liquidatedAnyway), count(pairedP95.betterOff), count(pairedP95.worseOff), count(pairedP95.worseOffByMoreThanFee)],
])}

## Method

- **Positions:** ${count(POSITIONS_PER_CELL)} per coin, leverage (5×, 10×, 20×) and side, so ${count(totalPositions)} per run, with seeded random entry times. Each scenario runs the same positions.
- **Health:** equity divided by maintenance margin, on a single cross position. Maintenance is half the initial margin at max leverage, per Hyperliquid's docs: 1.25% for BTC, 2% for ETH and 2.5% for SOL.
- **Rescue:** the keeper's own rules. It looks every ${seconds(BASE_POLICY.pollMs)}, fires below health ${BASE_POLICY.trigger}, sends \`(needed + fee) × 1.01\` to reach health ${BASE_POLICY.target}, cut to the caps and reserve, waits ${seconds(BASE_POLICY.cooldownMs)} between rescues, and never sends under ${usd(BASE_POLICY.minSendUsd)}. Money arrives after the latency, less the ${usd(BASE_POLICY.feeUsd)} fee.
- **Inside a candle:** the adverse extreme comes first, which is the harshest order. The price then moves at an even pace, or in the stress test takes one minute for the adverse move.
- **Liquidation:** at health 1. Hyperliquid's docs say remaining collateral stays with the trader when the book can close the position, so that's assumed. A backstop liquidation would lose it, so real losses could be larger.

## What this doesn't show

- It ignores funding, trading fees, price impact and the 1% slippage 1Click allows. All of them make real results somewhat worse.
- Each account holds one position. A real account with several can behave differently.
- Random entries have no edge, so their average result is near zero by nature. A trader with real edge would keep more of what a saved position later earns, and this test can't measure that.
- It says nothing about whether a trader should hold a losing position at all. A top-up keeps a position alive; it doesn't make it a good trade.
- Hyperliquid launched in 2023, and its daily candles go back to ${day(find("1d").from)}, so the older ones must come from elsewhere. They're used only in the sensitivity table.
- Positions and entry times are random, not real traders' behaviour.
`;
  return { markdown, charts };
}
