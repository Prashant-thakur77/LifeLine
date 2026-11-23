import type { Candle, CandleInterval } from "./candles";
import { isRecord, toNumber } from "./parse";

// What happened after each of an account's past liquidations, and how much more margin
// would have carried the position through. It's hindsight on one position alone.

export type Liquidation = {
  id: string;
  coin: string;
  side: "long" | "short";
  size: number;
  /** The size-weighted price it was closed at. */
  price: number;
  /** Profit or loss on the closed part, as Hyperliquid booked it. */
  pnlUsd: number;
  startedAt: number;
  endedAt: number;
};

const SAME_EVENT_MS = 10 * 60_000;

/** An account's own liquidations from `userFills`, newest first; parts of one are put together. Null when unreadable. */
export function findLiquidations(address: string, fills: unknown): Liquidation[] | null {
  if (!Array.isArray(fills)) return null;
  const found: Liquidation[] = [];
  const own = fills.filter((f) => isRecord(f) && isRecord(f.liquidation) && String(f.liquidation.liquidatedUser).toLowerCase() === address.toLowerCase());
  const sorted = own.map((f) => ({ f, time: toNumber(f.time) })).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const { f, time } of sorted) {
    const size = toNumber(f.sz);
    const price = toNumber(f.px);
    const pnl = toNumber(f.closedPnl);
    if (typeof f.coin !== "string" || size === null || price === null || pnl === null || time === null || !(size > 0) || !(price > 0)) return null;
    const side = f.side === "A" ? "long" : "short"; // a long is sold, a short is bought back
    const last = found.findLast((l) => l.coin === f.coin && l.side === side && time - l.endedAt <= SAME_EVENT_MS);
    if (last) {
      last.price = (last.price * last.size + price * size) / (last.size + size);
      last.size += size;
      last.pnlUsd += pnl;
      last.endedAt = time;
    } else {
      found.push({ id: `${f.coin}:${time}`, coin: f.coin, side, size, price, pnlUsd: pnl, startedAt: time, endedAt: time });
    }
  }
  return found.reverse();
}

const HOUR = 3_600_000;
export const WINDOWS_H = [24, 72, 168] as const;

/** The finest candles Hyperliquid still keeps for that time: about the latest 5,000 of each. */
export function intervalFor(at: number, now: number): { interval: CandleInterval; ms: number } {
  const ageH = (now - at) / HOUR;
  if (ageH < 1200) return { interval: "15m", ms: HOUR / 4 };
  if (ageH < 4800) return { interval: "1h", ms: HOUR };
  if (ageH < 19_000) return { interval: "4h", ms: 4 * HOUR };
  return { interval: "1d", ms: 24 * HOUR };
}

export type Aftermath = {
  hours: number;
  /** The worst price in the window. */
  worst: number;
  end: number;
  /** At least about how much more margin would have kept it open: a short's maintenance grows too as the price rises. */
  neededUsd: number;
  /** What the position then made or lost against being closed at the liquidation. */
  againstLiquidationUsd: number;
};

const FLAT_FEE_USD = 0.3153; // 1Click's, as measured on 2026-11-06

/**
 * The window after a liquidation. The candle it happened in counts too: had the price been
 * worse earlier in that candle, the position would have been liquidated then. Null when the window isn't over or has gaps.
 */
export function aftermath(l: Liquidation, candles: Candle[], intervalMs: number, hours: number, now: number): Aftermath | null {
  const until = l.endedAt + hours * HOUR;
  if (until > now) return null;
  const inside = candles.filter((c) => c.closeTime > l.endedAt && c.openTime < until).sort((a, b) => a.openTime - b.openTime);
  const expected = Math.floor((hours * HOUR) / intervalMs);
  const final = inside.at(-1);
  // The last candle must reach the end of the window and have closed.
  if (expected < 1 || final === undefined || final.closeTime < until - 1 || final.closeTime >= now || inside.length < Math.ceil(expected * 0.9)) return null;
  const direction = l.side === "long" ? 1 : -1;
  const worst = l.side === "long" ? Math.min(l.price, ...inside.map((c) => c.low)) : Math.max(l.price, ...inside.map((c) => c.high));
  const end = final.close;
  const adverse = Math.max(0, (l.price - worst) * direction) * l.size;
  return { hours, worst, end, neededUsd: adverse * 1.01 + FLAT_FEE_USD, againstLiquidationUsd: (end - l.price) * direction * l.size };
}

export type Verdict = "recovered" | "kept-falling";
/** Whether holding on would have ended better than being liquidated. */
export const verdictOf = (a: Aftermath): Verdict => (a.againstLiquidationUsd > 0 ? "recovered" : "kept-falling");
