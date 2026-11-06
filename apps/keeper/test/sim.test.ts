import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Intents, QuoteParams } from "../src/ports";
import { createSimWorld, PRICE_DROP, runSim, SIM_USER } from "../src/sim";
import { Store } from "../src/store";

const AT_MS = Date.parse("2026-11-08T15:00:00.000Z");

/** Stands in for 1Click's dry quotes, with the fee and spread seen live. */
function fakeQuotes(seen: QuoteParams[] = []): Pick<Intents, "getQuote"> {
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
        quotedAt: new Date(AT_MS).toISOString(),
      };
    },
  };
}

const run = async (seen: QuoteParams[] = []) => {
  let nowMs = AT_MS;
  const store = new Store(":memory:");
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

  it("drops the price steadily through warn and trigger", () => {
    expect(PRICE_DROP.length).toBeGreaterThan(5);
    expect(PRICE_DROP.every((price, i) => i === 0 || price <= (PRICE_DROP[i - 1] ?? price))).toBe(true);
  });
});

describe("starting from a live price", () => {
  it("gives the same story at any price, because the position scales with it", async () => {
    let nowMs = AT_MS;
    const store = new Store(":memory:");
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
