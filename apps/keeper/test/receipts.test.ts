import { describe, expect, test } from "vitest";
import { GENESIS, linkHash } from "../src/receipts";
import { Store } from "../src/store";
import { openSqlite } from "../src/sql-node";
import { handleApi, NOT_AVAILABLE_ATTESTATION } from "../src/api";

const store = () => new Store(openSqlite(":memory:"));
const record = (n: number) => ({ id: `r${n}`, user: "alice.near", kind: "WARN" as const, at: `2026-11-24T00:00:0${n}Z` });
const fill = (s: Store, n: number) => {
  for (let i = 1; i <= n; i += 1) s.append(record(i));
};

describe("the chain", () => {
  test("seals oldest first, a little at a time", () => {
    const s = store();
    fill(s, 3);
    expect(s.receipts(null, 10)).toEqual({ head: null, before: null, entries: [] });
    expect([s.sealReceipts(2), s.sealReceipts(2), s.sealReceipts(2)]).toEqual([2, 1, 0]);
    const { head, entries } = s.receipts(0, 10);
    let hash = GENESIS;
    for (const e of entries) {
      hash = linkHash(hash, e.seq, e.json);
      expect(e.hash).toBe(hash);
    }
    expect(head).toEqual({ seq: 3, hash });
  });
  test("a restart goes on from where it was", () => {
    const db = openSqlite(":memory:");
    const first = new Store(db);
    fill(first, 2);
    first.sealReceipts(10);
    const second = new Store(db);
    second.append(record(3));
    second.sealReceipts(10);
    expect(second.receipts(2, 5)).toMatchObject({ before: { seq: 2 }, entries: [{ seq: 3 }] });
  });
  test("a seal the database refuses leaves nothing half done", () => {
    const s = store();
    fill(s, 2);
    const run = s.db.run.bind(s.db);
    let n = 0;
    s.db.run = (...args) => {
      n += 1;
      if (n === 2) throw new Error("full");
      run(...args);
    };
    expect(() => s.sealReceipts(5)).toThrow("full");
    s.db.run = run;
    expect(s.receipts(null, 5).entries).toEqual([]);
    expect(s.sealReceipts(5)).toBe(2);
  });
  test("receipts can't be changed or removed", () => {
    const s = store();
    fill(s, 1);
    s.sealReceipts(1);
    expect(() => s.db.run("UPDATE receipts SET hash = 'x'")).toThrow(/append-only/);
    expect(() => s.db.run("DELETE FROM receipts")).toThrow(/append-only/);
  });
  test("a changed record changes its hash, and so does a moved one", () => {
    expect(linkHash(GENESIS, 1, "a")).not.toBe(linkHash(GENESIS, 1, "b"));
    expect(linkHash(GENESIS, 1, "a")).not.toBe(linkHash(GENESIS, 2, "a"));
  });
  test("the newest ones, with the link before them", () => {
    const s = store();
    fill(s, 5);
    s.sealReceipts(9);
    expect(s.receipts(null, 2)).toMatchObject({ before: { seq: 3 }, entries: [{ seq: 4 }, { seq: 5 }] });
    expect(s.receipts(5, 2)).toMatchObject({ before: { seq: 5 }, entries: [] });
  });
});

describe("GET /api/receipts", () => {
  const s = store();
  fill(s, 3);
  const call = (path: string, method = "GET") =>
    handleApi(new Request(`https://k.test${path}`, { method }), { store: s, now: () => new Date(), botUsername: null, attestation: () => NOT_AVAILABLE_ATTESTATION, corsOrigin: "*" });
  test("seals, then answers", async () => {
    expect(await (await call("/api/receipts?after=1&limit=1")).json()).toMatchObject({ head: { seq: 3 }, before: { seq: 1 }, entries: [{ seq: 2 }] });
  });
  test.each([["/api/receipts?after=-1", "GET", 400], ["/api/receipts?after=x", "GET", 400], ["/api/receipts", "POST", 405]])("%s %s", async (path, method, status) => expect((await call(path, method)).status).toBe(status));
});
