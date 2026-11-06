import { postInfo, type InfoOptions } from "./info";
import { isRecord, toNumber } from "./parse";

export type CandleInterval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "8h" | "12h"
  | "1d" | "3d" | "1w" | "1M";

export type Candle = {
  openTime: number; // ms
  closeTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
};

function parseCandle(raw: unknown): Candle {
  const candle = isRecord(raw) ? raw : {};
  const fields = {
    openTime: toNumber(candle.t),
    closeTime: toNumber(candle.T),
    open: toNumber(candle.o),
    high: toNumber(candle.h),
    low: toNumber(candle.l),
    close: toNumber(candle.c),
    volume: toNumber(candle.v),
    trades: toNumber(candle.n),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) throw new Error(`Malformed candle: bad ${name}`);
  }
  return fields as Candle;
}

/**
 * Candles between two times in ms, oldest first.
 *
 * Hyperliquid keeps only about the most recent 5,000 candles per interval, so an
 * older start gets a shorter window and a fully older one gets nothing. Throws
 * on failure: a backtest must not run on missing data.
 */
export async function getCandles(
  coin: string,
  interval: CandleInterval,
  start: number,
  end: number,
  options: InfoOptions = {},
): Promise<Candle[]> {
  const raw = await postInfo(
    { type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } },
    { timeoutMs: 10_000, ...options },
  );
  if (!Array.isArray(raw)) throw new Error("Malformed candle response: not a list");
  return raw.map(parseCandle);
}
