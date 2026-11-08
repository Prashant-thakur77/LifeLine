import { describe, expect, it } from "vitest";
import { serveWithEdgeCache, type EdgeCache } from "../src/cloudflare/edge-cache";

/** Cloudflare's cache, as far as this code uses it: by URL, honouring max-age. */
function fakeCache(): EdgeCache & { size(): number } {
  const entries = new Map<string, Response>();
  return {
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => {
      expect(response.headers.get("cache-control")).toMatch(/max-age=\d+/);
      entries.set(request.url, response.clone());
    },
    size: () => entries.size,
  };
}

const setup = (status = 200) => {
  let calls = 0;
  const cache = fakeCache();
  const pending: Promise<unknown>[] = [];
  const serve = async (url: string, init?: RequestInit) => {
    const response = await serveWithEdgeCache(new Request(url, init), {
      cache,
      upstream: async () => {
        calls += 1;
        return Response.json({ n: calls }, { status });
      },
      waitUntil: (work) => pending.push(work),
    });
    await Promise.all(pending);
    return response;
  };
  return { serve, calls: () => calls, cache };
};

describe("the edge cache in front of the keeper", () => {
  it("answers repeated reads of the API from the cache for a few seconds", async () => {
    const t = setup();
    expect(await (await t.serve("https://k.example/api/stats")).json()).toEqual({ n: 1 });
    expect(await (await t.serve("https://k.example/api/stats")).json()).toEqual({ n: 1 });
    expect(t.calls()).toBe(1);
  });

  it("keeps different queries apart", async () => {
    const t = setup();
    await t.serve("https://k.example/api/audit?user=a.near");
    await t.serve("https://k.example/api/audit?user=b.near");
    expect(t.calls()).toBe(2);
  });

  it.each([
    ["a POST", "https://k.example/api/telegram/link", { method: "POST", body: "{}" }],
    ["Telegram's webhook", "https://k.example/telegram/webhook", { method: "POST", body: "{}" }],
    ["the status page", "https://k.example/", undefined],
  ])("never caches %s", async (_name, url, init) => {
    const t = setup();
    await t.serve(url, init);
    await t.serve(url, init);
    expect(t.calls()).toBe(2);
    expect(t.cache.size()).toBe(0);
  });

  it("never caches an error", async () => {
    const t = setup(503);
    await t.serve("https://k.example/api/stats");
    await t.serve("https://k.example/api/stats");
    expect(t.calls()).toBe(2);
  });
});
