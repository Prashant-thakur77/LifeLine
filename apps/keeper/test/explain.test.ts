import type { AuditRecord } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { createExplainer, factsFor, isGrounded, templateExplanation } from "../src/explain";
import { record, rescueRequest } from "./helpers";

const done = record({
  id: "a",
  kind: "RESCUE_DONE",
  healthBefore: 1.4286,
  healthAfter: 2.006,
  latencyMs: 41_000,
  oneClickStatus: "SUCCESS",
  request: rescueRequest({ amount: "18200000", usdNeeded: 17.68 }),
});

function chat(content: string | null, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (content === null) throw new Error("fetch failed");
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const explainer = (fetchFn: typeof fetch, apiKey: string | null = "key") =>
  createExplainer({ baseUrl: "https://near-ai.test/v1", apiKey, model: "m", fetch: fetchFn, log: () => {} });

describe("explain", () => {
  it("returns the model's words when they stick to the facts", async () => {
    const text = "Your health fell to 1.43, so Lifeline moved 18.20 USDC. Health is now 2.01.";
    const { fetchFn } = chat(text);
    expect(await explainer(fetchFn).explain(done)).toBe(text);
  });

  it("asks the configured model on the OpenAI-compatible endpoint, with the key", async () => {
    const { fetchFn, calls } = chat("Health fell to 1.43.");
    await explainer(fetchFn).explain(done);
    expect(calls[0]?.url).toBe("https://near-ai.test/v1/chat/completions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer key");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe("m");
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.content).toContain("1.4286");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a made-up number, because the ledger can't carry a false figure", async () => {
    const { fetchFn } = chat("ETH fell 37% and Lifeline moved 999 USDC.");
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("falls back to the template when the API fails", async () => {
    const { fetchFn } = chat(null);
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("falls back on an error status", async () => {
    const { fetchFn } = chat("Health fell.", 500);
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("falls back on an empty or odd answer", async () => {
    expect(await explainer(chat("   ").fetchFn).explain(done)).toBe(templateExplanation(done));
    const odd = (async () => new Response(JSON.stringify({ nope: true }))) as unknown as typeof fetch;
    expect(await explainer(odd).explain(done)).toBe(templateExplanation(done));
  });

  it("uses the template with no API key, and calls nothing", async () => {
    const { fetchFn, calls } = chat("x");
    expect(await explainer(fetchFn, null).explain(done)).toBe(templateExplanation(done));
    expect(calls).toEqual([]);
  });

  it("removes any reasoning a model thinks out loud", async () => {
    const { fetchFn } = chat("<think>let me consider 777</think>Health fell to 1.43.");
    expect(await explainer(fetchFn).explain(done)).toBe("Health fell to 1.43.");
  });

  it("cuts an over-long answer", async () => {
    const { fetchFn } = chat("Health fell. ".repeat(200));
    expect((await explainer(fetchFn).explain(done))?.length).toBeLessThanOrEqual(600);
  });

  it("explains rescues, blocks and failures, but not warnings", async () => {
    const { fetchFn } = chat("Done.");
    for (const kind of ["RESCUE_ALLOWED", "RESCUE_DONE", "RESCUE_BLOCKED", "RESCUE_FAILED"] as const) {
      expect(await explainer(fetchFn).explain(record({ id: "a", kind }))).toBeDefined();
    }
    expect(await explainer(fetchFn).explain(record({ id: "a", kind: "WARN" }))).toBeUndefined();
  });

  it("never throws", async () => {
    const broken = (() => {
      throw new Error("sync failure");
    }) as unknown as typeof fetch;
    await expect(explainer(broken).explain(done)).resolves.toBe(templateExplanation(done));
  });
});

describe("factsFor", () => {
  it("gives the model the numbers, and the reasons in plain words", () => {
    const facts = factsFor(record({ id: "a", kind: "RESCUE_BLOCKED", healthBefore: 1.4, decision: { verdict: "block", reasons: ["PAUSED"] } }));
    expect(facts.healthBefore).toBe(1.4);
    expect(facts.reasons?.[0]).toContain("paused");
  });

  it("doesn't send account names, addresses or deposit details anywhere", () => {
    const text = JSON.stringify(factsFor(done));
    expect(text).not.toContain("alice.near");
    expect(text).not.toContain("0x1111");
    expect(text).not.toContain("deposit-1");
  });

  it("includes the coins involved", () => {
    expect(factsFor(done).coins).toEqual(["ETH"]);
  });
});

describe("isGrounded", () => {
  const facts = { healthBefore: 1.4286, amountUsdc: 18.2, note: "24-hour limit" };

  it("accepts a fact rounded any way", () => {
    expect(isGrounded("Health was 1.43, or 1.4, and 18.20 USDC moved.", facts)).toBe(true);
  });

  it("accepts numbers that appear in the fact text", () => {
    expect(isGrounded("Your 24-hour limit was reached.", facts)).toBe(true);
  });

  it("doesn't count the 1 in 1Click as a number", () => {
    expect(isGrounded("1Click delivered it.", {})).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isGrounded("Health was 1.5.", facts)).toBe(false);
    expect(isGrounded("It fell 6% in 20 minutes.", facts)).toBe(false);
  });

  it("accepts text with no numbers", () => {
    expect(isGrounded("Your health recovered.", facts)).toBe(true);
  });
});

describe("templateExplanation", () => {
  const cases: [string, AuditRecord][] = [
    ["RESCUE_ALLOWED", record({ id: "a", kind: "RESCUE_ALLOWED", healthBefore: 1.43, request: rescueRequest({ amount: "18200000" }) })],
    ["RESCUE_DONE", done],
    ["RESCUE_BLOCKED", record({ id: "a", kind: "RESCUE_BLOCKED", healthBefore: 1.43, decision: { verdict: "block", reasons: ["PAUSED"] } })],
    ["RESCUE_FAILED", record({ id: "a", kind: "RESCUE_FAILED", healthBefore: 1.43, oneClickStatus: "REFUNDED" })],
  ];

  it.each(cases)("writes a real sentence for %s", (_kind, r) => {
    const text = templateExplanation(r);
    expect(text.length).toBeGreaterThan(30);
    expect(text).not.toMatch(/undefined|NaN|null/);
  });

  it("states the figures of a finished rescue", () => {
    const text = templateExplanation(done);
    expect(text).toContain("1.43");
    expect(text).toContain("2.01");
    expect(text).toContain("18.20");
  });

  it("keeps the keeper's own factual note when a record has one", () => {
    const r = record({ id: "a", kind: "RESCUE_FAILED", explanation: "The vault refused this rescue: paused." });
    expect(templateExplanation(r)).toContain("The vault refused this rescue: paused.");
  });

  it("copes with a record that has no details", () => {
    for (const kind of ["RESCUE_ALLOWED", "RESCUE_DONE", "RESCUE_BLOCKED", "RESCUE_FAILED"] as const) {
      expect(templateExplanation(record({ id: "a", kind }))).not.toMatch(/undefined|NaN/);
    }
  });
});
