import { describe, expect, it } from "vitest";
import { getTokens } from "../src/tokens";
import recorded from "./recorded/tokens.json";

const respond = (body: unknown, status = 200) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

describe("getTokens", () => {
  it("reads 1Click's real token list", async () => {
    const { fetch, calls } = respond(recorded);
    const tokens = await getTokens({ apiUrl: "https://1click.test", fetch });
    expect(calls[0]?.url).toBe("https://1click.test/v0/tokens");
    expect(tokens).toHaveLength(recorded.length);
    const usdc = tokens.find((t) => t.assetId === "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(usdc).toMatchObject({ blockchain: "near", symbol: "USDC", decimals: 6 });
    expect(typeof usdc?.priceUsd).toBe("number");
  });

  it("sends the JWT when there is one", async () => {
    const { fetch, calls } = respond(recorded);
    await getTokens({ apiUrl: "https://1click.test", jwt: "token-1", fetch });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("skips an entry it can't read rather than offering a broken token", async () => {
    const { fetch } = respond([...recorded, { assetId: "x" }, { assetId: "y", blockchain: "eth", symbol: "Z", decimals: "six" }]);
    expect(await getTokens({ apiUrl: "https://1click.test", fetch })).toHaveLength(recorded.length);
  });

  it("says what went wrong when 1Click refuses", async () => {
    const { fetch } = respond({ message: "Unauthorized" }, 401);
    await expect(getTokens({ apiUrl: "https://1click.test", fetch })).rejects.toThrow("1Click 401: Unauthorized");
  });

  it("refuses an answer that isn't a list", async () => {
    const { fetch } = respond({ tokens: [] });
    await expect(getTokens({ apiUrl: "https://1click.test", fetch })).rejects.toThrow(/list/);
  });
});
