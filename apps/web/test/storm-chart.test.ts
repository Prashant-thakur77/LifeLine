import { describe, expect, test } from "vitest";
import { CHART, chartPath, chartScale, signedPct } from "../src/lib/storm-chart";
import { checkAccount } from "../src/lib/hl";

test("the chart's corners", () => {
  const { x, y } = chartScale(-40);
  expect(x(0)).toBe(CHART.left);
  expect(x(-40)).toBe(CHART.width - CHART.right);
  expect(y(0)).toBe(CHART.height - CHART.bottom);
  expect(y(Number.POSITIVE_INFINITY)).toBe(CHART.top);
  expect(y(-3)).toBe(y(0));
});
test("a line stops where the account dies", () => {
  const points = [{ pct: 0, without: 2, with: 2 }, { pct: -1, without: 0.9, with: 1.8 }, { pct: -2, without: 0.1, with: 1.6 }];
  expect(chartPath(points, "without", -2).split("L")).toHaveLength(2);
  expect(chartPath(points, "with", -2).split("L")).toHaveLength(3);
});
test.each([[-8.25, "−8.3%"], [12, "+12%"], [0, "0.0%"]])("%d reads %s", (n, s) => expect(signedPct(n)).toBe(s));

describe("checking an account", () => {
  const ADDRESS = `0x${"1".repeat(40)}`;
  const main = { crossMarginSummary: { accountValue: "80" }, crossMaintenanceMarginUsed: "40", assetPositions: [{ position: { coin: "ETH", szi: "1", positionValue: "2000", entryPx: "2000", maxLeverage: 25, liquidationPx: null, leverage: { type: "cross" } } }] };
  const fake = (over: Record<string, unknown>) => (async (_: unknown, init: { body: string }) => {
    const { type } = JSON.parse(init.body) as { type: string };
    const answers: Record<string, unknown> = { userAbstraction: "default", perpDexs: [null], clearinghouseState: main, extraAgents: [], frontendOpenOrders: [], ...over };
    if (answers[type] instanceof Error) throw answers[type];
    return Response.json(answers[type]);
  }) as unknown as typeof fetch;
  test("puts it together", async () => {
    expect(await checkAccount(ADDRESS, fake({}))).toMatchObject({ risk: { health: 2 }, stops: [{ coin: "ETH", hasStop: false }], agents: [] });
  });
  test("orders or keys that can't be read are unknown, not absent", async () => {
    expect(await checkAccount(ADDRESS, fake({ extraAgents: new Error("x"), frontendOpenOrders: new Error("x") }))).toMatchObject({ stops: null, agents: null });
  });
  test("a bad address never leaves the browser", async () => {
    await expect(checkAccount("nope", (() => { throw new Error("called"); }) as unknown as typeof fetch)).rejects.toThrow(/address/);
  });
});
