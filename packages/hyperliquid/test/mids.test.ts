import { describe, expect, it } from "vitest";
import { getMidPrice } from "../src/index";

const answering = (body: unknown, status = 200) => {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, bodies };
};

describe("getMidPrice", () => {
  it("reads a coin's price from allMids", async () => {
    const { fetchFn, bodies } = answering({ BTC: "76029.5", ETH: "2238.05" });
    expect(await getMidPrice("ETH", { fetch: fetchFn })).toBe(2238.05);
    expect(bodies[0]).toEqual({ type: "allMids" });
  });

  it("throws for a coin it doesn't list, rather than returning nothing", async () => {
    const { fetchFn } = answering({ BTC: "76029.5" });
    await expect(getMidPrice("ETH", { fetch: fetchFn })).rejects.toThrow(/ETH/);
  });

  it.each(["not a number", "0", "-5", null])("throws on a bad price: %s", async (price) => {
    const { fetchFn } = answering({ ETH: price });
    await expect(getMidPrice("ETH", { fetch: fetchFn })).rejects.toThrow(/ETH/);
  });

  it("throws on a malformed answer", async () => {
    const { fetchFn } = answering(["nope"]);
    await expect(getMidPrice("ETH", { fetch: fetchFn })).rejects.toThrow();
  });

  it("throws when the API fails", async () => {
    const { fetchFn } = answering({ error: "bad" }, 400);
    await expect(getMidPrice("ETH", { fetch: fetchFn, retries: 0 })).rejects.toThrow();
  });
});
