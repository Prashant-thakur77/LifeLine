import type { StormPoint } from "@lifeline/hyperliquid";

export const CHART = { width: 720, height: 300, left: 40, right: 12, top: 12, bottom: 30, maxHealth: 4 } as const;

/** Where a move and a health sit on the chart. Health above the top is drawn at the top. */
export function chartScale(toPct: number) {
  const w = CHART.width - CHART.left - CHART.right;
  const h = CHART.height - CHART.top - CHART.bottom;
  return {
    x: (pct: number) => CHART.left + (pct / toPct) * w,
    y: (health: number) => CHART.top + (1 - Math.min(Math.max(health, 0), CHART.maxHealth) / CHART.maxHealth) * h,
  };
}

/** The line down to where the account dies, and no further: there's no health after that. */
export function chartPath(points: StormPoint[], key: "with" | "without", toPct: number): string {
  const { x, y } = chartScale(toPct);
  let d = "";
  for (const point of points) {
    d += `${d ? " L" : "M"} ${x(point.pct).toFixed(1)} ${y(point[key]).toFixed(1)}`;
    if (point[key] <= 1) break;
  }
  return d;
}

export const signedPct = (pct: number) => `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
