import type { AuditRecord, HealthResponse } from "@lifeline/shared";
import { GrammyError } from "grammy";
import { beforeEach, describe, expect, it } from "vitest";
import { createLifelineBot, type BotStore } from "../src/bot";

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

const CHAT = 42;
const AT = new Date("2026-11-08T15:00:00.000Z");
const record = (o: Partial<AuditRecord> = {}): AuditRecord => ({ id: "r", user: "alice.near", kind: "WARN", healthBefore: 1.7, at: AT.toISOString(), ...o });

function fakeStore() {
  const links = new Map<number, Set<string>>();
  const codes = new Map<string, string>([["GOODCODE", "alice.near"]]);
  const health = new Map<string, HealthResponse>();
  const store: BotStore = {
    consumeTelegramCode(code, chatId) {
      const user = codes.get(code);
      if (user === undefined) return null;
      codes.delete(code);
      links.set(chatId, (links.get(chatId) ?? new Set()).add(user));
      return user;
    },
    chatsFor: (user) => [...links].filter(([, users]) => users.has(user)).map(([chat]) => chat),
    usersForChat: (chatId) => [...(links.get(chatId) ?? [])],
    unlinkChat(chatId) {
      const count = links.get(chatId)?.size ?? 0;
      links.delete(chatId);
      return count;
    },
    health: (user) => health.get(user) ?? null,
  };
  return { store, links, health };
}

type Sent = { method: string; payload: { chat_id?: number; text?: string } };

function setup() {
  const fake = fakeStore();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const life = createLifelineBot({
    token: "1:fake",
    botInfo: BOT_INFO,
    store: fake.store,
    dashboardUrl: "https://lifeline.example",
    network: "mainnet",
    now: () => AT,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sendTimeoutMs: 20,
  });
  const sent: Sent[] = [];
  const failures: unknown[] = [];
  let hangNext = false;
  life.bot.api.config.use(async (_previous, method, payload, signal) => {
    if (hangNext) {
      hangNext = false;
      await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const failure = failures.shift();
    if (failure) throw failure;
    sent.push({ method, payload: payload as Sent["payload"] });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: CHAT, type: "private", first_name: "x" } } } as never;
  });

  const say = (text: string) => {
    const isCommand = text.startsWith("/");
    return life.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: CHAT, type: "private", first_name: "x" },
        from: { id: 7, is_bot: false, first_name: "x" },
        text,
        ...(isCommand ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 }] } : {}),
      },
    });
  };
  const reply = () => sent.at(-1)?.payload.text ?? "";
  const hang = () => {
    hangNext = true;
  };
  return { life, fake, sent, say, reply, logs, sleeps, failures, hang };
}

const telegramError = (code: number, retryAfter?: number) =>
  new GrammyError(
    "failed",
    { ok: false, error_code: code, description: "failed", ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }) },
    "sendMessage",
    {},
  );

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("linking a chat", () => {
  it("links by sending the code as a plain message", async () => {
    await t.say("GOODCODE");
    expect(t.fake.store.usersForChat(CHAT)).toEqual(["alice.near"]);
    expect(t.reply()).toContain("alice.near");
  });

  it("links through a deep link: /start CODE", async () => {
    await t.say("/start GOODCODE");
    expect(t.fake.store.usersForChat(CHAT)).toEqual(["alice.near"]);
  });

  it("forgives lower case and stray spaces", async () => {
    await t.say("  goodcode ");
    expect(t.fake.store.usersForChat(CHAT)).toEqual(["alice.near"]);
  });

  it("forgives lower case in a deep link too", async () => {
    await t.say("/start goodcode");
    expect(t.fake.store.usersForChat(CHAT)).toEqual(["alice.near"]);
  });

  it("says so when a code is wrong or used up, and links nothing", async () => {
    await t.say("BADCODE2");
    expect(t.fake.store.usersForChat(CHAT)).toEqual([]);
    expect(t.reply()).toMatch(/expired|isn't valid/i);
  });

  it("explains how to get a code on a bare /start", async () => {
    await t.say("/start");
    expect(t.reply()).toContain("https://lifeline.example");
    expect(t.fake.store.usersForChat(CHAT)).toEqual([]);
  });

  it("ignores ordinary chat that isn't a code", async () => {
    await t.say("hello there, how are you?");
    expect(t.reply()).toMatch(/\/help|code/i);
    expect(t.fake.store.usersForChat(CHAT)).toEqual([]);
  });
});

describe("/status", () => {
  it("asks you to link first when nothing is linked", async () => {
    await t.say("/status");
    expect(t.reply()).toMatch(/no account/i);
  });

  it("shows every linked account", async () => {
    await t.say("GOODCODE");
    t.fake.links.get(CHAT)?.add("bob.near");
    const reading = (user: string, health: number): HealthResponse => ({
      status: "ok",
      snapshot: { hlAddress: "0x1", accountValue: 50, maintenanceMarginUsed: 30, health, positions: [], at: "" },
      policy: { user, hlAddress: "0x1", warn: 1.8, trigger: 1.5, target: 2, maxPerRescue: "1", maxPerDay: "1", cooldownSec: 120, paused: false },
    });
    t.fake.health.set("alice.near", reading("alice.near", 1.67));
    t.fake.health.set("bob.near", reading("bob.near", 2.5));
    await t.say("/status");
    expect(t.reply()).toContain("1.67");
    expect(t.reply()).toContain("2.50");
  });
});

describe("/pause", () => {
  it("sends you to the dashboard, because only the user can sign a pause", async () => {
    await t.say("/pause");
    expect(t.reply()).toContain("https://lifeline.example");
    expect(t.reply()).toMatch(/sign/i);
  });
});

describe("/unlink", () => {
  it("stops the alerts", async () => {
    await t.say("GOODCODE");
    await t.say("/unlink");
    expect(t.fake.store.usersForChat(CHAT)).toEqual([]);
    const before = t.sent.length;
    await t.life.notify(record());
    expect(t.sent).toHaveLength(before);
  });
});

describe("/help", () => {
  it("lists the commands", async () => {
    await t.say("/help");
    for (const command of ["/status", "/pause", "/unlink"]) expect(t.reply()).toContain(command);
  });
});

describe("notify", () => {
  beforeEach(async () => {
    await t.say("GOODCODE");
  });

  it.each(["WARN", "RESCUE_ALLOWED", "RESCUE_DONE", "RESCUE_BLOCKED", "RESCUE_FAILED"] as const)("sends a message for %s", async (kind) => {
    const before = t.sent.length;
    await t.life.notify(record({ kind }));
    expect(t.sent).toHaveLength(before + 1);
    expect(t.sent.at(-1)?.payload.chat_id).toBe(CHAT);
    expect(t.reply()).toContain("alice.near");
  });

  it("does nothing for someone with no linked chat", async () => {
    const before = t.sent.length;
    await t.life.notify(record({ user: "nobody.near" }));
    expect(t.sent).toHaveLength(before);
  });

  it("reaches every linked chat", async () => {
    t.fake.links.set(99, new Set(["alice.near"]));
    await t.life.notify(record());
    expect(t.sent.map((s) => s.payload.chat_id)).toContain(99);
    expect(t.sent.map((s) => s.payload.chat_id)).toContain(CHAT);
  });

  it("keeps a chat's messages in order, even when one is retried", async () => {
    t.failures.push(telegramError(429, 1));
    const first = t.life.notify(record({ kind: "RESCUE_ALLOWED" }));
    const second = t.life.notify(record({ kind: "RESCUE_DONE" }));
    await Promise.all([first, second]);
    const last = t.sent.slice(-2).map((s) => s.payload.text ?? "");
    expect(last[0]).toMatch(/started/i);
    expect(last[1]).toMatch(/done/i);
  });

  it("waits as long as Telegram asks, then retries", async () => {
    const before = t.sent.length;
    t.failures.push(telegramError(429, 3));
    await t.life.notify(record());
    expect(t.sleeps).toContain(3000);
    expect(t.sent).toHaveLength(before + 1);
  });

  it("retries a passing failure", async () => {
    const before = t.sent.length;
    t.failures.push(new Error("network blip"));
    await t.life.notify(record());
    expect(t.sent).toHaveLength(before + 1);
  });

  it("keeps trying through a Telegram outage of a minute or more, because this may be a rescue alert", async () => {
    const before = t.sent.length;
    t.failures.push(...Array.from({ length: 8 }, () => new Error("down")));
    await t.life.notify(record());
    expect(t.sent).toHaveLength(before + 1);
    expect(t.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(60_000);
  });

  it("gives up eventually and logs it, without throwing", async () => {
    t.failures.push(...Array.from({ length: 9 }, () => new Error("down")));
    await expect(t.life.notify(record())).resolves.toBeUndefined();
    expect(t.logs.join("\n")).toMatch(/couldn't send/i);
  });

  it("doesn't retry a message Telegram says is bad", async () => {
    t.failures.push(telegramError(400));
    await t.life.notify(record());
    expect(t.sleeps).toEqual([]);
    expect(t.logs.join("\n")).toMatch(/refused/i);
  });

  it("gives up on a hung send and retries, so one can't hold up the chat's queue", async () => {
    const before = t.sent.length;
    t.hang();
    await t.life.notify(record());
    expect(t.sent).toHaveLength(before + 1);
  });

  it("keeps a chat's queue working if unlinking a blocked chat throws", async () => {
    const before = t.sent.length;
    t.fake.store.unlinkChat = () => {
      throw new Error("store broke");
    };
    t.failures.push(telegramError(403));
    await t.life.notify(record());
    await t.life.notify(record());
    expect(t.sent).toHaveLength(before + 1);
  });

  it("drops a chat that blocked the bot, and doesn't retry", async () => {
    t.failures.push(telegramError(403));
    await t.life.notify(record());
    expect(t.fake.store.usersForChat(CHAT)).toEqual([]);
    expect(t.sleeps).toEqual([]);
  });

  it("never throws, even if the store is broken, because a rescue can't depend on the bot", async () => {
    t.fake.store.chatsFor = () => {
      throw new Error("store broke");
    };
    await expect(t.life.notify(record())).resolves.toBeUndefined();
  });

  it("doesn't leak the token into its logs", async () => {
    const leaky = () => new Error("request to https://api.telegram.org/bot1:fake/sendMessage failed");
    t.failures.push(...Array.from({ length: 9 }, leaky));
    await t.life.notify(record());
    expect(t.logs.join("\n")).toMatch(/couldn't send/i);
    expect(t.logs.join("\n")).not.toContain("1:fake");
  });
});

describe("polling", () => {
  it("starts again after Telegram stops it, like when the same token runs elsewhere", async () => {
    let starts = 0;
    t.life.bot.start = (async () => {
      starts += 1;
      if (starts === 1) throw telegramError(409);
      t.life.stopPolling();
    }) as typeof t.life.bot.start;
    await t.life.poll();
    expect(starts).toBe(2);
    expect(t.logs.join("\n")).toMatch(/polling stopped/i);
    expect(t.sleeps.length).toBe(1);
  });

  it("stays stopped once told to stop", async () => {
    let starts = 0;
    t.life.bot.start = (async () => {
      starts += 1;
    }) as typeof t.life.bot.start;
    t.life.stopPolling();
    await t.life.poll();
    expect(starts).toBe(0);
  });
});

describe("a code that's already been used", () => {
  it("points you at /status, in case your first try worked but the reply was lost", async () => {
    await t.say("GOODCODE");
    await t.say("GOODCODE");
    expect(t.reply()).toContain("/status");
  });
});

describe("handler errors", () => {
  it("are caught, so one bad update can't stop the bot", async () => {
    t.failures.push(telegramError(400));
    await expect(t.say("/help")).resolves.toBeUndefined();
  });
});
