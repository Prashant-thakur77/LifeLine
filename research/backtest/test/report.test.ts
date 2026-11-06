import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data";
import { buildReport, markdownTable, pct, usd, worstFailure } from "../src/report";
import { runGrid, type Cell } from "../src/run";
import { summarize } from "../src/summary";
import { INTERVAL_MS, RUNS, type Interval } from "../src/scenario";

const HOUR = 3_600_000;
/** A week of quiet, a crash, then a recovery, so every kind of outcome turns up. */
function makeBars(interval: Interval): Bar[] {
  const step = INTERVAL_MS[interval];
  const length = Math.min(Math.ceil((60 * 24 * HOUR) / step), 20_000);
  let price = 100;
  return Array.from({ length }, (_, i) => {
    const wave = Math.sin(i / 7) * 0.012;
    const crash = i === Math.floor(length / 2) ? -0.18 : 0;
    const open = price;
    price = Math.max(open * (1 + wave + crash), 1);
    return {
      t: i * step,
      o: open,
      h: Math.max(open, price) * 1.002,
      l: Math.min(open, price) * 0.998,
      c: price,
    };
  });
}

const latency = { p50Ms: 35_000, p95Ms: 120_000, measured: false, source: "Assumed for this test." };
const grid = (options = { count: 40 }) => RUNS.map((run) => runGrid(run, (_coin, interval) => makeBars(interval), latency, options));

describe("runGrid", () => {
  const results = grid();

  it("runs every coin, leverage and side", () => {
    expect(results[0]?.cells).toHaveLength(3 * 3 * 2);
  });

  it("pairs each scenario with the same positions", () => {
    const cell = results[0]?.cells[0];
    expect(cell?.none).toHaveLength(40);
    expect(cell?.p50).toHaveLength(40);
    expect(cell?.p95).toHaveLength(40);
  });

  it("never liquidates more positions with Lifeline than without", () => {
    for (const { cells } of results) {
      for (const cell of cells) {
        cell.none.forEach((before, i) => {
          if (cell.p50[i]?.liquidated) expect(before.liquidated).toBe(true);
        });
      }
    }
  });

  it("never lets the unprotected baseline fire a rescue", () => {
    for (const { cells } of results) {
      for (const cell of cells) expect(cell.none.every((o) => o.rescuesFired === 0 && o.reserveUsedUsd === 0)).toBe(true);
    }
  });

  it("really does run the flash crash harder than the even pace", () => {
    const find = (id: string) => results.find((result) => result.run.id === id)?.cells ?? [];
    const late = (cells: Cell[]) => summarize(cells.flatMap((cell) => cell.p50)).rescuesLate;
    expect(late(find("primary-flash"))).toBeGreaterThan(late(find("primary")));
    const liquidated = (cells: Cell[]) => summarize(cells.flatMap((cell) => cell.p50)).liquidated;
    expect(liquidated(find("primary-flash"))).toBeGreaterThan(liquidated(find("primary")));
  });

  it("gives the same answer every run", () => {
    expect(grid()[0]?.cells[0]?.p50).toEqual(results[0]?.cells[0]?.p50);
  });
});

describe("the report", () => {
  const report = buildReport(grid(), latency);

  it("says plainly when latency is only assumed", () => {
    expect(report.markdown).toContain("Latency is assumed, not measured yet.");
    expect(buildReport(grid(), { ...latency, measured: true }).markdown).toContain("Latency is measured.");
  });

  it("covers everything the plan requires", () => {
    for (const section of [
      "Without protection",
      "Too late",
      "Reserve used per rescued position",
      "## Honest failure cases",
      "## Flash-crash stress test",
    ]) {
      expect(report.markdown).toContain(section);
    }
  });

  it("names a real failure case with dates and money", () => {
    expect(report.markdown).toMatch(/opened \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC at \$/);
    expect(report.markdown).toMatch(/Result: -?\$[\d.]+ with Lifeline, -?\$[\d.]+ without\./);
  });

  it("links the charts it writes", () => {
    for (const name of Object.keys(report.charts)) expect(report.markdown).toContain(`charts/${name}`);
    expect(Object.keys(report.charts)).toHaveLength(2);
  });

  it("shows a real example of a crash beating a rescue", () => {
    const section = report.markdown.slice(report.markdown.indexOf("**The crash beat the rescue"));
    expect(section.split("\n")[0]).toMatch(/opened \d{4}-\d{2}-\d{2}/);
  });

  it("says so when Lifeline costs money on average, rather than hiding it", () => {
    const primary = grid()[0]?.cells ?? [];
    const mean = (key: "none" | "p50") => summarize(primary.flatMap((cell) => cell[key])).meanPnlUsd;
    expect(mean("p50")).toBeLessThan(mean("none"));
    expect(report.markdown).toContain("costs money, because it buys survival, not profit");
  });

  it("doesn't claim a conclusion about latency, because the numbers change when it does", () => {
    expect(report.markdown).not.toContain("falls apart");
  });

  it("separates a fee from a real loss", () => {
    expect(report.markdown).toContain("more than the fee");
  });

  it("is the same every time, so a clean clone reproduces it", () => {
    expect(buildReport(grid(), latency)).toEqual(report);
  });

  it("has no broken numbers", () => {
    expect(report.markdown).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("refuses to report without its headline runs", () => {
    expect(() => buildReport(grid().slice(1), latency)).toThrow(/primary/);
  });
});

describe("worstFailure", () => {
  it("is null when nothing matches", () => {
    expect(worstFailure(grid()[0]?.cells ?? [], "p50", () => false)).toBeNull();
  });

  it("finds the position that lost the most by using Lifeline", () => {
    const { cells } = grid()[0] ?? { cells: [] };
    const worst = worstFailure(cells, "p50", (o) => o.rescuesFired > 0);
    if (!worst) throw new Error("expected a failure");
    const gap = worst.cell.none[worst.index]!.pnlUsd - worst.cell.p50[worst.index]!.pnlUsd;
    for (const cell of cells) {
      cell.p50.forEach((outcome, i) => {
        if (outcome.rescuesFired > 0) expect(cell.none[i]!.pnlUsd - outcome.pnlUsd).toBeLessThanOrEqual(gap);
      });
    }
  });
});

describe("formatting", () => {
  it("formats percentages and money, and says n/a for nothing", () => {
    expect(pct(12.345)).toBe("12.3%");
    expect(pct(null)).toBe("n/a");
    expect(usd(-5)).toBe("-$5.00");
    expect(usd(5.5)).toBe("$5.50");
    expect(usd(null)).toBe("n/a");
  });

  it("builds a markdown table", () => {
    expect(markdownTable(["a", "b"], [["1", "2"]])).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});
