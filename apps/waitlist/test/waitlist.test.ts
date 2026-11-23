import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { cleanEmail, cleanText, parseEntry } from "../src/entry";
import { checkPow, issueChallenge, leadingZeroBits, powDigest } from "../src/pow";
import { createWaitlist, csvCell, type WaitlistStorage } from "../src/waitlist";

const SITE = "https://lifeline.prashantthakur.dev";
const BITS = 4;

function fakeStorage(): WaitlistStorage {
  const db = new Database(":memory:");
  return {
    sql: {
      exec(query, ...bindings) {
        if (bindings.length === 0 && (query.match(/;/g)?.length ?? 0) > 1) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        const found = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
        return { toArray: () => found };
      },
    },
    transactionSync: (work) => db.transaction(work)(),
  };
}

const ENTRY = { name: "Asha", email: "asha@example.com", role: "trader", venues: ["hyperliquid"], chains: ["base"], size: "1k-10k", liquidated: true, wants: ["agents"], note: "3 am", consent: true };

function setup(adminToken: string | null = "admin") {
  const clock = { at: Date.parse("2026-11-24T10:00:00Z") };
  const storage = fakeStorage();
  const list = createWaitlist({ storage, allowedOrigins: [SITE], adminToken, powBits: BITS, now: () => new Date(clock.at) });
  const call = (path: string, init?: RequestInit & { ip?: string }) =>
    list.handle(new Request(`https://w.test${path}`, { ...init, headers: { origin: SITE, "cf-connecting-ip": init?.ip ?? "1.1.1.1", ...(init?.headers ?? {}) } }));
  const solve = async () => {
    const { challenge } = (await (await call("/api/challenge")).json()) as { challenge: string };
    let n = 0;
    while (leadingZeroBits(powDigest(challenge, String(n))) < BITS) n += 1;
    return { challenge, nonce: String(n) };
  };
  const join = async (over: Record<string, unknown> = {}, ip = "1.1.1.1") =>
    call("/api/join", { method: "POST", ip, body: JSON.stringify({ ...ENTRY, ...(await solve()), ...over }) });
  const exported = async () => (await call("/api/export", { headers: { authorization: "Bearer admin" } })).text();
  return { list, call, solve, join, exported, clock, storage };
}

describe("entries", () => {
  test("a good one is cleaned", () => {
    expect(parseEntry({ ...ENTRY, name: "  A\u202e sha\n ", email: " ASHA@Example.com " })).toMatchObject({ name: "A sha", email: "asha@example.com" });
  });
  test.each([
    [{ name: " " }, /call you/],
    [{ email: "nope" }, /email/],
    [{ role: "king" }, /brings you/],
    [{ venues: ["mars"] }, /list/],
    [{ venues: "hyperliquid" }, /list/],
    [{ size: "huge" }, /list/],
    [{ liquidated: "yes" }, /list/],
    [{ consent: false }, /yes/],
    [{ consent: "true" }, /yes/],
  ])("refuses %o", (over, why) => expect(parseEntry({ ...ENTRY, ...over })).toMatch(why));
  test("refuses what isn't an object", () => expect(parseEntry(null)).toMatch(/entry/));
  test("repeats collapse and text is cut by character, not byte", () => {
    expect(parseEntry({ ...ENTRY, wants: ["agents", "agents"] })).toMatchObject({ wants: ["agents"] });
    expect(cleanText("🛟🛟🛟", 2)).toBe("🛟🛟");
  });
  test.each(["a@b.co", "a.b+c@sub.example.org"])("accepts %s", (e) => expect(cleanEmail(e)).toBe(e));
  test.each(["a@b", "a b@c.co", "a@b..co", "@b.co", "a@-b.co", `${"x".repeat(65)}@b.co`])("refuses %s", (e) => expect(cleanEmail(e)).toBeNull());
});

describe("proof of work", () => {
  test("counts zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x10]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array(2))).toBe(16);
  });
  test("knows its own challenges, and how old they are", () => {
    const c = issueChallenge("s", 1_800_000_000_000);
    expect(checkPow("s", c, "0", 0, 1_800_000_000_000)).toBeNull();
    expect(checkPow("other", c, "0", 0, 1_800_000_000_000)).toBe("bad");
    expect(checkPow("s", c, "0", 0, 1_800_000_000_000 + 31 * 60_000)).toBe("expired");
    expect(checkPow("s", c, "0", 0, 1_799_999_999_999)).toBe("expired");
    expect(checkPow("s", c, "0", 200, 1_800_000_000_000)).toBe("weak");
    expect(checkPow("s", c.replace(/^1/, "2"), "0", 0, 1_800_000_000_000)).toBe("bad");
    expect(checkPow("s", 4, "0", 0, 0)).toBe("bad");
  });
});

describe("joining", () => {
  test("gives a berth and a leave code, and keeps the entry", async () => {
    const { join, exported } = setup();
    const answer = (await (await join()).json()) as { berth: string; leaveCode: string };
    expect(answer.berth).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(answer.leaveCode).toMatch(/^[0-9a-f]{24}$/);
    expect(await exported()).toContain("asha@example.com");
  });
  test("a repeat looks the same and changes nothing", async () => {
    const { join, exported } = setup();
    const first = (await (await join()).json()) as { berth: string };
    const again = await join({ name: "Mallory" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { berth: string }).berth).toBe(first.berth);
    expect(await exported()).not.toContain("Mallory");
  });
  test("a challenge works once", async () => {
    const { call, solve } = setup();
    const pow = await solve();
    const send = () => call("/api/join", { method: "POST", body: JSON.stringify({ ...ENTRY, ...pow }) });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
  });
  test("needs the work done, and says when it's stale", async () => {
    const { join, call, solve, clock } = setup();
    expect((await join({ nonce: "x".repeat(40) })).status).toBe(400);
    const pow = await solve();
    clock.at += 31 * 60_000;
    expect((await call("/api/join", { method: "POST", body: JSON.stringify({ ...ENTRY, ...pow }) })).status).toBe(410);
  });
  test("a bot that fills the hidden field is answered but not kept", async () => {
    const { join, exported } = setup();
    expect((await join({ website: "http://spam" })).status).toBe(200);
    expect(await exported()).not.toContain("asha");
  });
  test("five an hour from one place", async () => {
    const { join, clock } = setup();
    for (let i = 0; i < 5; i += 1) expect((await join({ email: `a${i}@example.com` })).status).toBe(200);
    expect((await join({ email: "a6@example.com" })).status).toBe(429);
    expect((await join({ email: "a6@example.com" }, "2.2.2.2")).status).toBe(200);
    clock.at += 61 * 60_000;
    expect((await join({ email: "a7@example.com" })).status).toBe(200);
  });
  test("another site can't post here, and big or broken bodies are refused", async () => {
    const { call } = setup();
    expect((await call("/api/join", { method: "POST", body: "{}", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await call("/api/join", { method: "POST", body: "x".repeat(5000) })).status).toBe(413);
    expect((await call("/api/join", { method: "POST", body: "{" })).status).toBe(400);
  });
  test("a failing database is a plain 500", async () => {
    const { join, storage } = setup();
    storage.transactionSync = () => {
      throw new Error("secret detail");
    };
    const answer = await join();
    expect(answer.status).toBe(500);
    expect(await answer.text()).not.toContain("secret detail");
  });
});

describe("leaving", () => {
  test("only the first code takes the entry off, and the answer never says which it was", async () => {
    const { join, call, exported } = setup();
    const { leaveCode } = (await (await join()).json()) as { leaveCode: string };
    const { leaveCode: later } = (await (await join()).json()) as { leaveCode: string };
    const leave = async (code: string) => (await call("/api/leave", { method: "POST", body: JSON.stringify({ email: ENTRY.email, leaveCode: code }) })).json();
    expect(await leave(later)).toEqual({ ok: true });
    expect(await exported()).toContain("asha@example.com");
    expect(await leave(leaveCode)).toEqual({ ok: true });
    expect(await exported()).not.toContain("asha@example.com");
    expect((await call("/api/leave", { method: "POST", body: "{}" })).status).toBe(400);
  });
});

describe("what others can read", () => {
  test("no count is served: it would say whether an email was new", async () => expect((await setup().call("/api/summary")).status).toBe(404));
  test("the export needs the token, and is off without one", async () => {
    const { call } = setup();
    expect((await call("/api/export")).status).toBe(401);
    expect((await call("/api/export", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await setup(null).call("/api/export")).status).toBe(404);
  });
  test("a note can't become a spreadsheet formula", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("plain")).toBe('"plain"');
  });
  test("CORS names our site only", async () => {
    const { call } = setup();
    expect((await call("/")).headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await call("/", { headers: { origin: "https://evil.test" } })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await call("/api/join", { method: "OPTIONS" })).status).toBe(204);
    expect((await call("/nothing")).status).toBe(404);
  });
});
