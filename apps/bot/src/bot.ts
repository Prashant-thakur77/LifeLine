import type { AuditRecord, HealthResponse } from "@lifeline/shared";
import { Bot, GrammyError, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { formatRecord, formatStatus, type Network } from "./messages";

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 500; // 0.5, 1 and 2 s: all inside the plan's 10 s limit
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
  const { token, store, dashboardUrl, network, now, log, botInfo } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  const queues = new Map<number, Promise<void>>();

  /** A token is in every Bot API URL, so nothing that might quote one reaches the logs. */
  const safeMessage = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replaceAll(token, "<token>").replace(/\bbot[^\s/]+/g, "bot<token>");

  const link = async (ctx: Context, raw: string) => {
    const user = store.consumeTelegramCode(raw.trim().toUpperCase(), ctx.chat?.id ?? 0, now());
    await ctx.reply(
      user === null
        ? `That code has expired or isn't valid. Get a new one from ${dashboardUrl}`
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
        await bot.api.sendMessage(chatId, text.slice(0, MAX_MESSAGE_LENGTH));
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 403) {
          log(`telegram chat ${chatId} blocked the bot, so it's been unlinked`);
          store.unlinkChat(chatId);
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
        await sleep(retryAfter === undefined ? BACKOFF_MS * 2 ** (attempt - 1) : retryAfter * 1000);
      }
    }
  };

  return {
    bot,

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

    start(): void {
      bot.start({ drop_pending_updates: true }).catch((error: unknown) => log(`telegram bot stopped: ${safeMessage(error)}`));
    },

    stop: () => bot.stop(),
  };
}
