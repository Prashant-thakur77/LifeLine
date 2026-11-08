import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Intents, QuoteParams } from "../src/ports";
import { createSimLoop, createSimWorld, PRICE_DROP, runSim, SIM_USER } from "../src/sim";
import { openStore } from "../src/sql-node";

const AT_MS = Date.parse("2026-11-08T15:00:00.000Z");

/** Stands in for 1Click's dry quotes, with the fee and spread seen live. */
function fakeQuotes(seen: QuoteParams[] = [], now: () => Date = () => new Date(AT_MS)): Pick<Intents, "getQuote"> {
  return {
    async getQuote(params) {
      seen.push(params);
      const inUsd = Number(params.amount) / 1e6;
      return {
        quoteId: `corr-${seen.length}`,
        depositAddress: null,
        amountIn: params.amount,
        minAmountOut: String(Math.floor((inUsd * 0.98989 - 0.3153) * 1e8)),
        withdrawFee: "31530000",
        recipient: params.recipient,
        refundTo: params.refundTo,
        destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
        quotedAt: now().toISOString(),
      };
    },
  };
}

const run = async (seen: QuoteParams[] = []) => {
  let nowMs = AT_MS;
  const store = openStore(":memory:");
  const result = await runSim({
    store,
    quotes: fakeQuotes(seen),
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    log: () => {},
  });
  return { result, store };
};

describe("the scripted price drop", () => {
  it("produces exactly one rescue and its audit record", async () => {
    const { store, result } = await run();
    const kinds = store.ledger(100).map((r) => r.kind).reverse();
    expect(kinds.filter((k) => k === "RESCUE_ALLOWED")).toHaveLength(1);
    expect(kinds.filter((k) => k === "RESCUE_DONE")).toHaveLength(1);
    expect(kinds.filter((k) => k === "RESCUE_FAILED")).toHaveLength(0);
    expect(kinds.filter((k) => k === "RESCUE_BLOCKED")).toHaveLength(0);
    expect(result.sent).toHaveLength(1);
  });

  it("warns on the way down, before it rescues", async () => {
    const { store } = await run();
    const kinds = store.ledger(100).map((r) => r.kind).reverse();
    expect(kinds[0]).toBe("WARN");
    expect(kinds.indexOf("WARN")).toBeLessThan(kinds.indexOf("RESCUE_ALLOWED"));
  });

  it("lifts health from below the trigger to the target", async () => {
    const { store } = await run();
    const done = store.latest(SIM_USER, "RESCUE_DONE");
    expect(done?.healthBefore).toBeLessThan(1.5);
    expect(done?.healthAfter).toBeGreaterThanOrEqual(1.99);
    expect(done?.healthAfter).toBeLessThan(2.1);
    expect(done?.oneClickStatus).toBe("SUCCESS");
  });

  it("only ever asks for dry quotes, so nothing could be deposited", async () => {
    const seen: QuoteParams[] = [];
    await run(seen);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((q) => q.dry)).toBe(true);
  });

  it("moves the sim's reserve, and fills in the stats", async () => {
    const { result, store } = await run();
    expect(BigInt(result.reserveAfter)).toBeLessThan(BigInt(result.reserveBefore));
    expect(store.stats().totalRescues).toBe(1);
  });

  it("holds the price after a failed quote until the keeper's retry rescues, so one 1Click error can't end the demo empty", async () => {
    let nowMs = AT_MS;
    const now = () => new Date(nowMs);
    const working = fakeQuotes([], now);
    let calls = 0;
    const store = openStore(":memory:");
    const result = await runSim({
      store,
      quotes: {
        async getQuote(params) {
          calls += 1;
          if (calls === 1) throw new Error("1Click timed out");
          return working.getQuote(params);
        },
      },
      now,
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
    });
    const kinds = store.ledger(100).map((r) => r.kind).reverse();
    expect(kinds.filter((k) => k === "RESCUE_FAILED")).toHaveLength(1);
    expect(kinds.filter((k) => k === "RESCUE_DONE")).toHaveLength(1);
    expect(result.sent).toHaveLength(1);
    expect(nowMs - AT_MS).toBeLessThan(120_000);
  });

  it("gives up holding after a bounded time when 1Click never answers", async () => {
    let nowMs = AT_MS;
    const store = openStore(":memory:");
    const result = await runSim({
      store,
      quotes: {
        async getQuote() {
          throw new Error("1Click is down");
        },
      },
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
    });
    expect(result.sent).toHaveLength(0);
    expect(nowMs - AT_MS).toBeLessThan(120_000);
  });

  it("drops the price steadily through warn and trigger", () => {
    expect(PRICE_DROP.length).toBeGreaterThan(5);
    expect(PRICE_DROP.every((price, i) => i === 0 || price <= (PRICE_DROP[i - 1] ?? price))).toBe(true);
  });
});

describe("starting from a live price", () => {
  it("gives the same story at any price, because the position scales with it", async () => {
    let nowMs = AT_MS;
    const store = openStore(":memory:");
    const ticks: { price: number; health: number }[] = [];
    await runSim({
      store,
      quotes: fakeQuotes(),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
      startPrice: 2238.05,
      onTick: (price, health) => ticks.push({ price, health }),
    });
    expect(ticks[0]?.price).toBeCloseTo(2238.05);
    expect(ticks[0]?.health).toBeCloseTo(5);
    expect(ticks.at(-1)?.price).toBeLessThan(2238.05);
    expect(store.latest(SIM_USER, "RESCUE_DONE")?.healthBefore).toBeLessThan(1.5);
    expect(store.latest(SIM_USER, "RESCUE_DONE")?.healthAfter).toBeGreaterThanOrEqual(1.99);
    expect(store.ledger(100).filter((r) => r.kind === "RESCUE_DONE")).toHaveLength(1);
  });
});

describe("the sim's account", () => {
  it("starts healthy, and health falls as the price falls", async () => {
    const world = createSimWorld({ quotes: fakeQuotes(), now: () => new Date(AT_MS) });
    world.setPrice(PRICE_DROP[0] ?? 0);
    expect((await world.readHealth(world.hlAddress)).status).toBe("ok");
    const first = await world.readHealth(world.hlAddress);
    world.setPrice(PRICE_DROP.at(-1) ?? 0);
    const last = await world.readHealth(world.hlAddress);
    if (first.status !== "ok" || last.status !== "ok") throw new Error("expected ok");
    expect(first.snapshot.health).toBeGreaterThan(1.8);
    expect(last.snapshot.health).toBeLessThan(1.5);
    expect(last.snapshot.positions[0]?.liquidationPx).toBeGreaterThan(0);
  });

  it("settles through 1Click's real statuses, then credits what would really arrive", async () => {
    const world = createSimWorld({ quotes: fakeQuotes(), now: () => new Date(AT_MS) });
    world.setPrice(PRICE_DROP.at(-1) ?? 0);
    const before = await world.readHealth(world.hlAddress);
    const { txHash } = await world.vault.rescue({
      user: SIM_USER,
      token: ASSETS.NEAR_USDC.contractId,
      amount: "5000000",
      depositAddress: "sim-1",
      recipient: world.hlAddress,
      quoteId: "corr-1",
    });
    expect(txHash).toMatch(/^sim-tx-/);
    expect(await world.intents.getStatus("sim-1")).toBe("KNOWN_DEPOSIT_TX");
    expect(await world.intents.getStatus("sim-1")).toBe("PROCESSING");
    expect(await world.intents.getStatus("sim-1")).toBe("SUCCESS");
    const after = await world.readHealth(world.hlAddress);
    if (before.status !== "ok" || after.status !== "ok") throw new Error("expected ok");
    expect(after.snapshot.accountValue - before.snapshot.accountValue).toBeCloseTo(5 - 0.3153, 3);
  });

  it("uses Hyperliquid's real maintenance rate for ETH, 2%", async () => {
    const world = createSimWorld({ quotes: fakeQuotes(), now: () => new Date(AT_MS) });
    world.setPrice(3000);
    const read = await world.readHealth(world.hlAddress);
    if (read.status !== "ok") throw new Error("expected ok");
    expect(read.snapshot.maintenanceMarginUsed).toBeCloseTo(300 * 0.02);
  });

  it("reports PENDING_DEPOSIT for a deposit it never received", async () => {
    const world = createSimWorld({ quotes: fakeQuotes(), now: () => new Date(AT_MS) });
    expect(await world.intents.getStatus("sim-unknown")).toBe("PENDING_DEPOSIT");
  });

  it("forces any quote it's asked for to be dry", async () => {
    const seen: QuoteParams[] = [];
    const world = createSimWorld({ quotes: fakeQuotes(seen), now: () => new Date(AT_MS) });
    await world.intents.getQuote({ amount: "5000000", recipient: world.hlAddress, refundTo: SIM_USER, dry: false });
    expect(seen[0]?.dry).toBe(true);
  });
});

describe("the hosted sim loop", () => {
  const TICK_MS = 5_000;
  const REST_MS = 10 * 60_000;

  const setup = (startPrice?: () => Promise<number>) => {
    let nowMs = AT_MS;
    const seen: QuoteParams[] = [];
    const store = openStore(":memory:");
    const loop = createSimLoop({
      store,
      quotes: fakeQuotes(seen, () => new Date(nowMs)),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
      restMs: REST_MS,
      ...(startPrice ? { startPrice } : {}),
    });
    /** One alarm: a tick, then 5 s pass while any rescue carries on. */
    const tick = async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        await loop.tick();
        nowMs += TICK_MS;
        await loop.settled();
      }
    };
    const count = (kind: string) => store.ledger(200).filter((r) => r.kind === kind).length;
    return { tick, count, store, seen, elapse: (ms: number) => (nowMs += ms) };
  };

  it("rescues exactly once per drop, then holds at the rescued health", async () => {
    const t = setup();
    await t.tick(PRICE_DROP.length + 10);
    expect(t.count("RESCUE_DONE")).toBe(1);
    expect(t.count("RESCUE_FAILED") + t.count("RESCUE_BLOCKED")).toBe(0);
    const health = t.store.health(SIM_USER);
    expect(health?.status).toBe("ok");
    expect(health?.snapshot?.health).toBeGreaterThanOrEqual(health?.policy.trigger ?? Infinity);
  });

  it("starts the next drop only after resting, and rescues again", async () => {
    const t = setup();
    await t.tick(PRICE_DROP.length + 3);
    t.elapse(REST_MS - 60_000);
    await t.tick(3);
    expect(t.count("WARN")).toBe(1);
    t.elapse(60_000);
    await t.tick(PRICE_DROP.length + 3);
    expect(t.count("WARN")).toBe(2);
    expect(t.count("RESCUE_DONE")).toBe(2);
  });

  it("opens each drop at the live price", async () => {
    const t = setup(async () => 2000);
    await t.tick(2);
    expect(t.store.health(SIM_USER)?.snapshot?.positions[0]?.entryPx).toBe(2000);
  });

  it.each([["fails", async () => Promise.reject(new Error("down"))], ["is nonsense", async () => Number.NaN]])(
    "opens at 3,000 when the live price %s",
    async (_case, startPrice) => {
      const t = setup(startPrice as () => Promise<number>);
      await t.tick(2);
      expect(t.store.health(SIM_USER)?.snapshot?.positions[0]?.entryPx).toBe(3000);
    },
  );

  it("only ever asks 1Click for dry quotes, so nothing can be deposited", async () => {
    const t = setup();
    await t.tick(PRICE_DROP.length + 3);
    expect(t.seen.length).toBeGreaterThan(0);
    expect(t.seen.every((params) => params.dry === true)).toBe(true);
  });

  it("asks to sleep between drops: ticks until the rescue is done and shown for a minute, then not until the rest is over", async () => {
    let nowMs = AT_MS;
    const store = openStore(":memory:");
    const loop = createSimLoop({
      store,
      quotes: fakeQuotes([], () => new Date(nowMs)),
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      log: () => {},
      restMs: REST_MS,
    });
    expect(loop.nextTickInMs(TICK_MS)).toBe(TICK_MS);
    let lastStepAt = 0;
    for (let i = 0; i < PRICE_DROP.length; i += 1) {
      await loop.tick();
      await loop.settled();
      expect(loop.nextTickInMs(TICK_MS)).toBe(TICK_MS);
      lastStepAt = nowMs;
      nowMs += TICK_MS;
    }
    // The rescue was done by the drop's last step, so the minute and the rest run from there.
    nowMs = lastStepAt + 59_000;
    await loop.tick();
    expect(loop.nextTickInMs(TICK_MS)).toBe(TICK_MS); // still showing the rescued health
    nowMs = lastStepAt + 60_000;
    await loop.tick();
    expect(loop.nextTickInMs(TICK_MS)).toBe(REST_MS - 60_000); // asleep until the rest is over
  });

  it("ignores a tick that arrives while the last one is still running, so the script can't skip ahead", async () => {
    let release: (price: number) => void = () => {};
    let priceCalls = 0;
    const store = openStore(":memory:");
    const loop = createSimLoop({
      store,
      quotes: fakeQuotes(),
      now: () => new Date(AT_MS),
      sleep: async () => {},
      log: () => {},
      restMs: REST_MS,
      startPrice: () => {
        priceCalls += 1;
        return new Promise((resolve) => (release = resolve));
      },
    });
    const first = loop.tick();
    await loop.tick(); // arrives while the first is still waiting for the price
    release(3000);
    await first;
    expect(priceCalls).toBe(1);
    expect(store.health(SIM_USER)?.snapshot?.health).toBeCloseTo(5, 1); // the script's first step, not its second
  });
});

