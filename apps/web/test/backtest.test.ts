import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKTEST, type Row } from "../src/lib/backtest";

const report = readFileSync(new URL("../../../research/backtest/RESULTS.md", import.meta.url), "utf8");

/** The rows of the first markdown table after `after`, as label and the three percentages. */
function table(after: string): Row[] {
  const start = report.indexOf(after);
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = report
    .slice(start)
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .slice(2);
  const rows: Row[] = [];
  for (const line of lines) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 4 || !cells[1]!.endsWith("%")) break;
    const [label, a, b, c] = cells as [string, string, string, string];
    rows.push({ label, without: parseFloat(a), lifeline: parseFloat(b), lifelineP95: parseFloat(c) });
  }
  return rows;
}

describe("BACKTEST", () => {
  it("matches the liquidation tables in research/backtest/RESULTS.md", () => {
    expect(BACKTEST.byLeverage).toEqual(table("![Liquidation rate by leverage]"));
    expect(BACKTEST.byCoin).toEqual(table("By coin:"));
    expect(BACKTEST.flashByLeverage).toEqual(table("![Flash-crash stress test]"));
  });

  it("matches the headline cost and the sample", () => {
    expect(report).toContain(`-$${Math.abs(BACKTEST.pnlWithout).toFixed(2)} per position without it, -$${Math.abs(BACKTEST.pnlWith).toFixed(2)} with it`);
    expect(report).toContain(`On ${BACKTEST.positions.toLocaleString("en-US")} random BTC, ETH and SOL positions`);
    expect(report).toContain(BACKTEST.period);
  });
});
