import type { AuditRecord } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { createExplainer, factsFor, templateExplanation } from "../src/explain";
import { sha256Hex } from "../src/signature";
import { record, rescueRequest, testSigner } from "./helpers";

const done = record({
  id: "a",
  kind: "RESCUE_DONE",
  healthBefore: 1.4286,
  healthAfter: 2.006,
  latencyMs: 41_000,
  oneClickStatus: "SUCCESS",
  request: rescueRequest({ amount: "18200000", usdNeeded: 17.68 }),
});

type Signing = { key?: ReturnType<typeof testSigner>; signatureStatus?: number; tamper?: boolean; kind?: string };

/** A NEAR AI Cloud stand-in: answers, then signs that exchange in its "enclave", as the real one does. */
function chat(content: string | null, status = 200, signing: Signing = {}) {
  const key = signing.key ?? testSigner();
  const calls: { url: string; init: RequestInit }[] = [];
  let sentBody = "";
  let answer = "";
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (content === null) throw new Error("fetch failed");
    if (String(url).includes("/signature/")) {
      if (signing.signatureStatus !== undefined) return new Response("{}", { status: signing.signatureStatus });
      const bytes = new TextEncoder().encode(signing.tamper ? `${answer} ` : answer);
      const text = `m:${sha256Hex(new TextEncoder().encode(sentBody))}:${sha256Hex(bytes)}`;
      return Response.json({ text, signature: key.sign(text), signing_address: key.address, signing_algo: "ecdsa", signature_kind: signing.kind ?? "provider_tee" });
    }
    sentBody = String(init.body);
    answer = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content } }] });
    return new Response(answer, { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const ATTESTED = testSigner().address;

const explainer = (fetchFn: typeof fetch, apiKey: string | null = "key", signers: readonly string[] = [ATTESTED], onUnknownSigner?: () => void) =>
  createExplainer({
    baseUrl: "https://near-ai.test/v1",
    apiKey,
    model: "m",
    fetch: fetchFn,
    log: () => {},
    signers: () => signers,
    sleep: async () => {},
    ...(onUnknownSigner ? { onUnknownSigner } : {}),
  });

describe("explain", () => {
  it("puts the exact figures first, then the model's words", async () => {
    const words = "Your position lost value, so your reserve topped it up.";
    const { fetchFn } = chat(words);
    expect(await explainer(fetchFn).explain(done)).toBe(`${templateExplanation(done)} ${words}`);
  });

  it("asks the configured model on the OpenAI-compatible endpoint, with the key", async () => {
    const { fetchFn, calls } = chat("Your position lost value.");
    await explainer(fetchFn).explain(done);
    expect(calls[0]?.url).toBe("https://near-ai.test/v1/chat/completions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer key");
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe("m");
    // A reasoning model would spend the whole token allowance thinking and never answer.
    expect((body as { reasoning_effort?: string }).reasoning_effort).toBe("none");
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toMatch(/digits/i);
    expect(body.messages[1]?.content).toContain("1.4286");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for the model by its own name with aliasing off, so the model's enclave signs, then fetches that signature", async () => {
    const { fetchFn, calls } = chat("Your position lost value.");
    await explainer(fetchFn).explain(done);
    expect(new Headers(calls[0]?.init.headers).get("x-no-aliasing")).toBe("true");
    expect(calls[1]?.url).toBe("https://near-ai.test/v1/signature/chatcmpl-1?model=m&signing_algo=ecdsa");
  });

  it("keeps only the facts when the answer's signature doesn't cover the bytes received", async () => {
    const { fetchFn } = chat("Your position lost value.", 200, { tamper: true });
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("keeps only the facts when there's no signature, or only the gateway's", async () => {
    expect(await explainer(chat("Your position lost value.", 200, { signatureStatus: 500 }).fetchFn).explain(done)).toBe(templateExplanation(done));
    expect(await explainer(chat("Your position lost value.", 200, { kind: "gateway" }).fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("keeps only the facts when the signer isn't one the attestation verified, and asks for a fresh check", async () => {
    let asked = 0;
    const { fetchFn } = chat("Your position lost value.", 200, { key: testSigner(3) });
    expect(await explainer(fetchFn, "key", [ATTESTED], () => (asked += 1)).explain(done)).toBe(templateExplanation(done));
    expect(asked).toBe(1);
  });

  it("keeps only the facts before any attestation has verified a signer", async () => {
    const { fetchFn } = chat("Your position lost value.");
    expect(await explainer(fetchFn, "key", []).explain(done)).toBe(templateExplanation(done));
  });

  it("keeps the keeper's own note word for word, whatever the model says", async () => {
    const note = "1Click still not finished after 30 minutes; last status PROCESSING. The money may still arrive.";
    const failed = record({ id: "a", kind: "RESCUE_FAILED", explanation: note });
    const { fetchFn } = chat("Your rescue is still being worked on.");
    expect(await explainer(fetchFn).explain(failed)).toContain(note);
  });

  it.each([
    ["a made-up number", "ETH fell by a lot, about 37 percent."],
    ["figures of its own", "Your health went from 18.20 to 1.43."],
    ["a link", "Check your account at evil.example for details."],
    ["a full link", "See https://evil.example/claim right away."],
  ])("drops the model's words if they contain %s", async (_name, words) => {
    const { fetchFn } = chat(words);
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it.each([
    ["RESCUE_FAILED", "The rescue succeeded and you are safe."],
    ["RESCUE_FAILED", "Lifeline moved your money to Hyperliquid."],
    ["RESCUE_BLOCKED", "Lifeline moved your money to Hyperliquid."],
    ["RESCUE_BLOCKED", "The rescue was completed."],
    ["RESCUE_DONE", "The rescue failed."],
    ["RESCUE_DONE", "Your position was liquidated."],
    ["RESCUE_ALLOWED", "The rescue has already finished."],
    ["RESCUE_ALLOWED", "The rescue failed."],
  ] as const)("drops words on %s that contradict what happened: %s", async (kind, words) => {
    const r = record({ id: "a", kind });
    const { fetchFn } = chat(words);
    expect(await explainer(fetchFn).explain(r)).toBe(templateExplanation(r));
  });

  it("doesn't mistake a denial for a contradiction", async () => {
    const r = record({ id: "a", kind: "RESCUE_BLOCKED" });
    const words = "No money moved, because your safety rules said no.";
    const { fetchFn } = chat(words);
    expect(await explainer(fetchFn).explain(r)).toBe(`${templateExplanation(r)} ${words}`);
  });

  it("doesn't count the 1 in 1Click as a digit", async () => {
    const words = "1Click handled the swap.";
    const { fetchFn } = chat(words);
    expect(await explainer(fetchFn).explain(done)).toBe(`${templateExplanation(done)} ${words}`);
  });

  it("falls back to the template when the API fails", async () => {
    const { fetchFn } = chat(null);
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("falls back on an error status", async () => {
    const { fetchFn } = chat("Your position lost value.", 500);
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
    const { fetchFn } = chat("<think>let me consider this</think>Your position lost value.");
    expect(await explainer(fetchFn).explain(done)).toBe(`${templateExplanation(done)} Your position lost value.`);
  });

  it("drops reasoning that never closes, instead of publishing it", async () => {
    const { fetchFn } = chat("<think>let me consider whether to mention the secret plan");
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("drops an answer the token limit cut off mid-sentence", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "Your health fell, so Lifeline" } }] }))) as unknown as typeof fetch;
    expect(await explainer(fetchFn).explain(done)).toBe(templateExplanation(done));
  });

  it("cuts an over-long answer at a sentence", async () => {
    const { fetchFn } = chat("Your position lost value. ".repeat(100));
    const text = await explainer(fetchFn).explain(done);
    expect((text?.length ?? 0) - templateExplanation(done).length).toBeLessThanOrEqual(401);
    expect(text?.endsWith(".")).toBe(true);
  });

  it("explains rescues, blocks and failures, but not warnings", async () => {
    const { fetchFn } = chat("Plain words.");
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

  it("doesn't send the keeper's note, which could quote a chain error naming an account", () => {
    const text = JSON.stringify(factsFor(record({ id: "a", kind: "RESCUE_FAILED", explanation: "The vault refused: alice.near is paused." })));
    expect(text).not.toContain("alice.near");
  });

  it("includes the coins involved", () => {
    expect(factsFor(done).coins).toEqual(["ETH"]);
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
