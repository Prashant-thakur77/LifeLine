import { describe, expect, it } from "vitest";
import { barChart } from "../src/chart";

const chart = {
  title: "Liquidation rate",
  subtitle: "Percent of positions",
  series: ["No protection", "Lifeline"],
  groups: [
    { label: "5×", values: [10, 2] },
    { label: "20×", values: [50, 5] },
  ],
  maxValue: 50,
  unit: "%",
};

describe("barChart", () => {
  it("names its title, subtitle, groups and every series, so nothing relies on color alone", () => {
    const svg = barChart(chart);
    for (const text of ["Liquidation rate", "Percent of positions", "5×", "20×", "No protection", "Lifeline"]) {
      expect(svg).toContain(text);
    }
  });

  it("labels each bar's value at its tip", () => {
    expect(barChart(chart)).toContain(">50.0%<");
    expect(barChart(chart)).toContain(">2.0%<");
  });

  it("draws bars in proportion, on one scale", () => {
    const widths = [...barChart(chart).matchAll(/data-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(4);
    expect((widths[2] ?? 0) / (widths[0] ?? 1)).toBeCloseTo(5, 5);
  });

  it("keeps a thin mark on a zero value, so a real 0 isn't read as missing", () => {
    const svg = barChart({ ...chart, groups: [{ label: "5×", values: [0, 1] }] });
    expect(svg).toContain(">0.0%<");
  });

  it("picks its own colors for dark mode", () => {
    expect(barChart(chart)).toContain("prefers-color-scheme: dark");
  });

  it("gives each bar a hover title", () => {
    expect(barChart(chart)).toContain("<title>20×, No protection: 50.0%</title>");
  });

  it("escapes text", () => {
    expect(barChart({ ...chart, title: "A & B <c>" })).toContain("A &amp; B &lt;c&gt;");
  });

  it("refuses a bad value rather than drawing a wrong chart", () => {
    expect(() => barChart({ ...chart, groups: [{ label: "5×", values: [Number.NaN, 1] }] })).toThrow(/value/i);
    expect(() => barChart({ ...chart, groups: [{ label: "5×", values: [60, 1] }] })).toThrow(/value/i);
  });

  it("refuses a group with the wrong number of values", () => {
    expect(() => barChart({ ...chart, groups: [{ label: "5×", values: [1] }] })).toThrow(/series/i);
  });
});
