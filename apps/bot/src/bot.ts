import { createHash } from "node:crypto";
import type { AuditRecord, HealthResponse } from "@lifeline/shared";
import { Bot, GrammyError, webhookCallback, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { formatRecord, formatStatus, type Network } from "./messages";

const MAX_ATTEMPTS = 9;
const BACKOFF_MS = 500; // doubling, so the first tries stay inside the plan's 10 s limit
const MAX_BACKOFF_MS = 30_000; // about a minute and a half in all, because this may be a rescue alert
const SEND_TIMEOUT_MS = 3_000; // grammY's own default is 500 s, which would hold up the whole chat
const POLL_RESTART_MS = 30_000;
const MAX_MESSAGE_LENGTH = 4000; // Telegram's limit is 4,096
const CODE = /^[A-Z2-9]{8}$/;

/** What the bot needs from the keeper's store. Having no dependency on it keeps the rescue path free of the bot. */
export type BotStore = {
  consumeTelegramCode(code: string, chatId: number, now: Date): string | null;
  chatsFor(user: string): number[];
  usersForChat(chatId: number): string[];
  unlinkChat(chatId: number): number;
  health(user: string): HealthResponse | null;
};

export type BotOptions = {
  token: string;
  store: BotStore;
  dashboardUrl: string;
  network: Network;
  now: () => Date;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  sendTimeoutMs?: number;
  /** Set in tests, so the bot doesn't call Telegram to find out who it is. */
  botInfo?: UserFromGetMe;
};

const HELP = [
  "Lifeline tops up your Hyperliquid margin automatically, and tells you here when it does.",
  "",
  "/status shows your health",
  "/pause tells you how to pause rescues",
  "/unlink stops these messages",
].join("\n");

export function createLifelineBot(options: BotOptions) {
  const { token, store, dashboardUrl, network, now, log, botInfo, sendTimeoutMs = SEND_TIMEOUT_MS } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  // Telegram sends this back on every webhook call. Made from the token, so there's no second secret to keep.
  const webhookSecret = createHash("sha256").update(`lifeline telegram webhook:${token}`).digest("hex");
  const queues = new Map<number, Promise<void>>();
  let stopped = false;

  /** A token is in every Bot API URL, so nothing that might quote one reaches the logs. */
  const safeMessage = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replaceAll(token, "<token>").replace(/\bbot[^\s/]+/g, "bot<token>");

  const link = async (ctx: Context, raw: string) => {
    const user = store.consumeTelegramCode(raw.trim().toUpperCase(), ctx.chat?.id ?? 0, now());
    await ctx.reply(
      user === null
        ? `That code has expired or isn't valid. /status shows what this chat is linked to, or get a new code from ${dashboardUrl}`
        : `Linked to ${user}. You'll get a message here for every warning and rescue.\n\n/status shows your health.`,
    );
  };

  // Long polling only catches errors at its top level, and one bad update mustn't stop the bot.
  const guarded = bot.errorBoundary((error) => log(`telegram handler failed: ${safeMessage(error.error)}`));

  guarded.command("start", async (ctx) => {
    if (ctx.match) await link(ctx, ctx.match);
    else await ctx.reply(`${HELP}\n\nTo link your account, get a code from ${dashboardUrl} and send it here.`);
  });
  guarded.command("help", (ctx) => ctx.reply(HELP));
  guarded.command("status", async (ctx) => {
    const users = store.usersForChat(ctx.chat.id);
    await ctx.reply(
      users.length === 0
        ? `No account is linked to this chat. Get a code from ${dashboardUrl} and send it here.`
        : users.map((user) => formatStatus(user, store.health(user))).join("\n\n"),
    );
  });
  guarded.command("pause", (ctx) =>
    ctx.reply(`Pausing needs your own signature, so only you can do it, on the dashboard: ${dashboardUrl}`),
  );
  guarded.command("unlink", async (ctx) => {
    const count = store.unlinkChat(ctx.chat.id);
    await ctx.reply(count === 0 ? "This chat wasn't linked to anything." : "Unlinked. You won't get any more messages here.");
  });
  guarded.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim().toUpperCase();
    if (CODE.test(text)) await link(ctx, text);
    else await ctx.reply("Send me your link code, or /help for what I can do.");
  });

  const deliver = async (chatId: number, text: string): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const signal = AbortSignal.timeout(sendTimeoutMs) as Parameters<typeof bot.api.sendMessage>[3];
        await bot.api.sendMessage(chatId, text.slice(0, MAX_MESSAGE_LENGTH), undefined, signal);
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 403) {
          try {
            store.unlinkChat(chatId);
            log(`telegram chat ${chatId} blocked the bot, so it's been unlinked`);
          } catch {
            log(`telegram chat ${chatId} blocked the bot, and couldn't be unlinked`);
          }
          return;
        }
        if (error instanceof GrammyError && error.error_code === 400) {
          log(`telegram refused a message to chat ${chatId}: ${safeMessage(error)}`);
          return;
        }
        if (attempt === MAX_ATTEMPTS) {
          log(`couldn't send to telegram chat ${chatId}: ${safeMessage(error)}`);
          return;
        }
        const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
        await sleep(retryAfter === undefined ? Math.min(BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) : retryAfter * 1000);
      }
    }
  };

  const onWebhook = webhookCallback(bot, "std/http", { secretToken: webhookSecret });

  return {
    bot,
    webhookSecret,

    /** Webhook mode, for a host that can't long-poll, like a Cloudflare Worker. A wrong or missing secret gets a 401. */
    handleWebhook: (request: Request): Promise<Response> => onWebhook(request),

    /**
     * Points Telegram at the webhook, unless it already points there: a host that restarts
     * often would otherwise drop waiting messages each time. When it does move, old updates
     * are dropped, since a link code in them may have expired. One bot per deployment:
     * Telegram keeps a single webhook per bot.
     */
    async registerWebhook(url: string): Promise<void> {
      const current = await bot.api.getWebhookInfo();
      if (current.url === url) return;
      await bot.api.setWebhook(url, { secret_token: webhookSecret, allowed_updates: ["message"], drop_pending_updates: true });
    },

    /** Never throws: a rescue can't depend on the bot. A chat's messages stay in order. */
    async notify(record: AuditRecord): Promise<void> {
      try {
        const text = formatRecord(record, network);
        await Promise.all(
          store.chatsFor(record.user).map((chatId) => {
            const next = (queues.get(chatId) ?? Promise.resolve()).then(() => deliver(chatId, text));
            queues.set(chatId, next);
            return next;
          }),
        );
      } catch (error) {
        log(`telegram notify failed: ${safeMessage(error)}`);
      }
    },

    /** Runs until stopPolling. Telegram can stop polling, like a 409 when the token runs elsewhere, so this restarts it. */
    async poll(): Promise<void> {
      while (!stopped) {
        try {
          await bot.start({ drop_pending_updates: true });
        } catch (error) {
          log(`telegram polling stopped, restarting soon: ${safeMessage(error)}`);
          if (!stopped) await sleep(POLL_RESTART_MS);
        }
      }
    },

    stopPolling(): void {
      stopped = true;
      void bot.stop();
    },
  };
}

export type LifelineBot = ReturnType<typeof createLifelineBot>;
