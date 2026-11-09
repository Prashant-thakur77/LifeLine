import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuditResponse, HealthResponse, StatsResponse, TelegramLinkResponse } from "@lifeline/shared";
import { fixtures } from "@lifeline/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLinkLimiter, handleApi, NOT_AVAILABLE_ATTESTATION, type ApiDeps } from "../src/api";
import { createAttackLab, TESTNET_LAB } from "../src/attack-lab";
import { createApi } from "../src/api-node";
import { openStore } from "../src/sql-node";
import type { Store } from "../src/store";
import { AT, policy, record, rescueRequest, snapshot, USER } from "./helpers";

/** The same API, reached the way Node serves it and the way the Cloudflare Worker calls it. */
type Transport = {
  start(deps: ApiDeps): Promise<void>;
  stop(): Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  base(): string;
};

const nodeServer = (): Transport => {
  let server: Server | null = null;
  let base = "";
  return {
    async start(deps) {
      server = createApi(deps);
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
    },
    async stop() {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
      server = null;
    },
    fetch: (path, init) => fetch(base + path, init),
    base: () => base,
  };
};

const fetchHandler = (): Transport => {
  let deps: ApiDeps | null = null;
  return {
    async start(next) {
      deps = next;
    },
    async stop() {
      deps = null;
    },
    fetch: (path, init) => handleApi(new Request(`https://lifeline-keeper.test${path}`, init), deps as ApiDeps),
    base: () => "https://lifeline-keeper.test",
  };
};

const TRANSPORTS: [string, () => Transport][] = [
  ["the Node server", nodeServer],
  ["the fetch handler", fetchHandler],
];

describe.each(TRANSPORTS)("the API through %s", (_transport, makeTransport) => {
  let store: Store;
  let transport: Transport;

  const start = async (overrides: Partial<ApiDeps> = {}) => {
    await transport.stop();
    await transport.start({
      store,
      now: () => new Date(AT),
      botUsername: "lifeline_test_bot",
      attestation: () => NOT_AVAILABLE_ATTESTATION,
      corsOrigin: "https://lifeline.example",
      ...overrides,
    });
  };

  const get = (path: string) => transport.fetch(path);
  const post = (path: string, body: string) =>
    transport.fetch(path, { method: "POST", body, headers: { "content-type": "application/json" } });

  beforeEach(async () => {
    store = openStore(":memory:");
    transport = makeTransport();
    await start();
  });

  afterEach(async () => {
    await transport.stop();
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
    beforeEach(() => {
      store.saveHealth(USER, { status: "ok", snapshot: snapshot(50, 34), policy: policy() });
    });

    it("refuses an account the keeper isn't watching, so codes can't pile up for any name", async () => {
      expect((await post("/api/telegram/link", JSON.stringify({ user: "nobody.near" }))).status).toBe(404);
    });

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

    it("limits codes to 5 per account every 10 minutes, so nobody can burn the storage quota", async () => {
      let nowMs = Date.parse(AT);
      await start({ now: () => new Date(nowMs), allowLink: createLinkLimiter() });
      for (let i = 0; i < 5; i += 1) expect((await post("/api/telegram/link", JSON.stringify({ user: USER }))).status).toBe(200);
      const refused = await post("/api/telegram/link", JSON.stringify({ user: USER }));
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: string }).error).toMatch(/try again/i);
      nowMs += 10 * 60_000;
      expect((await post("/api/telegram/link", JSON.stringify({ user: USER }))).status).toBe(200);
    });

    it("limits codes to 30 a minute across all accounts", async () => {
      const limiter = createLinkLimiter();
      const now = Date.parse(AT);
      for (let i = 0; i < 30; i += 1) expect(limiter(`user${i}.near`, now)).toBe(true);
      expect(limiter("user99.near", now)).toBe(false);
      expect(limiter("user99.near", now + 60_000)).toBe(true);
    });

    it("is a 503 when no bot is set up", async () => {
      await start({ botUsername: null });
      expect((await post("/api/telegram/link", JSON.stringify({ user: USER }))).status).toBe(503);
    });
  });

  describe("GET /api/proof", () => {
    const proof = { model: "m", requestBase64: "cmVx", responseBase64: "cmVz", signedText: "m:a:b", signature: "0x00", signingAddress: "0xabc", verifiedAt: AT };

    beforeEach(() => {
      store.append(record({ id: "r1", kind: "RESCUE_DONE" }));
      store.append(record({ id: "r2", kind: "RESCUE_BLOCKED", user: "bob.near" }));
      store.append(record({ id: "r3", kind: "RESCUE_FAILED" }));
      store.setExplanation("r1", "Facts. Words.", proof);
      store.setExplanation("r2", "Bob's facts. Words.", proof);
      store.setExplanation("r3", "Only facts.");
    });

    it("gives a record with the bytes and signature behind its model's words", async () => {
      const response = await transport.fetch("/api/proof/r1");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ record: expect.objectContaining({ id: "r1", explanation: "Facts. Words." }), proof });
    });

    it("gives the newest proved record, for everyone or for one user", async () => {
      expect(((await (await transport.fetch("/api/proof/latest")).json()) as { record: { id: string } }).record.id).toBe("r2");
      expect(((await (await transport.fetch(`/api/proof/latest?user=${USER}`)).json()) as { record: { id: string } }).record.id).toBe("r1");
    });

    it("is a 404 for a record with only the facts, or none at all", async () => {
      expect((await transport.fetch("/api/proof/r3")).status).toBe(404);
      expect((await transport.fetch("/api/proof/nope")).status).toBe(404);
      expect((await transport.fetch("/api/proof/latest?user=nobody.near")).status).toBe(404);
    });
  });

  describe("the attack lab", () => {
    const refusal = JSON.stringify({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: OVER_PER_RESCUE: over this user's limit per rescue" } } } });
    const makeLab = (call: () => Promise<{ txHash: string; failure: string | null }>) =>
      createAttackLab({
        client: { view: async () => null, call },
        target: TESTNET_LAB,
        // A throwaway stand-in key; the fake chain never checks it.
        signerKey: "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr",
        now: () => new Date(AT),
        log: () => {},
      });

    it("isn't there unless the keeper has one", async () => {
      expect((await get("/api/lab")).status).toBe(404);
      expect((await post("/api/lab/attack", JSON.stringify({ attack: "over-cap" }))).status).toBe(404);
    });

    it("lists the attacks and the target, and sends one, answering with the vault's refusal", async () => {
      await start({ lab: makeLab(async () => ({ txHash: "tx1", failure: refusal })) });
      const info = (await (await get("/api/lab")).json()) as { open: boolean; attacks: { id: string }[]; target: { user: string } };
      expect(info.open).toBe(true);
      expect(info.attacks).toHaveLength(7);
      expect(info.target.user).toBe(TESTNET_LAB.user);
      const response = await post("/api/lab/attack", JSON.stringify({ attack: "over-cap" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "over-cap", txHash: "tx1", refused: true, answer: "OVER_PER_RESCUE: over this user's limit per rescue" });
    });

    it("refuses an unknown attack, a second attack straight after, and a GET", async () => {
      await start({ lab: makeLab(async () => ({ txHash: "tx1", failure: refusal })) });
      expect((await post("/api/lab/attack", JSON.stringify({ attack: "drain-everything" }))).status).toBe(400);
      expect((await post("/api/lab/attack", "not json")).status).toBe(400);
      expect((await post("/api/lab/attack", JSON.stringify({ attack: "over-cap" }))).status).toBe(200);
      const busy = await post("/api/lab/attack", JSON.stringify({ attack: "over-cap" }));
      expect(busy.status).toBe(429);
      expect(((await busy.json()) as { error: string }).error).toMatch(/try again in 8 s/);
      expect((await get("/api/lab/attack")).status).toBe(405);
    });

    it("says the outcome is unknown when testnet doesn't answer, without the error's details", async () => {
      await start({
        lab: makeLab(async () => {
          throw new Error("fetch failed https://rpc.example/?key=secret");
        }),
      });
      const response = await post("/api/lab/attack", JSON.stringify({ attack: "pay-itself" }));
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    });
  });

  describe("GET /api/attestation", () => {
    it("says not available until a check has run", async () => {
      const body = await (await get("/api/attestation")).json();
      expect(body).toEqual({ status: "not available", checkedAt: null, model: null, checks: [] });
      expect(Object.keys(body as object).sort()).toEqual(Object.keys(fixtures.attestation).sort());
    });

    it("serves the latest check", async () => {
      await start({ attestation: () => fixtures.attestation });
      expect(await (await get("/api/attestation")).json()).toEqual(fixtures.attestation);
    });
  });

  describe("the HTTP edges", () => {
    it("lets the dashboard call it from another origin", async () => {
      const response = await get("/api/stats");
      expect(response.headers.get("access-control-allow-origin")).toBe("https://lifeline.example");
      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("answers a browser preflight", async () => {
      const response = await transport.fetch("/api/telegram/link", { method: "OPTIONS" });
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
      store = openStore(":memory:");
    });
  });
});

describe("the Node server's raw paths", () => {
  let store: Store;
  let transport: Transport;

  beforeEach(async () => {
    store = openStore(":memory:");
    transport = nodeServer();
    await transport.start({
      store,
      now: () => new Date(AT),
      botUsername: null,
      attestation: () => NOT_AVAILABLE_ATTESTATION,
      corsOrigin: "*",
    });
  });

  afterEach(async () => {
    await transport.stop();
    store.close();
  });

  const rawGet = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(transport.base());
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
    expect((await transport.fetch("/api/stats")).status).toBe(200);
  });

  it("stops reading a body that runs past the limit, even with no length given", async () => {
    const { hostname, port } = new URL(transport.base());
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname, port, path: "/api/telegram/link", method: "POST", headers: { "transfer-encoding": "chunked" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      for (let i = 0; i < 10; i += 1) request.write("x".repeat(512));
      request.end();
    });
    expect(status).toBe(413);
  });
});
