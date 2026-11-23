import { describe, expect, test } from "vitest";
import { handleMcp } from "../../mcp/src/protocol";
import { listTools, runTool, toArguments } from "../src/lib/mcp";
import { draftFromParams } from "../src/lib/policy";

// The page's client against the real server, so the two can't drift apart.
const tools = { info: async () => { throw new Error("down"); }, vault: async () => null, keeper: async () => [], now: () => new Date() };
const server = ((url: string, init: RequestInit) => handleMcp(new Request(url, init), { tools, allowedOrigins: [], allow: () => true })) as unknown as typeof fetch;

describe("the MCP client", () => {
  test("lists and runs the server's tools", async () => {
    expect((await listTools(server)).map((t) => t.name)).toContain("storm_test");
    expect(await runTool("explain_refusal", { code: "PAUSED" }, server)).toMatchObject({ isError: false, text: expect.stringContaining("paused") });
    expect(await runTool("check_account", { address: `0x${"1".repeat(40)}` }, server)).toMatchObject({ isError: true });
  });
  test("a refused call says why", async () => {
    await expect(runTool("nope", {}, server)).rejects.toThrow(/unknown tool/);
    await expect(listTools((async () => { throw new Error("x"); }) as unknown as typeof fetch)).rejects.toThrow(/reach/);
  });
  test("typed values become the tool's types", () => {
    const tool = { name: "t", title: "", description: "", inputSchema: { properties: { a: { type: "string", description: "" }, n: { type: "number", description: "" }, e: { type: "number", description: "" } } } };
    expect(toArguments(tool, { a: " x ", n: "1.5", e: " ", z: "no" })).toEqual({ a: "x", n: 1.5 });
  });
});

describe("a link that fills the policy form", () => {
  const from = (q: string) => draftFromParams(new URLSearchParams(q));
  test("fills what's well formed and keeps the rest standard", () => {
    expect(from(`hl=0x${"a".repeat(40)}&trigger=1.6&perRescue=12.5`)).toMatchObject({ hlAddress: `0x${"a".repeat(40)}`, trigger: "1.6", maxPerRescueUsdc: "12.5", target: "2" });
  });
  test.each(["", "user=alice.near", "hl=evil", "trigger=1e9&warn=-1", "perDay=<script>"])("ignores %s", (q) => expect(from(q)).toBeNull());
});
