import { describe, expect, it, vi } from "vitest";
import { getCandles, InfoApiError } from "../src/index";
import recorded from "./recorded/candles-btc-1h.json";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const instant = { sleep: async () => {} };

function stub(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch called more times than scripted");
    if (next instanceof Error) throw next;
    return next;
  });
  return fn as unknown as typeof fetch & typeof fn;
}

describe("getCandles", () => {
  it("asks for the coin, interval and window, in milliseconds", async () => {
    const fetch = stub(json(recorded));
    await getCandles("BTC", "1h", 1000, 2000, { fetch, apiUrl: "https://hl.test", ...instant });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hl.test/info");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1h", startTime: 1000, endTime: 2000 },
    });
  });

  it("turns a recorded response into numbers, oldest first", async () => {
    const candles = await getCandles("BTC", "1h", 0, 1, { fetch: stub(json(recorded)), ...instant });
    const first = recorded[0]!;
    expect(candles).toHaveLength(recorded.length);
    expect(candles[0]).toEqual({
      openTime: first.t,
      closeTime: first.T,
      open: Number(first.o),
      high: Number(first.h),
      low: Number(first.l),
      close: Number(first.c),
      volume: Number(first.v),
      trades: first.n,
    });
    const times = candles.map((c) => c.openTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns an empty list for a window with no data", async () => {
    await expect(
      getCandles("BTC", "1h", 0, 1, { fetch: stub(json([])), ...instant }),
    ).resolves.toEqual([]);
  });

  it("retries, then throws, so a backtest can't run on missing data", async () => {
    const fetch = stub(...Array.from({ length: 4 }, () => new Error("down")));
    await expect(getCandles("BTC", "1h", 0, 1, { fetch, ...instant })).rejects.toBeInstanceOf(
      InfoApiError,
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["not a list", { oops: true }],
    ["a candle with a bad price", [{ ...recorded[0], c: "abc" }]],
    ["a candle with no time", [{ ...recorded[0], t: undefined }]],
  ])("throws rather than guessing when the response is %s", async (_name, body) => {
    await expect(
      getCandles("BTC", "1h", 0, 1, { fetch: stub(json(body)), ...instant }),
    ).rejects.toThrow(/candle/i);
  });
});
