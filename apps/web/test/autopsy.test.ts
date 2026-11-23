import { describe, expect, test } from "vitest";
import type { Liquidation } from "@lifeline/hyperliquid";
import { dayOf, liquidationLine, sentence, signedUsd, tally } from "../src/lib/autopsy-text";
import { readAftermath, readLiquidations } from "../src/lib/hl";

const L: Liquidation = { id: "x", coin: "BTC", side: "long", size: 1, price: 100, pnlUsd: -10, startedAt: 0, endedAt: 0 };
const up = { hours: 24, worst: 90, end: 110, neededUsd: 11, againstLiquidationUsd: 10 };
const down = { ...up, end: 80, againstLiquidationUsd: -20 };

test("the sentence is plain about both outcomes", () => {
  expect(sentence(L, up)).toMatch(/\$10\.00 more than/);
  expect(sentence(L, down)).toMatch(/\$20\.00 less, so being liquidated cost less/);
});
test("the tally counts one window", () => expect(tally([[up, { ...up, hours: 72 }], [down], undefined], 24)).toEqual({ recovered: 1, total: 2 }));
test("words", () => {
  expect(signedUsd(-5)).toBe("−$5.00");
  expect(dayOf(0)).toBe("1 Jan 1970");
  expect(liquidationLine(L)).toContain("Long BTC");
});

describe("reading", () => {
  const H = 3_600_000;
  const at = 1_000 * H;
  const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  test("liquidations", async () => {
    const me = `0x${"1".repeat(40)}`;
    expect(await readLiquidations(me, answer([]))).toEqual([]);
    await expect(readLiquidations(me, answer({}))).rejects.toThrow(/read/);
    await expect(readLiquidations("x")).rejects.toThrow(/address/);
  });
  test("the aftermath, only for windows that are over", async () => {
    const candles = Array.from({ length: 24 }, (_, i) => ({ t: at + i * H, T: at + (i + 1) * H - 1, o: "100", h: "101", l: "90", c: "105", v: "0", n: 0 }));
    const l = { ...L, startedAt: at, endedAt: at };
    expect(await readAftermath(l, at + 1300 * H, answer(candles))).toMatchObject([{ hours: 24, worst: 90, end: 105 }]);
    expect(await readAftermath(l, at + 10 * H, answer(candles))).toEqual([]);
    await expect(readAftermath(l, at + 1300 * H, answer([{ t: 1 }]))).rejects.toThrow(/prices/);
    await expect(readAftermath(l, at + 1300 * H, answer({}))).rejects.toThrow(/prices/);
  });
});
