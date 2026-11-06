import type { HealthResponse } from "@lifeline/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { percentile, Store } from "../src/store";
import { AT, policy, record, rescueRequest, snapshot, USER } from "./helpers";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("the audit log", () => {
  it("returns a record exactly as it was written", () => {
    const written = record({
      id: "a",
      kind: "RESCUE_DONE",
      request: rescueRequest(),
      decision: { verdict: "allow", reasons: [] },
      healthBefore: 1.47,
      healthAfter: 2.01,
      latencyMs: 41000,
    });
    store.append(written);
    expect(store.audit(USER, 10)).toEqual([written]);
  });

  it("lists newest first", () => {
    for (const id of ["a", "b", "c"]) store.append(record({ id, kind: "WARN" }));
    expect(store.audit(USER, 10).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps each user's records apart, and the ledger shows everyone", () => {
    store.append(record({ id: "a", kind: "WARN" }));
    store.append(record({ id: "b", kind: "WARN", user: "bob.near" }));
    expect(store.audit("bob.near", 10).map((r) => r.id)).toEqual(["b"]);
    expect(store.ledger(10).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("applies the limit to the newest records", () => {
    for (const id of ["a", "b", "c"]) store.append(record({ id, kind: "WARN" }));
    expect(store.ledger(2).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("refuses to change a record", () => {
    store.append(record({ id: "a", kind: "WARN" }));
    expect(() => store.db.prepare("UPDATE audit SET kind = 'RESCUE_DONE'").run()).toThrow(/append-only/);
    expect(store.audit(USER, 1)[0]?.kind).toBe("WARN");
  });

  it("refuses to delete a record", () => {
    store.append(record({ id: "a", kind: "WARN" }));
    expect(() => store.db.prepare("DELETE FROM audit").run()).toThrow(/append-only/);
    expect(store.audit(USER, 10)).toHaveLength(1);
  });

  it("refuses a second record with the same id", () => {
    store.append(record({ id: "a", kind: "WARN" }));
    expect(() => store.append(record({ id: "a", kind: "RESCUE_DONE" }))).toThrow();
  });

  it("finds the newest record of a kind for a user", () => {
    store.append(record({ id: "a", kind: "WARN" }));
    store.append(record({ id: "b", kind: "WARN" }));
    store.append(record({ id: "c", kind: "WARN", user: "bob.near" }));
    store.append(record({ id: "d", kind: "RESCUE_BLOCKED" }));
    expect(store.latest(USER, "WARN")?.id).toBe("b");
    expect(store.latest(USER, "RESCUE_DONE")).toBeNull();
  });
});

describe("explanations", () => {
  it("show up on every read of a record", () => {
    store.append(record({ id: "a", kind: "RESCUE_DONE" }));
    store.setExplanation("a", "Plain words.");
    expect(store.audit(USER, 1)[0]?.explanation).toBe("Plain words.");
    expect(store.ledger(1)[0]?.explanation).toBe("Plain words.");
    expect(store.latest(USER, "RESCUE_DONE")?.explanation).toBe("Plain words.");
  });

  it("leave the record itself alone, because the log is append-only", () => {
    store.append(record({ id: "a", kind: "RESCUE_FAILED", explanation: "The keeper's own note." }));
    store.setExplanation("a", "Plain words.");
    expect(store.latestRaw(USER, "RESCUE_FAILED")?.explanation).toBe("The keeper's own note.");
    expect(store.audit(USER, 1)[0]?.explanation).toBe("Plain words.");
  });

  it("can be replaced", () => {
    store.append(record({ id: "a", kind: "RESCUE_DONE" }));
    store.setExplanation("a", "First.");
    store.setExplanation("a", "Second.");
    expect(store.audit(USER, 1)[0]?.explanation).toBe("Second.");
  });

  it("leave a record without one exactly as it was", () => {
    const written = record({ id: "a", kind: "WARN" });
    store.append(written);
    expect(store.audit(USER, 1)).toEqual([written]);
  });
});

describe("unfinished rescues", () => {
  const allowed = (id: string, requestId: string) =>
    record({ id, kind: "RESCUE_ALLOWED", request: rescueRequest({ id: requestId }) });

  it("lists an allowed rescue that has no outcome yet", () => {
    store.append(allowed("a", "req-1"));
    expect(store.unfinishedRescues().map((r) => r.id)).toEqual(["a"]);
  });

  it.each(["RESCUE_DONE", "RESCUE_FAILED"] as const)("drops one once %s is written", (kind) => {
    store.append(allowed("a", "req-1"));
    store.append(allowed("b", "req-2"));
    store.append(record({ id: "c", kind, request: rescueRequest({ id: "req-1" }) }));
    expect(store.unfinishedRescues().map((r) => r.id)).toEqual(["b"]);
  });
});

describe("stats", () => {
  it("is empty and null-latency before any rescue", () => {
    expect(store.stats()).toEqual({
      totalRescues: 0,
      totalUsdRescued: 0,
      blockedCount: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
    });
  });

  it("counts finished rescues, money delivered, blocks and latency", () => {
    const done = (id: string, usdNeeded: number, latencyMs: number) =>
      record({ id, kind: "RESCUE_DONE", request: rescueRequest({ id, usdNeeded }), latencyMs });
    store.append(done("a", 10, 40000));
    store.append(done("b", 5.5, 30000));
    store.append(record({ id: "c", kind: "RESCUE_BLOCKED" }));
    store.append(record({ id: "d", kind: "RESCUE_FAILED", request: rescueRequest({ id: "d" }) }));
    store.append(record({ id: "e", kind: "WARN" }));
    expect(store.stats()).toEqual({
      totalRescues: 2,
      totalUsdRescued: 15.5,
      blockedCount: 1,
      latencyP50Ms: 30000,
      latencyP95Ms: 40000,
    });
  });
});

describe("stats money", () => {
  it("is rounded to the cent, so float noise never reaches the dashboard", () => {
    store.append(record({ id: "a", kind: "RESCUE_DONE", latencyMs: 1000, request: rescueRequest({ id: "a", usdNeeded: 3.9999999999999996 }) }));
    expect(store.stats().totalUsdRescued).toBe(4);
  });
});

describe("stats and unconfirmed money", () => {
  it("doesn't add a rescue to the money total until the money was seen on Hyperliquid", () => {
    store.append(record({ id: "a", kind: "RESCUE_DONE", request: rescueRequest({ id: "a", usdNeeded: 10 }), latencyMs: 1000 }));
    store.append(record({ id: "b", kind: "RESCUE_DONE", request: rescueRequest({ id: "b", usdNeeded: 99 }) }));
    expect(store.stats()).toMatchObject({ totalRescues: 2, totalUsdRescued: 10 });
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
  });

  it("doesn't care about order, and has no answer for nothing", () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("latest health", () => {
  const response = (health: HealthResponse["status"]): HealthResponse => ({
    status: health,
    snapshot: health === "ok" ? snapshot(50, 34) : null,
    policy: policy(),
  });

  it("has nothing for a user it hasn't read", () => {
    expect(store.health(USER)).toBeNull();
  });

  it("keeps only the newest read", () => {
    store.saveHealth(USER, response("ok"));
    store.saveHealth(USER, response("unknown"));
    expect(store.health(USER)?.status).toBe("unknown");
    expect(store.health(USER)?.snapshot).toBeNull();
  });

  it("writes an account with no positions as null health, as the API promises", () => {
    store.saveHealth(USER, { ...response("ok"), snapshot: { ...snapshot(50, 0), health: null } });
    expect(store.health(USER)?.snapshot?.health).toBeNull();
  });
});

describe("telegram link codes", () => {
  const now = new Date(AT);

  it("issues a code that expires in 10 minutes", () => {
    const issued = store.createTelegramCode(USER, now);
    expect(issued?.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(issued?.expiresAt).toBe("2026-11-08T15:10:00.000Z");
  });

  it("links a chat with a good code, once only", () => {
    const issued = store.createTelegramCode(USER, now);
    if (issued === null) throw new Error("expected a code");
    expect(store.consumeTelegramCode(issued.code, 42, now)).toBe(USER);
    expect(store.chatsFor(USER)).toEqual([42]);
    expect(store.consumeTelegramCode(issued.code, 99, now)).toBeNull();
    expect(store.chatsFor(USER)).toEqual([42]);
  });

  it("refuses an expired or unknown code", () => {
    const issued = store.createTelegramCode(USER, now);
    if (issued === null) throw new Error("expected a code");
    expect(store.consumeTelegramCode(issued.code, 42, new Date(now.getTime() + 10 * 60_000))).toBeNull();
    expect(store.consumeTelegramCode("NOSUCHCD", 42, now)).toBeNull();
    expect(store.chatsFor(USER)).toEqual([]);
  });

  it("lets one account have several chats, so a stranger's link can't replace the owner's", () => {
    for (const chat of [1, 2]) {
      const issued = store.createTelegramCode(USER, now);
      if (issued === null) throw new Error("expected a code");
      store.consumeTelegramCode(issued.code, chat, now);
    }
    expect(store.chatsFor(USER).sort()).toEqual([1, 2]);
  });

  it("lets one chat follow several accounts, and linking twice changes nothing", () => {
    for (const user of [USER, "bob.near", USER]) {
      const issued = store.createTelegramCode(user, now);
      if (issued === null) throw new Error("expected a code");
      store.consumeTelegramCode(issued.code, 42, now);
    }
    expect(store.usersForChat(42).sort()).toEqual([USER, "bob.near"].sort());
  });

  it("unlinks a chat from everything, and says how many", () => {
    for (const user of [USER, "bob.near"]) {
      const issued = store.createTelegramCode(user, now);
      if (issued === null) throw new Error("expected a code");
      store.consumeTelegramCode(issued.code, 42, now);
    }
    expect(store.unlinkChat(42)).toBe(2);
    expect(store.chatsFor(USER)).toEqual([]);
    expect(store.unlinkChat(42)).toBe(0);
  });

  it("keeps links across a restart", () => {
    const issued = store.createTelegramCode(USER, now);
    if (issued === null) throw new Error("expected a code");
    store.consumeTelegramCode(issued.code, 42, now);
    expect(store.db.prepare("SELECT chat_id AS chat FROM telegram_chats").all()).toEqual([{ chat: 42 }]);
  });

  it("issues a different code each time", () => {
    expect(store.createTelegramCode(USER, now)?.code).not.toBe(store.createTelegramCode(USER, now)?.code);
  });

  it("purges expired codes, so the table can't grow forever", () => {
    store.createTelegramCode(USER, now);
    store.createTelegramCode(USER, new Date(now.getTime() + 11 * 60_000));
    const { n } = store.db.prepare("SELECT COUNT(*) AS n FROM telegram_codes").get() as { n: number };
    expect(n).toBe(1);
  });

  it("stops issuing at the cap, so nobody can fill the disk through the API", () => {
    for (let i = 0; i < 1000; i += 1) expect(store.createTelegramCode(`user-${i}.near`, now)).not.toBeNull();
    expect(store.createTelegramCode(USER, now)).toBeNull();
    expect(store.createTelegramCode(USER, new Date(now.getTime() + 11 * 60_000))).not.toBeNull();
  });
});
