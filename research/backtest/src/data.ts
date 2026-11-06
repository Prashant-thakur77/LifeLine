import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One candle: open time in ms, then open, high, low and close. */
export type Bar = { t: number; o: number; h: number; l: number; c: number };

type Row = [t: number, o: number, h: number, l: number, c: number];

export const candleFile = (folder: string, coin: string, interval: string) => join(folder, `${coin}-${interval}.json`);

export function saveCandles(folder: string, coin: string, interval: string, bars: Bar[]): void {
  mkdirSync(folder, { recursive: true });
  const rows = bars.map((b): Row => [b.t, b.o, b.h, b.l, b.c]);
  writeFileSync(candleFile(folder, coin, interval), `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
}

/** Loads a saved file and checks it, so bad data stops the run instead of skewing it. */
export function loadCandles(folder: string, coin: string, interval: string): Bar[] {
  const rows = JSON.parse(readFileSync(candleFile(folder, coin, interval), "utf8")) as Row[];
  if (rows.length === 0) throw new Error(`no candles for ${coin} ${interval}`);
  return rows.map(([t, o, h, l, c], i) => {
    const previous = rows[i - 1];
    if (previous && previous[0] >= t) throw new Error(`${coin} ${interval}: candles out of order at ${t}`);
    if (h < l || o > h || o < l || c > h || c < l) throw new Error(`${coin} ${interval}: impossible high or low at ${t}`);
    return { t, o, h, l, c };
  });
}
