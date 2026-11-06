import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuditResponse, HealthResponse, StatsResponse, TelegramLinkResponse } from "@lifeline/shared";
import { fixtures } from "@lifeline/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, NOT_AVAILABLE_ATTESTATION, type ApiDeps } from "../src/api";
import { Store } from "../src/store";
import { AT, policy, record, rescueRequest, snapshot, USER } from "./helpers";

let store: Store;
let server: Server | null;
let base: string;

const start = async (overrides: Partial<ApiDeps> = {}) => {
  server = createApi({
    store,
    now: () => new Date(AT),
    botUsername: "lifeline_test_bot",
    attestation: () => NOT_AVAILABLE_ATTESTATION,
    corsOrigin: "https://lifeline.example",
    ...overrides,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
};

const get = (path: string) => fetch(base + path);
const post = (path: string, body: string) =>
  fetch(base + path, { method: "POST", body, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  store = new Store(":memory:");
  await start();
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = null;
  store.close();
});

describe("GET /api/health/:user", () => {
  it("returns the latest snapshot and the policy", async () => {
    store.saveHealth(USER, { status: "ok", snapshot: snapshot(50, 34), policy: policy() });
    const response = await get(`/api/health/${USER}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.snapshot?.accountValue).toBe(50);
    expect(body.policy.user).toBe(USER);
  });

  it("matches the shape of the fixture the dashboard builds on", async () => {
    store.saveHealth(USER, { status: "ok", snapshot: snapshot(50, 34), policy: policy() });
    const body = (await (await get(`/api/health/${USER}`)).json()) as HealthResponse;
    const fixture = fixtures.healthBelowTrigger;
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixture).sort());
    expect(Object.keys(body.snapshot ?? {}).sort()).toEqual(Object.keys(fixture.snapshot ?? {}).sort());
    expect(Object.keys(body.policy).sort()).toEqual(Object.keys(fixture.policy).sort());
  });

  it("reports unknown with no snapshot, never as safe", async () => {
    store.saveHealth(USER, { status: "unknown", snapshot: null, policy: policy() });
    const body = (await (await get(`/api/health/${USER}`)).json()) as HealthResponse;
    expect(body).toMatchObject({ status: "unknown", snapshot: null });
  });

  it("is a 404 for someone the keeper isn't watching", async () => {
    expect((await get("/api/health/nobody.near")).status).toBe(404);
  });

  it("is a 400, not a crash, for a badly encoded user", async () => {
    expect((await get("/api/health/%E0%A4%A")).status).toBe(400);
  });
});

describe("GET /api/audit", () => {
  beforeEach(() => {
    store.append(record({ id: "a", kind: "WARN" }));
    store.append(record({ id: "b", kind: "RESCUE_DONE", request: rescueRequest() }));
    store.append(record({ id: "c", kind: "WARN", user: "bob.near" }));
  });

  it("returns that user's records, newest first", async () => {
    const body = (await (await get(`/api/audit?user=${USER}`)).json()) as AuditResponse;
    expect(body.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("applies limit", async () => {
    const body = (await (await get(`/api/audit?user=${USER}&limit=1`)).json()) as AuditResponse;
    expect(body.map((r) => r.id)).toEqual(["b"]);
  });

  it("needs a user", async () => {
    expect((await get("/api/audit")).status).toBe(400);
  });

  it.each(["0", "-1", "x", "1.5", ""])("refuses limit=%s", async (limit) => {
    expect((await get(`/api/audit?user=${USER}&limit=${limit}`)).status).toBe(400);
  });

  it("caps a huge limit instead of dumping the table", async () => {
    for (let i = 0; i < 205; i += 1) store.append(record({ id: `x${i}`, kind: "WARN" }));
    const body = (await (await get(`/api/audit?user=${USER}&limit=100000`)).json()) as AuditResponse;
    expect(body).toHaveLength(200);
  });
});

describe("GET /api/ledger", () => {
  it("returns every user's records, newest first", async () => {
    store.append(record({ id: "a", kind: "WARN" }));
    store.append(record({ id: "b", kind: "WARN", user: "bob.near" }));
    const body = (await (await get("/api/ledger?limit=10")).json()) as AuditResponse;
    expect(body.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("works with no limit", async () => {
    expect((await get("/api/ledger")).status).toBe(200);
  });
});

describe("GET /api/stats", () => {
  it("has the fixture's shape", async () => {
    const body = (await (await get("/api/stats")).json()) as StatsResponse;
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixtures.stats).sort());
    expect(body.totalRescues).toBe(0);
    expect(body.latencyP50Ms).toBeNull();
  });
});

describe("POST /api/telegram/link", () => {
  it("issues a code with the fixture's shape", async () => {
    const response = await post("/api/telegram/link", JSON.stringify({ user: USER }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as TelegramLinkResponse;
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixtures.telegramLink).sort());
    expect(body.botUsername).toBe("lifeline_test_bot");
    expect(body.expiresAt).toBe("2026-11-08T15:10:00.000Z");
  });

  it.each(["not json", "{}", '{"user":""}', '{"user":"HAS SPACES"}', '{"user":7}'])("refuses body %s", async (body) => {
    expect((await post("/api/telegram/link", body)).status).toBe(400);
  });

  it("refuses an oversized body", async () => {
    expect((await post("/api/telegram/link", `{"user":"${"a".repeat(5000)}"}`)).status).toBe(413);
  });

  it("is a 429 once too many codes are open", async () => {
    for (let i = 0; i < 1000; i += 1) store.createTelegramCode(`user-${i}.near`, new Date(AT));
    expect((await post("/api/telegram/link", JSON.stringify({ user: USER }))).status).toBe(429);
  });

  it("is a 503 when no bot is set up", async () => {
    await new Promise((resolve) => server?.close(resolve));
    await start({ botUsername: null });
    expect((await post("/api/telegram/link", JSON.stringify({ user: USER }))).status).toBe(503);
  });
});

describe("GET /api/attestation", () => {
  it("says not available until a check has run", async () => {
    const body = await (await get("/api/attestation")).json();
    expect(body).toEqual({ status: "not available", checkedAt: null, model: null, checks: [] });
    expect(Object.keys(body as object).sort()).toEqual(Object.keys(fixtures.attestation).sort());
  });

  it("serves the latest check", async () => {
    await new Promise((resolve) => server?.close(resolve));
    await start({ attestation: () => fixtures.attestation });
    expect(await (await get("/api/attestation")).json()).toEqual(fixtures.attestation);
  });
});

describe("the HTTP edges", () => {
  const rawGet = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(base);
      httpRequest({ hostname, port, path, method: "GET" }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });

  it.each(["//", "//\\", "///", "http://", "/%"])("survives the unparsable path %s, because a crash would stop every rescue", async (path) => {
    const status = await rawGet(path);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect((await get("/api/stats")).status).toBe(200);
  });

  it("lets the dashboard call it from another origin", async () => {
    const response = await get("/api/stats");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://lifeline.example");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("answers a browser preflight", async () => {
    const response = await fetch(`${base}/api/telegram/link`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("is a 404 for an unknown path", async () => {
    expect((await get("/api/nope")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
  });

  it("is a 405 for the wrong method", async () => {
    expect((await post("/api/stats", "{}")).status).toBe(405);
    expect((await get("/api/telegram/link")).status).toBe(405);
  });

  it("hides internal errors", async () => {
    store.close();
    const response = await get("/api/stats");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    store = new Store(":memory:");
  });
});
