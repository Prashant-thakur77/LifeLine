import { describe, expect, it } from "vitest";
import { createRecordPipeline } from "../src/pipeline";
import { openStore } from "../src/sql-node";
import { record, USER } from "./helpers";

const setup = (options: { explain?: Parameters<typeof createRecordPipeline>[0]["explain"]; notifyThrows?: boolean } = {}) => {
  const store = openStore(":memory:");
  const notified: { id: string; explanation?: string }[] = [];
  const pipeline = createRecordPipeline({
    store,
    explain: options.explain ?? (async () => ({ text: "Plain words." })),
    notify: async (r) => {
      if (options.notifyThrows) throw new Error("telegram down");
      notified.push({ id: r.id, ...(r.explanation ? { explanation: r.explanation } : {}) });
    },
    log: () => {},
  });
  return { store, notified, pipeline };
};

describe("the record pipeline", () => {
  it("saves the explanation with the record, for the API and ledger", async () => {
    const { store, pipeline } = setup();
    const r = record({ id: "a", kind: "RESCUE_DONE" });
    store.append(r);
    pipeline.handle(r);
    await pipeline.settled();
    expect(store.audit(USER, 1)[0]?.explanation).toBe("Plain words.");
    expect(store.ledger(1)[0]?.explanation).toBe("Plain words.");
    expect(store.latest(USER, "RESCUE_DONE")?.explanation).toBe("Plain words.");
  });

  it("keeps the proof behind the model's words, for anyone to check", async () => {
    const proof = { model: "m", requestBase64: "", responseBase64: "", signedText: "m:a:b", signature: "0x", signingAddress: "0xabc", verifiedAt: "2026-11-09T09:00:00.000Z" };
    const { store, pipeline } = setup({ explain: async () => ({ text: "Facts. Words.", proof }) });
    const r = record({ id: "a", kind: "RESCUE_DONE" });
    store.append(r);
    pipeline.handle(r);
    await pipeline.settled();
    expect(store.proof("a")?.proof).toEqual(proof);
    store.append(record({ id: "b", kind: "RESCUE_BLOCKED" }));
    pipeline.backfill();
    await pipeline.settled();
    expect(store.proof("b")?.proof).toEqual(proof);
  });

  it("sends the explanation to Telegram too", async () => {
    const { store, notified, pipeline } = setup();
    const r = record({ id: "a", kind: "RESCUE_DONE" });
    store.append(r);
    pipeline.handle(r);
    await pipeline.settled();
    expect(notified).toEqual([{ id: "a", explanation: "Plain words." }]);
  });

  it("still notifies when there's nothing to explain", async () => {
    const { store, notified, pipeline } = setup({ explain: async () => undefined });
    const r = record({ id: "a", kind: "WARN" });
    store.append(r);
    pipeline.handle(r);
    await pipeline.settled();
    expect(notified).toEqual([{ id: "a" }]);
  });

  it("keeps a user's records in order, even if an early one is slow to explain", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, notified, pipeline } = setup({
      explain: async (r) => {
        if (r.id === "first") await gate;
        return { text: "x" };
      },
    });
    for (const id of ["first", "second"]) {
      const r = record({ id, kind: "RESCUE_DONE" });
      store.append(r);
      pipeline.handle(r);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(notified).toEqual([]);
    release();
    await pipeline.settled();
    expect(notified.map((n) => n.id)).toEqual(["first", "second"]);
  });

  it("doesn't let one user's slow explanation hold up another's", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, notified, pipeline } = setup({
      explain: async (r) => {
        if (r.id === "slow") await gate;
        return { text: "x" };
      },
    });
    const slow = record({ id: "slow", kind: "RESCUE_DONE" });
    const quick = record({ id: "quick", kind: "RESCUE_DONE", user: "bob.near" });
    store.append(slow);
    store.append(quick);
    pipeline.handle(slow);
    pipeline.handle(quick);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(notified.map((n) => n.id)).toEqual(["quick"]);
    release();
    await pipeline.settled();
  });

  it("never throws, whatever breaks", async () => {
    const { store, pipeline } = setup({
      notifyThrows: true,
      explain: async () => {
        throw new Error("model down");
      },
    });
    const r = record({ id: "a", kind: "RESCUE_DONE" });
    store.append(r);
    expect(() => pipeline.handle(r)).not.toThrow();
    await expect(pipeline.settled()).resolves.toBeUndefined();
  });

  it("explains records a crash left unexplained, without messaging anyone twice", async () => {
    const { store, notified, pipeline } = setup();
    store.append(record({ id: "a", kind: "RESCUE_DONE" }));
    store.append(record({ id: "b", kind: "WARN" }));
    store.append(record({ id: "c", kind: "RESCUE_FAILED" }));
    store.setExplanation("c", "Already explained.");
    pipeline.backfill();
    await pipeline.settled();
    expect(store.audit(USER, 3).map((r) => r.explanation)).toEqual(["Already explained.", undefined, "Plain words."]);
    expect(notified).toEqual([]);
  });

  it("leaves the audit log itself untouched, because it's append-only", async () => {
    const { store, pipeline } = setup();
    const r = record({ id: "a", kind: "RESCUE_FAILED", explanation: "The keeper's own note." });
    store.append(r);
    pipeline.handle(r);
    await pipeline.settled();
    const raw = store.db.get("SELECT json FROM audit WHERE id = 'a'") as { json: string };
    expect((JSON.parse(raw.json) as { explanation: string }).explanation).toBe("The keeper's own note.");
    expect(store.audit(USER, 1)[0]?.explanation).toBe("Plain words.");
  });
});
