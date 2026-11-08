import { describe, expect, it } from "vitest";
import { checkAddress, midPrice } from "../src/lib/hl";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const answering = (body: unknown, seen: unknown[] = [], status = 200) =>
  (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

const state = {
  marginSummary: { accountValue: "120", totalMarginUsed: "10" },
  crossMarginSummary: { accountValue: "100", totalMarginUsed: "10" },
  crossMaintenanceMarginUsed: "40",
  time: 1794200000000,
  assetPositions: [
    { type: "oneWay", position: { coin: "ETH", szi: "0.5", entryPx: "3000", liquidationPx: "2800", leverage: { type: "cross", value: 10 } } },
  ],
};

describe("checkAddress", () => {
  it("reads health the keeper's way: cross account value over cross maintenance margin", async () => {
    const seen: unknown[] = [];
    const r = await checkAddress(ADDRESS, answering(state, seen));
    expect(seen[0]).toEqual({ type: "clearinghouseState", user: ADDRESS });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.snapshot.health).toBeCloseTo(2.5, 6);
      expect(r.snapshot.positions[0]).toMatchObject({ coin: "ETH", liquidationPx: 2800 });
    }
  });

  it("refuses a malformed address without calling Hyperliquid", async () => {
    const seen: unknown[] = [];
    expect(await checkAddress("0x123", answering(state, seen))).toEqual({ status: "unknown", reason: "INVALID_ADDRESS" });
    expect(seen).toHaveLength(0);
  });

  it("says unknown, never safe, when Hyperliquid fails", async () => {
    const r = await checkAddress(ADDRESS, answering({}, [], 500));
    expect(r.status).toBe("unknown");
  });
});

describe("midPrice", () => {
  it("reads a coin's mid and returns null when it can't", async () => {
    expect(await midPrice("ETH", answering({ ETH: "2226.85" }))).toBe(2226.85);
    expect(await midPrice("ETH", answering({}))).toBeNull();
    expect(await midPrice("ETH", answering({}, [], 502))).toBeNull();
  });
});
