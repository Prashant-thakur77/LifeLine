import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candleFile, loadCandles, saveCandles, type Bar } from "../src/data";

const bars: Bar[] = [
  { t: 1000, o: 100, h: 110, l: 95, c: 105 },
  { t: 2000, o: 105, h: 106, l: 90, c: 91 },
];

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});
const tempDir = () => {
  dir = mkdtempSync(join(tmpdir(), "backtest-"));
  return dir;
};

describe("the raw candle files", () => {
  it("names a file for each coin and interval", () => {
    expect(candleFile("/x", "BTC", "4h")).toBe(join("/x", "BTC-4h.json"));
  });

  it("gives back exactly what was saved", () => {
    const folder = tempDir();
    saveCandles(folder, "BTC", "4h", bars);
    expect(loadCandles(folder, "BTC", "4h")).toEqual(bars);
  });

  it("refuses a file with missing candles, rather than silently testing on less data", () => {
    const folder = tempDir();
    saveCandles(folder, "BTC", "4h", []);
    expect(() => loadCandles(folder, "BTC", "4h")).toThrow(/no candles/i);
  });

  it("refuses candles out of order", () => {
    const folder = tempDir();
    saveCandles(folder, "BTC", "4h", [bars[1] as Bar, bars[0] as Bar]);
    expect(() => loadCandles(folder, "BTC", "4h")).toThrow(/order/i);
  });

  it("refuses a candle whose high is below its low", () => {
    const folder = tempDir();
    saveCandles(folder, "BTC", "4h", [{ t: 1, o: 100, h: 90, l: 95, c: 92 }]);
    expect(() => loadCandles(folder, "BTC", "4h")).toThrow(/high|low/i);
  });
});
