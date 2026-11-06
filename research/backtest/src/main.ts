import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCandles, type Bar } from "./data";
import { buildReport, type LatencyInfo } from "./report";
import { runGrid } from "./run";
import { RUNS, type Coin, type Interval } from "./scenario";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const started = Date.now();
  const latency = JSON.parse(readFileSync(join(root, "latency.json"), "utf8")) as LatencyInfo;
  const cache = new Map<string, Bar[]>();
  const load = (coin: Coin, interval: Interval) => {
    const key = `${coin}-${interval}`;
    const bars = cache.get(key) ?? loadCandles(join(root, "candles"), coin, interval);
    cache.set(key, bars);
    return bars;
  };

  const results = RUNS.map((run) => {
    const result = runGrid(run, load, latency);
    console.log(`${run.label}: ${((Date.now() - started) / 1000).toFixed(0)} s so far`);
    return result;
  });

  const { markdown, charts } = buildReport(results, latency);
  writeFileSync(join(root, "RESULTS.md"), markdown);
  mkdirSync(join(root, "charts"), { recursive: true });
  for (const [name, svg] of Object.entries(charts)) writeFileSync(join(root, "charts", name), svg);
  console.log(`Wrote RESULTS.md and ${Object.keys(charts).length} charts.`);
}

main();
