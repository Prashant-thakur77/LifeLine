import { describe, expect, test } from "vitest";
import { parseAgents, parseDexState, readAccountRisk, stopsFor, type AccountRisk, type RiskPosition } from "../src/account";
import { healthAfter, storm, suggestPlan, worseDirection } from "../src/storm";

const pos = (over: Record<string, unknown> = {}) => ({
  type: "oneWay",
  position: { coin: "ETH", szi: "1", positionValue: "2000", entryPx: "2100", maxLeverage: 25, marginUsed: "200", liquidationPx: null, leverage: { type: "cross", value: 10 }, ...over },
});
const state = (value: string, mm: string, positions: unknown[]) => ({ crossMarginSummary: { accountValue: value }, crossMaintenanceMarginUsed: mm, assetPositions: positions });
const none = state("0", "0", []);

function reader(answers: { mode: unknown; main: unknown; xyz?: unknown; spot?: unknown }) {
  return async (body: Record<string, unknown>) => {
    if (body.type === "userAbstraction") return answers.mode;
    if (body.type === "perpDexs") return [null, { name: "xyz" }];
    if (body.type === "spotClearinghouseState") return answers.spot;
    if (body.dex === "xyz") {
      if (answers.xyz instanceof Error) throw answers.xyz;
      return answers.xyz ?? none;
    }
    return answers.main;
  };
}
const spot = (usdc: string, left: string) => ({ balances: [{ token: 0, total: usdc }], tokenToAvailableAfterMaintenance: [[0, left]] });

describe("reading one dex", () => {
  test("scales maintenance to what Hyperliquid reports, so tiers are counted", () => {
    const read = parseDexState("", state("300", "60", [pos()]))!; // 1/50 of 2000 is 40
    expect(read.positions[0]!.maintenanceRate).toBeCloseTo(0.03);
    expect(read.positions[0]!.markPx).toBe(2000);
  });
  test("isolated margin is counted apart", () => {
    const read = parseDexState("", state("300", "40", [pos(), pos({ coin: "BTC", leverage: { type: "isolated" }, marginUsed: "55" })]))!;
    expect(read.isolatedMargin).toBe(55);
  });
  test.each([
    ["nothing", null], ["no summary", { assetPositions: [] }], ["a bad number", state("x", "1", [pos()])], ["positions with no maintenance", state("1", "0", [pos()])],
    ["maintenance with no positions", state("1", "5", [])], ["a worthless position", state("1", "1", [pos({ positionValue: "0" })])], ["a zero size", state("1", "1", [pos({ szi: "0" })])], ["a bad liquidation price", state("1", "1", [pos({ liquidationPx: "?" })])],
    ["no leverage", state("1", "1", [pos({ leverage: null })])], ["isolated with no margin", state("1", "0", [pos({ leverage: { type: "isolated" }, marginUsed: null })])],
  ])("%s isn't read as safe", (_, raw) => expect(parseDexState("", raw)).toBeNull());
});

describe("reading an account", () => {
  test("standard: only Hyperliquid's own cross positions count", async () => {
    const risk = await readAccountRisk("0x", reader({ mode: "disabled", main: state("80", "40", [pos()]), xyz: state("9", "3", [pos({ coin: "xyz:AAPL" })]) }));
    expect(risk).toMatchObject({ mode: "standard", health: 2, keeperHealth: null });
    expect(risk.uncovered.map((p) => p.coin)).toEqual(["xyz:AAPL"]);
  });
  test("standard: a dex that couldn't be read is named", async () => {
    expect((await readAccountRisk("0x", reader({ mode: "default", main: none, xyz: new Error("down") }))).unread).toEqual(["xyz"]);
  });
  test("unified: one balance behind every dex, less isolated margin", async () => {
    const risk = await readAccountRisk(
      "0x",
      reader({ mode: "unifiedAccount", main: state("80", "40", [pos()]), xyz: state("1", "10", [pos({ coin: "xyz:AAPL" }), pos({ coin: "xyz:TSLA", leverage: { type: "isolated" }, marginUsed: "50" })]), spot: spot("1050", "950") }),
    );
    expect(risk).toMatchObject({ mode: "unified", value: 1000, maintenance: 50, health: 20, keeperHealth: 2 });
    expect(risk.covered.map((p) => p.coin)).toEqual(["ETH", "xyz:AAPL"]);
  });
  test.each([
    ["figures that don't add up", { mode: "unifiedAccount", main: state("80", "40", [pos()]), spot: spot("1000", "500") }],
    ["no figure to agree with", { mode: "unifiedAccount", main: state("80", "40", [pos()]), spot: { balances: [] } }],
    ["a dex that couldn't be read", { mode: "unifiedAccount", main: state("80", "40", [pos()]), xyz: new Error("down"), spot: spot("1000", "960") }],
    ["an unknown mode", { mode: "somethingNew", main: none }],
    ["an unreadable main dex", { mode: "default", main: {} }],
    ["no portfolio ratio", { mode: "portfolioMargin", main: none, spot: {} }],
    ["no spot answer", { mode: "unifiedAccount", main: none, spot: null }],
  ])("%s throws, never a number", async (_, answers) => {
    await expect(readAccountRisk("0x", reader(answers))).rejects.toThrow();
  });
  test("a list of markets that can't be read throws", async () => {
    for (const dexes of [{}, [null, {}], [null, 4]]) {
      const read = async (b: Record<string, unknown>) => (b.type === "perpDexs" ? dexes : b.type === "userAbstraction" ? "default" : none);
      await expect(readAccountRisk("0x", read)).rejects.toThrow(/markets/);
    }
  });
  test("unified with money locked and no position seen throws", async () => {
    await expect(readAccountRisk("0x", reader({ mode: "unifiedAccount", main: none, spot: spot("100", "95") }))).rejects.toThrow(/add up/);
  });
  test("unified with nothing in it", async () => {
    expect((await readAccountRisk("0x", reader({ mode: "unifiedAccount", main: none, spot: { balances: [] } }))).health).toBe(Number.POSITIVE_INFINITY);
  });
  test("portfolio margin gives its own ratio and no health", async () => {
    const risk = await readAccountRisk("0x", reader({ mode: "portfolioMargin", main: state("80", "40", [pos()]), spot: { portfolioMarginRatio: "0.4" } }));
    expect(risk).toMatchObject({ portfolioRatio: 0.4, covered: [], health: Number.NaN });
  });
});

const p = (over: Partial<RiskPosition> = {}): RiskPosition => ({ coin: "ETH", dex: "", size: 1, markPx: 2000, entryPx: 2000, liquidationPx: null, isolated: false, maintenanceRate: 0.02, ...over });
const account = (value: number, covered: RiskPosition[]): AccountRisk => {
  const maintenance = covered.reduce((s, x) => s + Math.abs(x.size) * x.markPx * x.maintenanceRate, 0);
  return { mode: "standard", value, maintenance, health: value / maintenance, covered, uncovered: [], keeperHealth: null, portfolioRatio: null, unread: [] };
};
const PLAN = { trigger: 1.5, target: 2, perRescueUsd: 100, perDayUsd: 200, reserveUsd: 200, flatFeeUsd: 0.3 };

describe("the storm", () => {
  const long = account(200, [p()]);
  test("no move is the health now", () => expect(healthAfter(long, 0)).toBeCloseTo(long.health));
  test("a long dies where the maths says: value meets maintenance", () => {
    // 200 + 2000x = 40(1 + x) → x = -160/1960 = -8.16%
    expect(storm(long, -20, PLAN).diesWithout).toBe(-8.25);
  });
  test("a short dies upwards, and a hedge doesn't", () => {
    expect(worseDirection(account(200, [p({ size: -1 })]))).toBe(1);
    expect(worseDirection(long)).toBe(-1);
    expect(storm(account(200, [p(), p({ coin: "BTC", size: -1 })]), -60, PLAN).diesWithout).toBeNull();
  });
  test("one coin alone moves only that coin", () => {
    const two = account(200, [p(), p({ coin: "BTC" })]);
    expect(healthAfter(two, -5, "BTC")).toBeGreaterThan(healthAfter(two, -5));
  });
  test("rescues come after the trigger, reach the target and stay in the caps", () => {
    const s = storm(long, -40, PLAN);
    expect(s.rescues[0]!.healthBefore).toBeLessThan(1.5);
    expect(s.rescues[0]!.healthAfter).toBeCloseTo(2, 1);
    expect(s.spentUsd).toBeLessThanOrEqual(200);
    for (const r of s.rescues) expect(r.sentUsd).toBeLessThanOrEqual(100);
    expect(s.diesWith!).toBeLessThan(s.diesWithout!);
  });
  test("an empty reserve changes nothing", () => {
    const s = storm(long, -20, { ...PLAN, reserveUsd: 1 });
    expect(s.rescues).toEqual([]);
    expect(s.diesWith).toBe(s.diesWithout);
  });
  test("an account already under 1 isn't rescued", () => expect(storm(account(30, [p()]), -5, PLAN).rescues).toEqual([]));
  test("a tiny cap on a huge account ends", () => expect(storm(account(2e6, [p({ size: 10_000 })]), -10, { ...PLAN, perRescueUsd: 3, perDayUsd: 1e9, reserveUsd: 1e9 }).rescues.length).toBeLessThanOrEqual(500));
  test("ends exactly at the move asked for", () => expect(storm(long, -1.1, PLAN).points.at(-1)!.pct).toBe(-1.1));
  test("the suggested plan covers a whole refill twice", () => {
    const plan = suggestPlan(account(50_000, [p({ size: 500 })]), { trigger: 1.5, target: 2 }, 0.3);
    expect(plan.perRescueUsd).toBeGreaterThanOrEqual(0.5 * 20_000);
    expect(plan.reserveUsd).toBe(plan.perRescueUsd * 2);
    expect(suggestPlan(long, { trigger: 1.5, target: 2 }, 0.3).perRescueUsd).toBe(25);
  });
});

describe("stops and keys", () => {
  const stop = { coin: "ETH", isTrigger: true, reduceOnly: true, side: "A", triggerPx: "1900", sz: "1" };
  test("a stop on the losing side counts", () => expect(stopsFor([p()], [stop])).toEqual([{ coin: "ETH", hasStop: true }]));
  test.each([{ side: "B" }, { triggerPx: "2100" }, { reduceOnly: false }, { isTrigger: false }, { coin: "BTC" }, { triggerPx: "x" }, { sz: "0.5" }])("%o doesn't", (o) =>
    expect(stopsFor([p()], [{ ...stop, ...o }])![0]!.hasStop).toBe(false),
  );
  test("stops add up to the whole position, and one for the position is enough", () => {
    expect(stopsFor([p()], [{ ...stop, sz: "0.5" }, { ...stop, sz: "0.5", triggerPx: "1950" }])![0]!.hasStop).toBe(true);
    expect(stopsFor([p()], [{ ...stop, sz: "0.0", isPositionTpsl: true }])![0]!.hasStop).toBe(true);
  });
  test("a stop past liquidation comes too late", () => expect(stopsFor([p({ liquidationPx: 1950 })], [stop])![0]!.hasStop).toBe(false));
  test("a short's stop is a buy above", () => expect(stopsFor([p({ size: -1 })], [{ ...stop, side: "B", triggerPx: "2100" }])![0]!.hasStop).toBe(true));
  test("an unreadable answer is unknown, not none", () => {
    expect(stopsFor([p()], {})).toBeNull();
    expect(parseAgents({})).toBeNull();
    expect(parseAgents([{}])).toBeNull();
  });
  test("keys", () => expect(parseAgents([{ name: "bot", address: "0x1", validUntil: 5 }, { address: "0x2" }])).toEqual([{ name: "bot", address: "0x1", validUntil: 5 }, { name: "", address: "0x2", validUntil: null }]));
});
