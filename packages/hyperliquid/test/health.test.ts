import { describe, expect, it, vi } from "vitest";
import { getHealth, parseClearinghouseState } from "../src/index";
import cross from "./recorded/clearinghouse-cross.json";
import isolatedOnly from "./recorded/clearinghouse-isolated-only.json";
import mixed from "./recorded/clearinghouse-mixed-constructed.json";
import noPositions from "./recorded/clearinghouse-no-positions.json";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function ok(raw: unknown) {
  const result = parseClearinghouseState(ADDRESS, raw);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that plays back one scripted step per call. */
function scripted(...steps: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const step = steps.shift();
    if (!step) throw new Error("fetch called more times than scripted");
    if (step instanceof Error) throw step;
    return step;
  });
  return fn as unknown as typeof fetch & typeof fn;
}

const instant = { sleep: async () => {} };

describe("parseClearinghouseState on recorded responses", () => {
  it("computes health for a cross account as accountValue / maintenance margin", () => {
    const { snapshot } = ok(cross);
    expect(snapshot.accountValue).toBe(106737.083711);
    expect(snapshot.maintenanceMarginUsed).toBe(8289.285705);
    expect(snapshot.health).toBeCloseTo(106737.083711 / 8289.285705, 9);
    expect(snapshot.hlAddress).toBe(ADDRESS);
  });

  it("maps a position to coin, signed size, entry and liquidation price", () => {
    const { snapshot } = ok(cross);
    expect(snapshot.positions).toEqual([
      { coin: "ETH", size: 184.5755, entryPx: 2698.87, liquidationPx: 1446.5304976853 },
    ]);
  });

  it("uses the server's time as the snapshot time", () => {
    expect(ok(cross).snapshot.at).toBe(new Date(cross.time).toISOString());
  });

  it("reports health as Infinity when there are no positions", () => {
    const { snapshot, isolatedCoins } = ok(noPositions);
    expect(snapshot.health).toBe(Number.POSITIVE_INFINITY);
    expect(snapshot.positions).toEqual([]);
    expect(isolatedCoins).toEqual([]);
  });

  it("refuses to call an isolated-only account safe, though its cross margin is 0", () => {
    const result = parseClearinghouseState(ADDRESS, isolatedOnly);
    expect(result).toMatchObject({ status: "unknown", reason: "ISOLATED_ONLY" });
  });

  it("takes accountValue from the cross summary, which excludes isolated margin", () => {
    const { snapshot } = ok(mixed);
    expect(Number(mixed.marginSummary.accountValue)).toBeGreaterThan(snapshot.accountValue);
    expect(snapshot.accountValue).toBe(Number(mixed.crossMarginSummary.accountValue));
    expect(snapshot.health).toBeCloseTo(106737.083711 / 8289.285705, 9);
  });

  it("names isolated coins, which a top-up cannot protect, and still lists them", () => {
    const { snapshot, isolatedCoins } = ok(mixed);
    expect(isolatedCoins).toEqual(["BTC", "SOL"]);
    expect(snapshot.positions.map((p) => p.coin)).toEqual(["ETH", "BTC", "SOL"]);
  });
});

describe("parseClearinghouseState on bad data", () => {
  const position = cross.assetPositions[0]!;

  it("keeps a null liquidation price", () => {
    const raw = {
      ...cross,
      assetPositions: [{ ...position, position: { ...position.position, liquidationPx: null } }],
    };
    expect(ok(raw).snapshot.positions[0]?.liquidationPx).toBeNull();
  });

  it("keeps a short position's negative size", () => {
    const raw = {
      ...cross,
      assetPositions: [{ ...position, position: { ...position.position, szi: "-0.5" } }],
    };
    expect(ok(raw).snapshot.positions[0]?.size).toBe(-0.5);
  });

  it("reports health below 1 rather than hiding a losing account", () => {
    const raw = {
      ...cross,
      crossMarginSummary: { ...cross.crossMarginSummary, accountValue: "-10.5" },
    };
    expect(ok(raw).snapshot.health).toBeLessThan(0);
  });

  it("is unknown when cross positions exist but maintenance margin reads 0", () => {
    const raw = { ...cross, crossMaintenanceMarginUsed: "0.0" };
    expect(parseClearinghouseState(ADDRESS, raw)).toMatchObject({
      status: "unknown",
      reason: "INCONSISTENT_MARGIN",
    });
  });

  it.each([
    ["null", null],
    ["a string", "oops"],
    ["an empty object", {}],
    ["a missing margin field", { ...cross, crossMaintenanceMarginUsed: undefined }],
    ["a non-numeric account value", { ...cross, crossMarginSummary: { accountValue: "abc" } }],
    ["an empty-string margin", { ...cross, crossMaintenanceMarginUsed: "" }],
    ["a negative margin", { ...cross, crossMaintenanceMarginUsed: "-1" }],
    ["a missing time", { ...cross, time: undefined }],
    ["positions that are not a list", { ...cross, assetPositions: {} }],
    [
      "an unknown margin mode",
      {
        ...cross,
        assetPositions: [
          { ...position, position: { ...position.position, leverage: { type: "portfolio" } } },
        ],
      },
    ],
    [
      "a position with a bad size",
      {
        ...cross,
        assetPositions: [{ ...position, position: { ...position.position, szi: "NaN" } }],
      },
    ],
  ])("is unknown, never safe, given %s", (_name, raw) => {
    expect(parseClearinghouseState(ADDRESS, raw)).toMatchObject({
      status: "unknown",
      reason: "MALFORMED_RESPONSE",
    });
  });
});

describe("getHealth", () => {
  it("posts a clearinghouseState request for the address", async () => {
    const fetch = scripted(json(cross));
    await getHealth(ADDRESS, { fetch, apiUrl: "https://hl.test", ...instant });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hl.test/info");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ type: "clearinghouseState", user: ADDRESS });
  });

  it("returns the snapshot on success", async () => {
    const result = await getHealth(ADDRESS, { fetch: scripted(json(cross)), ...instant });
    expect(result.status).toBe("ok");
  });

  it("recovers when a retry succeeds", async () => {
    const fetch = scripted(new Error("socket hang up"), json({}, 502), json(cross));
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result.status).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after 3 retries and reports unknown, never safe", async () => {
    const fetch = scripted(...Array.from({ length: 4 }, () => new Error("down")));
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result).toMatchObject({ status: "unknown", reason: "API_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("treats a hung request as a failure and aborts it at the timeout", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = await getHealth(ADDRESS, {
      fetch: hang as unknown as typeof fetch,
      timeoutMs: 5,
      ...instant,
    });
    expect(result).toMatchObject({ status: "unknown", reason: "API_ERROR" });
    expect(hang).toHaveBeenCalledTimes(4);
  });

  it("retries a rate limit", async () => {
    const fetch = scripted(json({}, 429), json(cross));
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result.status).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request the API rejected", async () => {
    const fetch = scripted(json({ error: "bad" }, 422));
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result).toMatchObject({ status: "unknown", reason: "API_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a body that is not JSON, then reports unknown", async () => {
    const fetch = scripted(
      ...Array.from({ length: 4 }, () => new Response("<html>", { status: 200 })),
    );
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result).toMatchObject({ status: "unknown", reason: "API_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reports a malformed body as unknown without retrying it", async () => {
    const fetch = scripted(json({ surprise: true }));
    const result = await getHealth(ADDRESS, { fetch, ...instant });
    expect(result).toMatchObject({ status: "unknown", reason: "MALFORMED_RESPONSE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["", "alice.near", "0x123", `${ADDRESS}00`])(
    "rejects %j as an address without calling the API",
    async (address) => {
      const fetch = scripted();
      const result = await getHealth(address, { fetch, ...instant });
      expect(result).toMatchObject({ status: "unknown", reason: "INVALID_ADDRESS" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("waits longer before each retry", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetch = scripted(...Array.from({ length: 4 }, () => new Error("down")));
    await getHealth(ADDRESS, { fetch, sleep, retryDelayMs: 100 });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
  });
});
