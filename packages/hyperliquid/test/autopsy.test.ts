import { describe, expect, test } from "vitest";
import type { Candle } from "../src/candles";
import { aftermath, findLiquidations, intervalFor, verdictOf, type Liquidation } from "../src/autopsy";

const ME = "0xAbC";
const fill = (over: Record<string, unknown> = {}) => ({ coin: "BTC", px: "100", sz: "2", side: "A", time: 1000, closedPnl: "-50", fee: "1", liquidation: { liquidatedUser: "0xabc" }, ...over });

describe("finding liquidations", () => {
  test("parts of one are put together, at their average price", () => {
    expect(findLiquidations(ME, [fill({ time: 2000, px: "90", sz: "2" }), fill()])).toEqual([
      { id: "BTC:1000", coin: "BTC", side: "long", size: 4, price: 95, pnlUsd: -100, startedAt: 1000, endedAt: 2000 },
    ]);
  });
  test("other coins, sides and times are their own, newest first", () => {
    const list = findLiquidations(ME, [fill(), fill({ coin: "ETH" }), fill({ side: "B" }), fill({ time: 10_000_000 })])!;
    expect(list).toHaveLength(4);
    expect(list[0]!.startedAt).toBe(10_000_000);
  });
  test("someone else's liquidation, or an ordinary trade, isn't theirs", () => {
    expect(findLiquidations(ME, [fill({ liquidation: { liquidatedUser: "0xdef" } }), fill({ liquidation: undefined })])).toEqual([]);
  });
  test.each([{}, null])("unreadable is null: %j", (v) => expect(findLiquidations(ME, v)).toBeNull());
  test.each([{ px: "x" }, { sz: "0" }, { time: null }, { closedPnl: "" }, { coin: 1 }])("a bad fill is null: %j", (o) => expect(findLiquidations(ME, [fill(o)])).toBeNull());
});

const H = 3_600_000;
const candle = (openTime: number, low: number, high: number, close: number): Candle => ({ openTime, closeTime: openTime + H - 1, open: close, high, low, close, volume: 0, trades: 0 });
const L: Liquidation = { id: "x", coin: "BTC", side: "long", size: 2, price: 100, pnlUsd: -50, startedAt: 0, endedAt: 0 };
const day = (low: number, high: number, end: number) => Array.from({ length: 24 }, (_, i) => candle(i * H, i === 3 ? low : 99, i === 3 ? high : 101, i === 23 ? end : 100));

describe("the aftermath", () => {
  test("a long that recovered, and what it took to hold it", () => {
    const a = aftermath(L, day(90, 101, 120), H, 24, 100 * H)!;
    expect(a).toMatchObject({ worst: 90, end: 120, againstLiquidationUsd: 40 });
    expect(a.neededUsd).toBeCloseTo(20 * 1.01 + 0.3153);
    expect(verdictOf(a)).toBe("recovered");
  });
  test("a long that kept falling", () => expect(verdictOf(aftermath(L, day(60, 101, 61), H, 24, 100 * H)!)).toBe("kept-falling"));
  test("a short is the other way up", () => {
    expect(aftermath({ ...L, side: "short" }, day(90, 130, 80), H, 24, 100 * H)).toMatchObject({ worst: 130, againstLiquidationUsd: 40 });
  });
  test("a price that never got worse needed only the fee", () => expect(aftermath({ ...L, price: 95 }, day(99, 101, 100), H, 24, 100 * H)!.neededUsd).toBeCloseTo(0.3153));
  test("the candle it happened in counts, and one that closed before doesn't", () => {
    expect(aftermath({ ...L, endedAt: H / 2 }, [candle(0, 85, 101, 100), ...day(90, 101, 100).slice(1), candle(24 * H, 99, 101, 100)], H, 24, 100 * H)!.worst).toBe(85);
    expect(aftermath({ ...L, endedAt: H }, [candle(0, 1, 101, 100), ...day(90, 101, 100).slice(1)], H, 23, 100 * H)!.worst).toBe(90);
  });
  test("no answer for a window that isn't over, or has gaps", () => {
    expect(aftermath(L, day(90, 101, 100), H, 24, 23 * H)).toBeNull();
    expect(aftermath(L, day(90, 101, 100).slice(0, 10), H, 24, 100 * H)).toBeNull();
    expect(aftermath(L, [], H, 24, 100 * H)).toBeNull();
  });
  test("one daily candle isn't a day, and one still open isn't an end", () => {
    const D = 24 * H;
    const daily = (at: number) => ({ ...candle(at, 90, 101, 100), closeTime: at + D - 1 });
    expect(aftermath({ ...L, endedAt: H }, [daily(0)], D, 24, 100 * H)).toBeNull();
    expect(aftermath({ ...L, endedAt: H }, [daily(0), daily(D)], D, 24, 30 * H)).toBeNull();
    expect(aftermath({ ...L, endedAt: H }, [daily(0), daily(D)], D, 24, 100 * H)).not.toBeNull();
  });
  test("daily candles can't answer for less than a day", () => expect(aftermath(L, [], 24 * H, 12, 100 * H)).toBeNull());
});

test.each([[10, "15m"], [100, "1h"], [400, "4h"], [1000, "1d"]])("%d days old uses %s candles", (days, interval) => expect(intervalFor(0, days * 24 * H).interval).toBe(interval));
