import type { HealthResult } from "./health";

/** Text for a person to read. JSON can't show Infinity, so don't print the raw snapshot. */
export function formatHealthResult(result: HealthResult): string {
  if (result.status === "unknown") {
    return [`health: unknown (${result.reason})`, ...(result.detail ? [result.detail] : [])].join(
      "\n",
    );
  }

  const { snapshot, isolatedCoins } = result;
  const health = Number.isFinite(snapshot.health)
    ? String(Number(snapshot.health.toFixed(4)))
    : "Infinity (no positions)";

  const lines = [
    `address: ${snapshot.hlAddress}`,
    `at: ${snapshot.at}`,
    `account value: ${snapshot.accountValue} USD`,
    `maintenance margin: ${snapshot.maintenanceMarginUsed} USD`,
    `health: ${health}`,
  ];
  for (const { coin, size, entryPx, liquidationPx } of snapshot.positions) {
    lines.push(`  ${coin}: size ${size}, entry ${entryPx}, liquidation ${liquidationPx ?? "none"}`);
  }
  if (isolatedCoins.length > 0) {
    lines.push(`not protected (isolated margin): ${isolatedCoins.join(", ")}`);
  }
  return lines.join("\n");
}
