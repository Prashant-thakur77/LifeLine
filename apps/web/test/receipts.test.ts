import { describe, expect, test } from "vitest";
import { linkHash as keeperHash } from "../../keeper/src/receipts";
import type { ReceiptLink, ReceiptsResponse } from "../src/lib/keeper";
import { checkReceipts, linkHash, loadWitness, relink, saveWitness } from "../src/lib/receipts";

const chain = (n: number, text = (i: number) => `{"n":${i}}`) => {
  const out: ReceiptsResponse["entries"] = [];
  let hash = "0".repeat(64);
  for (let seq = 1; seq <= n; seq += 1) {
    hash = linkHash(hash, seq, text(seq));
    out.push({ seq, hash, json: text(seq) });
  }
  return out;
};
const link = ({ seq, hash }: ReceiptLink) => ({ seq, hash });
const server = (all: ReceiptsResponse["entries"], page = 3) => async (after: number | null): Promise<ReceiptsResponse> => {
  const entries = after === null ? all.slice(-page) : all.filter((e) => e.seq > after).slice(0, page);
  const first = entries[0]?.seq ?? (after ?? 0) + 1;
  const before = all.findLast((e) => e.seq < first);
  return { head: all.length ? link(all.at(-1)!) : null, before: before ? link(before) : null, entries };
};
const all = chain(10);

test("the same hash as the keeper's", () => expect(linkHash("a".repeat(64), 7, "{}")).toBe(keeperHash("a".repeat(64), 7, "{}")));

describe("relinking", () => {
  test("from the start, and from the middle", () => {
    expect(relink(null, all)).toEqual({ last: link(all[9]!) });
    expect(relink(link(all[4]!), all.slice(5))).toEqual({ last: link(all[9]!) });
  });
  test("a changed, moved or missing record breaks it", () => {
    expect(relink(null, all.map((e) => (e.seq === 3 ? { ...e, json: "{}" } : e)))).toEqual({ brokenAt: 3 });
    expect(relink(null, all.filter((e) => e.seq !== 5))).toEqual({ brokenAt: 6 });
    expect(relink(link(all[4]!), [all[3]!])).toEqual({ brokenAt: 4 });
  });
});

describe("checking the log", () => {
  test("a first visit is trusted, and remembered", async () => {
    expect(await checkReceipts(server(all), null)).toMatchObject({ judged: { verdict: "trusted" }, witness: link(all[9]!) });
  });
  test("a later one is proven, across pages", async () => {
    const r = await checkReceipts(server(all), link(all[1]!));
    expect(r).toMatchObject({ judged: { verdict: "proven" }, witness: link(all[9]!) });
    expect(r.judged.facts[0]).toEqual(["Links checked here", "8"]);
  });
  test("nothing new is still proven", async () => expect(await checkReceipts(server(all), link(all[9]!))).toMatchObject({ judged: { verdict: "proven" }, witness: link(all[9]!) }));
  test("a very long gap is checked part of the way and goes on next time", async () => {
    expect(await checkReceipts(server(chain(40)), link(chain(1)[0]!))).toMatchObject({ judged: { verdict: "trusted" }, witness: { seq: 16 } });
  });
  test.each([
    ["a rewritten past", server(chain(10, (i) => `{"fake":${i}}`)), all[4]!],
    ["a shortened log", server(chain(3)), all[4]!],
    ["an emptied log", server([]), all[4]!],
    ["a record changed after", server(all.map((e) => (e.seq === 7 ? { ...e, json: "{}" } : e))), all[4]!],
  ])("%s fails, and isn't remembered", async (_, read, w) => {
    expect(await checkReceipts(read, link(w))).toMatchObject({ judged: { verdict: "failed" }, witness: null });
  });
  test("a newest link the records don't lead to fails", async () => {
    const read = async (after: number | null) => ({ ...(await server(all)(after)), head: { seq: 10, hash: "f".repeat(64) } });
    expect((await checkReceipts(read, null)).judged.verdict).toBe("failed");
  });
  test("newer records that aren't shown fail", async () => {
    const read = async () => ({ head: { seq: 999, hash: "f".repeat(64) }, before: link(all[4]!), entries: [] });
    expect((await checkReceipts(read, link(all[4]!))).judged.verdict).toBe("failed");
  });
  test("an empty log on a first visit says so", async () => expect((await checkReceipts(server([]), null)).judged).toMatchObject({ verdict: "trusted", finding: expect.stringMatching(/no sealed/) }));
});

describe("remembering", () => {
  const map = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
  test("what it saved it reads, and nothing malformed", () => {
    saveWitness("b", link(all[0]!), storage);
    expect(loadWitness("b", storage)).toEqual(link(all[0]!));
    map.set("lifeline:receipts:b", '{"seq":-1,"hash":"x"}');
    expect(loadWitness("b", storage)).toBeNull();
    map.set("lifeline:receipts:b", "{");
    expect(loadWitness("b", storage)).toBeNull();
  });
  test("blocked storage is a first visit", () => {
    const blocked = () => { throw new Error("blocked"); };
    expect(loadWitness("b", blocked)).toBeNull();
    expect(() => saveWitness("b", link(all[0]!), blocked)).not.toThrow();
  });
});
