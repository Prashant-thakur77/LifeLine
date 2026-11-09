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
const ALARM_MS = 60_000; // one alarm a minute, with a tick every 5 s inside it
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
  const jumpTo = (ms: number) => {
    nowMs = ms;
  };
  return { host, storage, logs, alarms, request, json, clock, jumpTo };
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

  it("arms its alarm 5 s out, and keeps one that's due", async () => {
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

  it("re-arms an alarm that's long overdue, so a stuck one can't leave the keeper dead", async () => {
    for (const wake of ["start", "ensureRunning"] as const) {
      const storage = fakeStorage();
      const t = setup(SIM, { storage });
      if (wake === "ensureRunning") await t.host.start();
      await storage.setAlarm(T0 - 10 * 60_000);
      await t.host[wake]();
      expect(storage.alarmAt()).toBe(T0 + TICK_MS);
    }
  });

  it("keeps starting when picking up old work fails, and still arms its alarm", async () => {
    const storage = fakeStorage();
    const exec = storage.sql.exec.bind(storage.sql);
    storage.sql.exec = (query, ...bindings) => {
      if (query.includes("'RESCUE_ALLOWED' AND NOT EXISTS")) throw new Error("rows read limit exceeded");
      return exec(query, ...bindings);
    };
    const t = setup(LIVE, { storage, seams: () => ({ vault: fakeVault(), readHealth: healthy }) });
    await t.host.start();
    expect(t.storage.alarmAt()).toBe(T0 + TICK_MS);
    expect((await t.request("/api/stats")).status).toBe(200);
    expect(t.logs.join("\n")).toMatch(/rows read limit exceeded/);
  });

  it("tries starting again on the next cron when it failed for a reason other than its settings", async () => {
    const storage = fakeStorage();
    const exec = storage.sql.exec.bind(storage.sql);
    let failing = true;
    storage.sql.exec = (query, ...bindings) => {
      if (failing && query.includes("CREATE TABLE")) throw new Error("rows written limit exceeded");
      return exec(query, ...bindings);
    };
    const t = setup(SIM, { storage });
    await t.host.start();
    expect((await t.request("/api/stats")).status).toBe(503);
    expect(storage.alarmAt()).toBeNull();
    failing = false; // midnight UTC: the quota is back
    await t.host.ensureRunning();
    expect((await t.request("/api/stats")).status).toBe(200);
    expect(storage.alarmAt()).toBe(T0 + TICK_MS);
  });

  it("answers a library's error with a fixed message, never its text", async () => {
    const t = setup({ ...LIVE, KEEPER_PRIVATE_KEY: "ed25519:0OIl0OIl" });
    await t.host.start();
    const response = await t.request("/api/stats");
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toMatch(/couldn't start/);
    expect(body).not.toMatch(/0OIl|letter/i);
  });

  it("says what's running at /, and when it last ticked", async () => {
    const t = setup({ ...SIM, KEEPER_VERSION: "abc1234" });
    await t.host.start();
    expect(await t.json("/")).toMatchObject({ service: "lifeline-keeper", mode: "sim", version: "abc1234", lastTickAt: null });
    await t.alarms();
    const info = await t.json<{ lastTickAt: string; nextAlarmAt: string }>("/");
    expect(Date.parse(info.lastTickAt)).toBeGreaterThan(T0);
    expect(Date.parse(info.nextAlarmAt)).toBe(t.storage.alarmAt());
  });

  it("says plainly at / what the simulation fakes, so mainnet prices aren't read as a mainnet deployment", async () => {
    const t = setup(SIM);
    await t.host.start();
    const info = await t.json<{ network: string; simulation?: string }>("/");
    expect(info.network).toBe("mainnet");
    expect(info.simulation).toMatch(/pretend/);
    expect(info.simulation).toMatch(/no keys and no funds/);
  });
});

describe("each alarm", () => {
  it("runs a tick every 5 s, twelve to an alarm, and sets the next alarm a minute on", async () => {
    let reads = 0;
    const t = setup(LIVE, {
      seams: () => ({
        vault: fakeVault({
          getPolicy: async (user) => {
            reads += 1;
            return policy({ user, hlAddress: HL });
          },
        }),
        readHealth: healthy,
      }),
    });
    await t.host.start();
    await t.alarms();
    expect(reads).toBe(ALARM_MS / TICK_MS);
    expect(t.storage.alarmAt()).toBe(T0 + ALARM_MS);
  });

  it("doesn't wait for a tick that hangs, so one stuck user can't hold up the others or the next alarm", async () => {
    let bobReads = 0;
    const t = setup(
      { ...LIVE, KEEPER_USERS: `${LIVE_USER},bob.testnet` },
      {
        seams: () => ({
          vault: fakeVault({
            getPolicy: (user) => {
              if (user === LIVE_USER) return new Promise(() => {});
              bobReads += 1;
              return Promise.resolve(policy({ user, hlAddress: HL }));
            },
          }),
          readHealth: healthy,
        }),
      },
    );
    await t.host.start();
    await t.host.alarm(); // resolves although alice's read never does
    expect(bobReads).toBe(ALARM_MS / TICK_MS);
    expect(t.storage.alarmAt()).toBe(T0 + ALARM_MS);
  });

  it("also watches everyone who signed up in the vault, with no redeploy", async () => {
    const seen = new Set<string>();
    const t = setup(LIVE, {
      seams: () => ({
        vault: fakeVault({
          getUsers: async () => ["carol.testnet"],
          getPolicy: async (user) => {
            seen.add(user);
            return policy({ user, hlAddress: HL });
          },
        }),
        readHealth: healthy,
      }),
    });
    await t.host.start();
    await t.alarms();
    expect([...seen].sort()).toEqual(["carol.testnet", LIVE_USER].sort());
    expect((await t.json<{ watching: number }>("/")).watching).toBe(2);
  });

  it("keeps the keeper going after ticks that fail", async () => {
    const t = setup(LIVE, { seams: () => ({ vault: fakeVault({ getPolicy: async () => Promise.reject(new Error("rpc down")) }), readHealth: healthy }) });
    await t.host.start();
    await t.alarms(2);
    expect(t.storage.alarmAt()).toBe(T0 + 2 * ALARM_MS);
  });
});

describe("sim mode", () => {
  it("runs the demo: one rescue per drop, which the API shows", async () => {
    const t = setup(SIM);
    await t.host.start();
    await t.alarms(2);
    expect((await t.json<StatsResponse>("/api/stats")).totalRescues).toBe(1);
    expect((await t.request(`/api/health/${SIM_USER}`)).status).toBe(200);
    const ledger = await t.json<AuditRecord[]>(`/api/audit?user=${SIM_USER}`);
    expect(ledger.find((r) => r.kind === "RESCUE_DONE")?.explanation).toBeTruthy();
  });

  it("lets the object sleep between drops, with its alarm set for the end of the rest", async () => {
    const t = setup(SIM);
    await t.host.start();
    await t.alarms(3); // the drop, then a minute showing the rescued health
    expect((t.storage.alarmAt() ?? 0) - t.clock()).toBeGreaterThan(10 * 60_000);
    const restEndsAt = t.storage.alarmAt() ?? 0;
    t.jumpTo(restEndsAt);
    await t.alarms(); // the alarm at the end of the rest starts the next drop, ticking again
    expect(t.storage.alarmAt()).toBe(restEndsAt + ALARM_MS);
  });

  it("keeps the ledger in the object's own storage, so a restart or a deploy loses nothing", async () => {
    const storage = fakeStorage();
    const first = setup(SIM, { storage });
    await first.host.start();
    await first.alarms(2);
    const before = await first.json<AuditRecord[]>("/api/ledger");

    const second = setup(SIM, { storage });
    await second.host.start();
    expect(await second.json<AuditRecord[]>("/api/ledger")).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe("the attack lab", () => {
  const LAB_KEYS = {
    TESTNET_LAB_KEEPER_KEY: SECRET_KEY,
    TESTNET_QUOTE_SIGNER_KEY: "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr",
  };
  const refusal = JSON.stringify({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: BAD_QUOTE: it's more than 2 minutes old" } } } });
  const chain = (sent: Record<string, unknown>[] = []) => ({
    view: async (method: string) =>
      method === "get_policy"
        ? { keeper: "lab-keeper.lifeline-team.testnet", hl_address: "0x2222222222222222222222222222222222222222", max_per_rescue: "25000000", paused: false }
        : [{ deposit_address: "c79422d7b73e20ba6e30c9c323822a828267e36c4fbcaf82c4a34b7524c600b5", refunded: false }],
    call: async (_method: string, args: Record<string, unknown>) => {
      sent.push(args);
      return { txHash: `tx${sent.length}`, failure: refusal };
    },
  });

  it("runs beside the sim when it has both testnet keys, and keeps its attacks across a restart", async () => {
    const storage = fakeStorage();
    const sent: Record<string, unknown>[] = [];
    const first = setup({ ...SIM, ...LAB_KEYS }, { storage, seams: () => ({ labClient: chain(sent) }) });
    await first.host.start();
    expect(((await first.json<{ api: string[] }>("/")).api)).toContain("POST /api/lab/attack");
    const response = await first.request("/api/lab/attack", { method: "POST", body: JSON.stringify({ attack: "stale-quote" }) });
    expect(await response.json()).toMatchObject({ id: "stale-quote", refused: true, answer: "BAD_QUOTE: it's more than 2 minutes old" });
    expect(sent).toHaveLength(1);

    const second = setup({ ...SIM, ...LAB_KEYS }, { storage, seams: () => ({ labClient: chain() }) });
    await second.host.start();
    const info = await second.json<{ recent: { txHash: string }[] }>("/api/lab");
    expect(info.recent.map((r) => r.txHash)).toEqual(["tx1"]);
  });

  it("leaves the demo running, without a lab, when the lab's key is malformed", async () => {
    const t = setup({ ...SIM, ...LAB_KEYS, TESTNET_LAB_KEEPER_KEY: "ed25519:abc" });
    await t.host.start();
    expect((await t.request("/api/lab")).status).toBe(404);
    await t.alarms(2);
    expect((await t.json<StatsResponse>("/api/stats")).totalRescues).toBe(1);
    expect(t.logs.join("\n")).toMatch(/attack lab couldn't start/);
  });

  it("isn't there without both keys, or on the real keeper even with them", async () => {
    for (const env of [SIM, { ...SIM, TESTNET_LAB_KEEPER_KEY: SECRET_KEY }, { ...LIVE, ...LAB_KEYS }]) {
      const t = setup(env, { seams: () => ({ labClient: chain(), vault: fakeVault(), readHealth: healthy }) });
      await t.host.start();
      expect((await t.request("/api/lab")).status).toBe(404);
    }
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
  it("keeps the latest check across a restart, and doesn't check again early", async () => {
    const storage = fakeStorage();
    const first = setup(SIM, { storage, seams: () => ({ checkAttestation: async () => fixtures.attestation }) });
    await first.host.start();
    await first.host.settled();

    let checks = 0;
    const second = setup(SIM, {
      storage,
      seams: () => ({
        checkAttestation: async () => {
          checks += 1;
          return NOT_AVAILABLE_ATTESTATION;
        },
      }),
    });
    await second.host.start();
    await second.host.settled();
    expect(await second.json("/api/attestation")).toEqual(fixtures.attestation);
    expect(checks).toBe(0);
  });

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
