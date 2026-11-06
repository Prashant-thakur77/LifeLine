import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCandles, type CandleInterval } from "@lifeline/hyperliquid";
import { saveCandles } from "./data";
import { COINS, INTERVALS } from "./scenario";

const here = dirname(fileURLToPath(import.meta.url));
const folder = join(here, "..", "candles");

/**
 * Saves every candle Hyperliquid will still give us. It keeps only about the
 * latest 5,000 per interval, so these files are the only way to rerun this later.
 */
async function main() {
  const now = Date.now();
  for (const coin of COINS) {
    for (const interval of INTERVALS) {
      const candles = await getCandles(coin, interval as CandleInterval, 0, now);
      const bars = candles.map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close }));
      saveCandles(folder, coin, interval, bars);
      const from = new Date(bars[0]?.t ?? 0).toISOString().slice(0, 10);
      const to = new Date(bars.at(-1)?.t ?? 0).toISOString().slice(0, 10);
      console.log(`${coin} ${interval}: ${bars.length} candles, ${from} to ${to}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
