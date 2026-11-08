import type { LifelineBot } from "@lifeline/bot";
import { ASSETS, type AttestationResponse, type AuditRecord, type StatsResponse } from "@lifeline/shared";
import { fixtures } from "@lifeline/shared/fixtures";
import { describe, expect, it } from "vitest";
import { NOT_AVAILABLE_ATTESTATION } from "../src/api";
import { createKeeperHost, type HostSeams, type HostStorage } from "../src/cloudflare/host";
import { nodeIntel } from "../src/intel-node";
import type { Intents, QuoteParams, Vault } from "../src/ports";
import { PRICE_DROP, SIM_USER } from "../src/sim";
import { durableSql } from "../src/sql-durable";
import { Store } from "../src/store";
import { fakeDurableStorage } from "./fake-durable-storage";
import { HL, policy, rescueRequest, snapshot, USER } from "./helpers";

const T0 = Date.parse("2026-11-08T15:00:00.000Z");
const TICK_MS = 5_000;
const SECRET_KEY = "ed25519:5SECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRET";

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Lifeline",
  username: "lifeline_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

type FakeStorage = HostStorage & { alarmAt(): number | null };

/** A Durable Object's storage: the SQLite stand-in, plus its one alarm. */
function fakeStorage(): FakeStorage {
  let alarm: number | null = null;
  return {
    ...fakeDurableStorage(),
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    alarmAt: () => alarm,
  };
}

function fakeQuotes(now: () => number, seen: QuoteParams[] = []): Pick<Intents, "getQuote"> {
  return {
    async getQuote(params) {
      seen.push(params);
      const inUsd = Number(params.amount) / 1e6;
      return {
        quoteId: `corr-${seen.length}`,
        depositAddress: params.dry ? null : `dep-${seen.length}`,
        amountIn: params.amount,
        minAmountOut: String(Math.floor((inUsd * 0.98989 - 0.3153) * 1e8)),
        withdrawFee: "31530000",
        recipient: params.recipient,
        refundTo: params.refundTo,
        destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
        quotedAt: new Date(now()).toISOString(),
      };
    },
  };
}

function setup(env: Record<string, string>, options: { seams?: (now: () => number) => HostSeams; storage?: FakeStorage } = {}) {
  let nowMs = T0;
  const clock = () => nowMs;
  const storage = options.storage ?? fakeStorage();
  const logs: string[] = [];
  const host = createKeeperHost({
    storage,
    env,
    intel: nodeIntel,
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    log: (line) => logs.push(line),
    seams: {
      quotes: fakeQuotes(clock),
      startPrice: async () => 3000,
      checkAttestation: async () => NOT_AVAILABLE_ATTESTATION,
      ...options.seams?.(clock),
    },
  });
  const alarms = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      await host.alarm();
      nowMs += TICK_MS;
      await host.settled();
    }
  };
  const request = (path: string, init?: RequestInit) => host.fetch(new Request(`https://keeper.test${path}`, init));
  const json = async <T>(path: string) => (await (await request(path)).json()) as T;
  return { host, storage, logs, alarms, request, json, clock };
}

const SIM = { KEEPER_MODE: "sim" };
const LIVE = {
  KEEPER_MODE: "live",
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://rpc.test",
  VAULT_CONTRACT_ID: "vault.lifeline.testnet",
  KEEPER_ACCOUNT_ID: "keeper.lifeline.testnet",
  KEEPER_PRIVATE_KEY: SECRET_KEY,
  KEEPER_USERS: USER.replace(".near", ".testnet"),
};
const LIVE_USER = LIVE.KEEPER_USERS;

/** A vault holding one user's policy and reserve, with no rescues yet. */
const fakeVault = (overrides: Partial<Vault> = {}): Vault => ({
  getPolicy: async (user) => (user === LIVE_USER ? policy({ user: LIVE_USER, hlAddress: HL }) : null),
  getReserve: async () => "100000000",
  getRescues: async () => [],
  rescue: async () => ({ txHash: "tx" }),
  ...overrides,
});

const healthy = async () => ({ status: "ok" as const, isolatedCoins: [], snapshot: snapshot(50, 20) });

describe("starting the hosted keeper", () => {
  it("won't run without KEEPER_MODE, says why on every request, and sets no alarm", async () => {
    const t = setup({});
    await t.host.start();
    const response = await t.request("/api/stats");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/KEEPER_MODE/);
    expect(t.storage.alarmAt()).toBeNull();
  });

  it("won't run live without its settings, naming them but never a value", async () => {
    const t = setup({ KEEPER_MODE: "live", KEEPER_PRIVATE_KEY: SECRET_KEY });
    await t.host.start();
    const body = await (await t.request("/api/ledger")).text();
    expect(body).toMatch(/NEAR_NETWORK/);
    expect(body).not.toContain("SECRET");
    expect(t.logs.join("\n")).not.toContain("SECRET");
  });

  it("won't run on mainnet without the explicit yes", async () => {
    const t = setup({
      ...LIVE,
      NEAR_NETWORK: "mainnet",
      VAULT_CONTRACT_ID: "vault.lifeline.near",
      KEEPER_ACCOUNT_ID: "keeper.lifeline.near",
      KEEPER_USERS: USER,
    });
    await t.host.start();
    expect(((await t.json<{ error: string }>("/api/stats")).error)).toMatch(/KEEPER_ALLOW_MAINNET/);
    expect(t.storage.alarmAt()).toBeNull();
  });

  it("arms its alarm 5 s out, and keeps one already set", async () => {
    const t = setup(SIM);
    await t.host.start();
    expect(t.storage.alarmAt()).toBe(T0 + TICK_MS);

    const storage = fakeStorage();
    await storage.setAlarm(T0 + 999);
    const again = setup(SIM, { storage });
    await again.host.start();
    await again.host.ensureRunning();
    expect(storage.alarmAt()).toBe(T0 + 999);
  });

  it("says what's running at /", async () => {
    const t = setup(SIM);
    await t.host.start();
    expect(await t.json("/")).toMatchObject({ service: "lifeline-keeper", mode: "sim" });
  });
});

describe("each alarm", () => {
  it("arms the next one before doing anything, so a hung tick can't stop the keeper", async () => {
    const t = setup(LIVE, { seams: () => ({ vault: fakeVault({ getPolicy: () => new Promise(() => {}) }), readHealth: healthy }) });
    await t.host.start();
    await t.storage.setAlarm(-1); // the alarm has fired: that's why alarm() is running
    void t.host.alarm();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.storage.alarmAt()).toBe(T0 + TICK_MS);
  });

  it("keeps the keeper going after a tick that fails", async () => {
    const t = setup(LIVE, { seams: () => ({ vault: fakeVault({ getPolicy: async () => Promise.reject(new Error("rpc down")) }), readHealth: healthy }) });
    await t.host.start();
    await t.alarms(2);
    expect(t.storage.alarmAt()).toBe(T0 + 2 * TICK_MS);
  });
});

describe("sim mode", () => {
  it("runs the demo: one rescue per drop, which the API shows", async () => {
    const t = setup(SIM);
    await t.host.start();
    await t.alarms(PRICE_DROP.length + 5);
    expect((await t.json<StatsResponse>("/api/stats")).totalRescues).toBe(1);
    expect((await t.request(`/api/health/${SIM_USER}`)).status).toBe(200);
    const ledger = await t.json<AuditRecord[]>(`/api/audit?user=${SIM_USER}`);
    expect(ledger.find((r) => r.kind === "RESCUE_DONE")?.explanation).toBeTruthy();
  });

  it("keeps the ledger in the object's own storage, so a restart or a deploy loses nothing", async () => {
    const storage = fakeStorage();
    const first = setup(SIM, { storage });
    await first.host.start();
    await first.alarms(PRICE_DROP.length + 5);
    const before = await first.json<AuditRecord[]>("/api/ledger");

    const second = setup(SIM, { storage });
    await second.host.start();
    expect(await second.json<AuditRecord[]>("/api/ledger")).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe("live mode", () => {
  it("watches each configured user through the vault and Hyperliquid reader it's given", async () => {
    const t = setup(LIVE, { seams: () => ({ vault: fakeVault(), readHealth: healthy }) });
    await t.host.start();
    await t.alarms();
    expect(await t.json(`/api/health/${LIVE_USER}`)).toMatchObject({ status: "ok", snapshot: { accountValue: 50 } });
  });

  it("finishes a rescue that a restart left without an outcome", async () => {
    const storage = fakeStorage();
    const request = rescueRequest({ user: LIVE_USER, recipient: HL, depositAddress: "dep-left-behind", quoteId: "corr-left" });
    new Store(durableSql(storage)).append({
      id: "allowed-1",
      user: LIVE_USER,
      at: new Date(T0 - 60_000).toISOString(),
      kind: "RESCUE_ALLOWED",
      request,
      decision: { verdict: "allow", reasons: [] },
      healthBefore: 1.4,
    });
    const intents: Intents = {
      getQuote: async () => Promise.reject(new Error("no quotes needed")),
      getStatus: async () => "SUCCESS",
      submitDeposit: async () => {},
    };
    const t = setup(LIVE, {
      storage,
      seams: () => ({
        vault: fakeVault({ getRescues: async () => [{ amount: request.amount, at: new Date(T0 - 60_000).toISOString(), quoteId: "corr-left" }] }),
        intents,
        readHealth: async () => ({ status: "ok", isolatedCoins: [], snapshot: snapshot(request.snapshot.accountValue + 10, 20) }),
      }),
    });
    await t.host.start();
    await t.host.settled();
    const done = (await t.json<AuditRecord[]>(`/api/audit?user=${LIVE_USER}`)).find((r) => r.kind === "RESCUE_DONE");
    expect(done?.request?.id).toBe(request.id);
  });
});

describe("attestation", () => {
  it("serves the latest check", async () => {
    const result: AttestationResponse = fixtures.attestation;
    const t = setup(SIM, { seams: () => ({ checkAttestation: async () => result }) });
    await t.host.start();
    await t.host.settled();
    expect(await t.json("/api/attestation")).toEqual(result);
  });
});

describe("Telegram", () => {
  const BOT_ENV = {
    ...SIM,
    TELEGRAM_BOT_TOKEN: "1:fake",
    TELEGRAM_BOT_USERNAME: "lifeline_test_bot",
    DASHBOARD_URL: "https://lifeline.example",
    PUBLIC_URL: "https://lifeline-sim.example",
  };

  /** Catches every call the bot makes to Telegram. */
  const capture = () => {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    let bot: LifelineBot | null = null;
    const wrapBot = (created: LifelineBot) => {
      bot = created;
      created.bot.api.config.use(async (_previous, method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        return { ok: true, result: method === "setWebhook" ? true : { message_id: 1, date: 0, chat: { id: 42, type: "private", first_name: "x" } } } as never;
      });
    };
    return { calls, wrapBot, bot: () => bot as unknown as LifelineBot };
  };

  it("registers its webhook at PUBLIC_URL on start", async () => {
    const telegram = capture();
    const t = setup(BOT_ENV, { seams: () => ({ botInfo: BOT_INFO, wrapBot: telegram.wrapBot }) });
    await t.host.start();
    await t.host.settled();
    expect(telegram.calls.find((call) => call.method === "setWebhook")?.payload).toMatchObject({
      url: "https://lifeline-sim.example/telegram/webhook",
    });
  });

  it("answers Telegram's webhook, and refuses one without the secret", async () => {
    const telegram = capture();
    const t = setup(BOT_ENV, { seams: () => ({ botInfo: BOT_INFO, wrapBot: telegram.wrapBot }) });
    await t.host.start();
    const update = (secret: string) =>
      t.request("/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
        body: JSON.stringify({
          update_id: 1,
          message: { message_id: 1, date: 0, chat: { id: 42, type: "private", first_name: "x" }, from: { id: 7, is_bot: false, first_name: "x" }, text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] },
        }),
      });
    expect((await update("wrong")).status).toBe(401);
    expect(telegram.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
    expect((await update(telegram.bot().webhookSecret)).status).toBe(200);
    expect(telegram.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("has no webhook without a bot", async () => {
    const t = setup(SIM);
    await t.host.start();
    expect((await t.request("/telegram/webhook", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
