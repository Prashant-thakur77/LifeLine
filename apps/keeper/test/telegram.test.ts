import { createLifelineBot } from "@lifeline/bot";
import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Intents } from "../src/ports";
import { runSim, SIM_USER } from "../src/sim";
import { Store } from "../src/store";

const AT_MS = Date.parse("2026-11-08T15:00:00.000Z");
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

const quotes: Pick<Intents, "getQuote"> = {
  async getQuote(params) {
    const inUsd = Number(params.amount) / 1e6;
    return {
      quoteId: "corr-1",
      depositAddress: null,
      amountIn: params.amount,
      minAmountOut: String(Math.floor((inUsd * 0.98989 - 0.3153) * 1e8)),
      withdrawFee: "31530000",
      recipient: params.recipient,
      refundTo: params.refundTo,
      destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
      quotedAt: new Date(AT_MS).toISOString(),
    };
  },
};

describe("the keeper and the bot together", () => {
  it("links a chat through the real store, then messages it through a whole rescue", async () => {
    let nowMs = AT_MS;
    const now = () => new Date(nowMs);
    const store = new Store(":memory:");
    const telegram = createLifelineBot({
      token: "1:fake",
      botInfo: BOT_INFO,
      store,
      dashboardUrl: "https://lifeline.example",
      network: "mainnet",
      now,
      log: () => {},
    });
    const texts: string[] = [];
    telegram.bot.api.config.use(async (_previous, _method, payload) => {
      texts.push((payload as { text?: string }).text ?? "");
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: "private", first_name: "x" } } } as never;
    });

    const issued = store.createTelegramCode(SIM_USER, now());
    if (issued === null) throw new Error("expected a code");
    await telegram.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 42, type: "private", first_name: "x" },
        from: { id: 7, is_bot: false, first_name: "x" },
        text: issued.code,
      },
    });
    expect(texts.at(-1)).toContain(SIM_USER);

    const sending: Promise<void>[] = [];
    await runSim({
      store,
      quotes,
      now,
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
      onRecord: (record) => sending.push(telegram.notify(record)),
    });
    await Promise.all(sending);

    const rescue = texts.slice(1);
    expect(rescue).toHaveLength(3);
    expect(rescue[0]).toMatch(/warning/i);
    expect(rescue[1]).toMatch(/rescue started/i);
    expect(rescue[2]).toMatch(/rescue done/i);
    expect(rescue[2]).toContain("https://nearblocks.io/txns/sim-tx-1");
    store.close();
  });
});
