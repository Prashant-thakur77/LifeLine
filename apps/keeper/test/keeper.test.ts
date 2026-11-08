import { ASSETS } from "@lifeline/shared";
import type { AuditRecord, Policy } from "@lifeline/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { Keeper } from "../src/keeper";
import { QuoteRefusedError, VaultRejectedError, type Intents, type Quote, type QuoteParams, type RescueArgs, type SwapStatus, type Vault } from "../src/ports";
import { openStore } from "../src/sql-node";
import { AT, HL, policy as basePolicy, snapshot, USER } from "./helpers";

const SEC = 1000;
const MIN = 60 * SEC;

/** A fake outside world, with a clock that only moves when the keeper sleeps or a test says so. */
function makeWorld(options: { policy?: Partial<Policy>; reserve?: string; dryQuotes?: boolean } = {}) {
  const w = {
    nowMs: Date.parse(AT),
    accountValue: 50,
    margin: 30,
    healthDown: false,
    policy: basePolicy(options.policy),
    reserve: options.reserve ?? "100000000",
    rescues: [] as { amount: string; at: string; quoteId?: string }[],
    quotes: [] as QuoteParams[],
    sent: [] as RescueArgs[],
    submitted: [] as string[],
    statuses: [] as (SwapStatus | Error)[],
    finalStatus: "SUCCESS" as SwapStatus,
    creditDelayPolls: 0,
    withdrawFee: "31530000",
    quoteOverride: {} as Partial<Quote>,
    quoteError: null as Error | null,
    vaultError: null as Error | null,
    records: [] as AuditRecord[],
    reads: 0,
    healthGate: null as Promise<void> | null,
    rescueGate: null as Promise<void> | null,
    onSleep: null as (() => void) | null,
    listenerThrows: false,
    rescueAttempts: 0,
    landsDespiteError: false,
    creditNever: false,
    logs: [] as string[],
  };

  const credit = (args: RescueArgs) => {
    w.accountValue += Number(args.amount) / 1e6 - Number(w.withdrawFee) / 1e8;
  };

  const intents: Intents = {
    async getQuote(params) {
      w.quotes.push(params);
      if (w.quoteError) throw w.quoteError;
      const inUsd = Number(params.amount) / 1e6;
      const min = inUsd * 0.98989 - Number(w.withdrawFee) / 1e8;
      return {
        quoteId: `corr-${w.quotes.length}`,
        depositAddress: params.dry ? null : `deposit-${w.quotes.length}`,
        amountIn: params.amount,
        minAmountOut: String(Math.floor(min * 1e8)),
        withdrawFee: w.withdrawFee,
        recipient: params.recipient,
        refundTo: params.refundTo,
        destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
        quotedAt: new Date(w.nowMs).toISOString(),
        ...(params.dry ? {} : { signed: { payload: `signed-${w.quotes.length}`, signature: `sig-${w.quotes.length}` } }),
        ...w.quoteOverride,
      };
    },
    async getStatus() {
      const next = w.statuses.shift();
      if (next instanceof Error) throw next;
      if (next !== undefined && next !== "SUCCESS") return next;
      const status = next ?? w.finalStatus;
      const args = w.sent.at(-1);
      if (status === "SUCCESS" && args && w.creditDelayPolls === 0 && !w.creditNever) credit(args);
      return status;
    },
    async submitDeposit({ txHash }) {
      w.submitted.push(txHash);
    },
  };

  const vault: Vault = {
    getPolicy: async () => w.policy,
    getReserve: async () => w.reserve,
    getRescues: async () => w.rescues,
    async rescue(args) {
      if (w.rescueGate) await w.rescueGate;
      w.rescueAttempts += 1;
      if (w.vaultError && !w.landsDespiteError) throw w.vaultError;
      w.sent.push(args);
      w.rescues.push({ amount: args.amount, at: new Date(w.nowMs).toISOString(), quoteId: args.quoteId });
      if (w.vaultError) throw w.vaultError;
      return { txHash: `tx-${w.sent.length}` };
    },
  };

  const store = openStore(":memory:");
  const keeper = new Keeper({
    store,
    vault,
    intents,
    users: () => [USER],
    readHealth: async () => {
      w.reads += 1;
      if (w.healthGate) await w.healthGate;
      if (w.healthDown) return { status: "unknown", reason: "API_ERROR" };
      if (w.creditDelayPolls > 0 && w.sent.length > 0 && w.statuses.length === 0) {
        w.creditDelayPolls -= 1;
        const args = w.sent.at(-1);
        if (w.creditDelayPolls === 0 && args) credit(args);
      }
      return {
        status: "ok",
        snapshot: snapshot(w.accountValue, w.margin, new Date(w.nowMs).toISOString()),
        isolatedCoins: [],
      };
    },
    now: () => new Date(w.nowMs),
    sleep: async (ms) => {
      w.onSleep?.();
      w.nowMs += ms;
      await new Promise((resolve) => setImmediate(resolve)); // let other work run, as a real sleep would
    },
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    dryQuotes: options.dryQuotes ?? false,
    log: (line) => w.logs.push(line),
    onRecord: (record) => {
      if (w.listenerThrows) throw new Error("listener broke");
      w.records.push(record);
    },
  });

  const step = async () => {
    await keeper.tick();
    await keeper.settled();
  };
  const kinds = () => store.ledger(100).map((r) => r.kind).reverse();
  const last = (kind: AuditRecord["kind"]) => store.latest(USER, kind);
  return { w, store, keeper, step, kinds, last, vault, intents };
}

// health = accountValue / 30, so 50 is 1.67 (warn), 42 is 1.40 (trigger).
const WARN_VALUE = 50;
const TRIGGER_VALUE = 42;

describe("a safe account", () => {
  it("writes no audit records and starts no rescue", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = 90;
    await step();
    expect(kinds()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.quotes).toEqual([]);
  });

  it("saves the latest health and policy for the API", async () => {
    const { w, step, store } = makeWorld();
    w.accountValue = 90;
    await step();
    expect(store.health(USER)?.status).toBe("ok");
    expect(store.health(USER)?.snapshot?.health).toBe(3);
    expect(store.health(USER)?.policy.user).toBe(USER);
  });

  it("reports unknown, not its last good reading, when the vault can't be read", async () => {
    const { w, step, store, vault } = makeWorld();
    w.accountValue = 90;
    await step();
    expect(store.health(USER)?.status).toBe("ok");
    vault.getPolicy = async () => {
      throw new Error("rpc down");
    };
    await step();
    expect(store.health(USER)).toMatchObject({ status: "unknown", snapshot: null });
    expect(store.health(USER)?.policy.user).toBe(USER);
  });

  it("does nothing for a user with no policy", async () => {
    const { w, step, kinds, vault } = makeWorld();
    vault.getPolicy = async () => null;
    w.accountValue = 1;
    await step();
    expect(kinds()).toEqual([]);
  });

  it("treats an account with no positions as safe", async () => {
    const { w, step, kinds } = makeWorld();
    w.margin = 0;
    await step();
    expect(kinds()).toEqual([]);
  });
});

describe("when health can't be read", () => {
  it("never starts a rescue and reports unknown, never safe", async () => {
    const { w, step, kinds, store } = makeWorld();
    w.healthDown = true;
    w.accountValue = 1;
    await step();
    expect(kinds()).toEqual([]);
    expect(w.quotes).toEqual([]);
    expect(store.health(USER)).toMatchObject({ status: "unknown", snapshot: null });
  });
});

describe("below warn", () => {
  it("writes one WARN and doesn't rescue", async () => {
    const { w, step, kinds, last } = makeWorld();
    w.accountValue = WARN_VALUE;
    await step();
    expect(kinds()).toEqual(["WARN"]);
    expect(last("WARN")?.healthBefore).toBeCloseTo(50 / 30);
    expect(w.sent).toEqual([]);
  });

  it("writes at most one WARN per 10 minutes", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = WARN_VALUE;
    await step();
    w.nowMs += 9 * MIN;
    await step();
    expect(kinds()).toEqual(["WARN"]);
    w.nowMs += MIN;
    await step();
    expect(kinds()).toEqual(["WARN", "WARN"]);
  });
});

describe("a good rescue", () => {
  it("writes WARN, RESCUE_ALLOWED and RESCUE_DONE, in that order", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_DONE"]);
  });

  it("sends the vault exactly what the quote says, to the policy's address", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      user: USER,
      token: ASSETS.NEAR_USDC.contractId,
      depositAddress: "deposit-2",
      recipient: HL,
      quoteId: "corr-2",
    });
    // target 2 × 30 − 42 = 18 needed; (18 + 0.3153) × 1.01 = 18.498453
    expect(w.sent[0]?.amount).toBe("18498453");
  });

  it("reads the fee with a dry quote first, then asks for a real one sized by it", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.withdrawFee = "100000000"; // 1 USDC
    await step();
    expect(w.quotes.map((q) => q.dry)).toEqual([true, false]);
    expect(w.quotes[1]?.amount).toBe("19190000"); // (18 + 1) × 1.01
  });

  it("asks 1Click to refund the user, never the keeper", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    for (const quote of w.quotes) {
      expect(quote.refundTo).toBe(USER);
      expect(quote.recipient).toBe(HL);
    }
  });

  it("records the outcome: tx, status, both healths and latency", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.statuses = ["PROCESSING", "PROCESSING", "SUCCESS"];
    await step();
    const done = last("RESCUE_DONE");
    expect(done?.nearTx).toBe("tx-1");
    expect(done?.oneClickStatus).toBe("SUCCESS");
    expect(done?.healthBefore).toBeCloseTo(1.4);
    expect(done?.healthAfter).toBeGreaterThan(1.9);
    expect(done?.latencyMs).toBeGreaterThan(0);
    expect(done?.decision).toEqual({ verdict: "allow", reasons: [] });
    expect(done?.request?.usdNeeded).toBeCloseTo(18, 3);
  });

  it("tells 1Click about the deposit", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(w.submitted).toEqual(["tx-1"]);
  });

  it("finishes the rescue even if that hint fails", async () => {
    const { w, step, kinds, intents } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    intents.submitDeposit = async () => {
      throw new Error("hint failed");
    };
    await step();
    expect(kinds()).toContain("RESCUE_DONE");
  });

  it("counts latency until the money shows on Hyperliquid, not just until 1Click finishes", async () => {
    const quick = makeWorld();
    quick.w.accountValue = TRIGGER_VALUE;
    await quick.step();

    const slow = makeWorld();
    slow.w.accountValue = TRIGGER_VALUE;
    slow.w.creditDelayPolls = 3;
    await slow.step();

    const quickMs = quick.last("RESCUE_DONE")?.latencyMs ?? 0;
    const slowMs = slow.last("RESCUE_DONE")?.latencyMs ?? 0;
    expect(slowMs).toBeGreaterThan(quickMs);
    expect(slow.last("RESCUE_DONE")?.healthAfter).toBeGreaterThan(1.9);
  });

  it("uses dry quotes and no real deposit address in sim mode", async () => {
    const { w, step, kinds } = makeWorld({ dryQuotes: true });
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(w.quotes.map((q) => q.dry)).toEqual([true, true]);
    expect(kinds()).toContain("RESCUE_DONE");
    expect(w.sent[0]?.depositAddress).toMatch(/^sim-/);
  });

  it("tells whoever is listening about each record as it is written", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(w.records.map((r) => r.kind)).toEqual(kinds());
  });

  it("doesn't let a broken listener stop the rescue", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.listenerThrows = true;
    await step();
    expect(kinds()).toContain("RESCUE_DONE");
  });
});

describe("exactly one rescue", () => {
  it("doesn't start a second while the first is still running", async () => {
    const { w, keeper } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    let release = () => {};
    w.rescueGate = new Promise((resolve) => {
      release = resolve;
    });
    await keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const quotesAfterFirstTick = w.quotes.length;
    expect(quotesAfterFirstTick).toBeGreaterThan(0);
    await keeper.tick();
    await keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.quotes).toHaveLength(quotesAfterFirstTick);
    release();
    await keeper.settled();
    expect(w.sent).toHaveLength(1);
  });

  it("skips a user whose last read hasn't come back, so slow reads don't pile up", async () => {
    const { w, keeper } = makeWorld();
    w.accountValue = 90;
    let release = () => {};
    w.healthGate = new Promise((resolve) => {
      release = resolve;
    });
    const first = keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const second = keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.reads).toBe(1);
    release();
    await Promise.all([first, second]);
  });

  it("doesn't start a second once health has recovered", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    await step();
    await step();
    expect(w.sent).toHaveLength(1);
  });

  it("does start another once the cooldown has passed, if health is still low", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    w.accountValue = TRIGGER_VALUE;
    w.nowMs += 2 * MIN + 1000;
    await step();
    expect(w.sent).toHaveLength(2);
  });
});

describe("blocked before spending anything on a quote", () => {
  it("a paused user gets RESCUE_BLOCKED with PAUSED and no quote", async () => {
    const { w, step, last, kinds } = makeWorld({ policy: { paused: true } });
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_BLOCKED"]);
    expect(last("RESCUE_BLOCKED")?.decision).toEqual({ verdict: "block", reasons: ["PAUSED"] });
    expect(w.quotes).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("a user in cooldown is blocked with COOLDOWN and no quote", async () => {
    const { w, step, last } = makeWorld();
    w.rescues = [{ amount: "1000000", at: new Date(w.nowMs - 60_000).toISOString() }];
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(last("RESCUE_BLOCKED")?.decision?.reasons).toEqual(["COOLDOWN"]);
    expect(w.quotes).toEqual([]);
  });

  it("an empty reserve is blocked with INSUFFICIENT_RESERVE", async () => {
    const { w, step, last } = makeWorld({ reserve: "0" });
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(last("RESCUE_BLOCKED")?.decision?.reasons).toEqual(["INSUFFICIENT_RESERVE"]);
    expect(w.quotes).toEqual([]);
  });

  it("a spent daily cap is blocked with OVER_DAILY", async () => {
    const { w, step, last } = makeWorld();
    w.rescues = [{ amount: "50000000", at: new Date(w.nowMs - 3600_000).toISOString() }];
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(last("RESCUE_BLOCKED")?.decision?.reasons).toEqual(["OVER_DAILY"]);
    expect(w.quotes).toEqual([]);
  });

  it("writes the same block at most once per 10 minutes", async () => {
    const { w, step, store } = makeWorld({ policy: { paused: true } });
    w.accountValue = TRIGGER_VALUE;
    await step();
    await step();
    w.nowMs += 9 * MIN;
    await step();
    const blocks = () => store.ledger(100).filter((r) => r.kind === "RESCUE_BLOCKED");
    expect(blocks()).toHaveLength(1);
    w.nowMs += MIN;
    await step();
    expect(blocks()).toHaveLength(2);
  });

  it("writes a new block straight away when the reasons change", async () => {
    const { w, step, store } = makeWorld({ policy: { paused: true } });
    w.accountValue = TRIGGER_VALUE;
    await step();
    w.policy = { ...w.policy, paused: false };
    w.reserve = "0";
    await step();
    const reasons = store.ledger(100).filter((r) => r.kind === "RESCUE_BLOCKED").map((r) => r.decision?.reasons);
    expect(reasons).toEqual([["INSUFFICIENT_RESERVE"], ["PAUSED"]]);
  });
});

describe("a quote the engine refuses", () => {
  const refused = async (override: Partial<Quote>) => {
    const world = makeWorld();
    world.w.accountValue = TRIGGER_VALUE;
    world.w.quoteOverride = override;
    await world.step();
    return world;
  };

  it.each([
    ["RECIPIENT_MISMATCH", { recipient: "0x9999999999999999999999999999999999999999" }],
    ["REFUND_MISMATCH", { refundTo: "keeper.near" }],
    ["WRONG_DEST_ASSET", { destinationAsset: "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f" }],
    ["SLIPPAGE", { minAmountOut: "100000000" }],
    ["QUOTE_STALE", { quotedAt: "2026-11-08T14:00:00.000Z" }],
    ["OVER_PER_RESCUE", { amountIn: "26000000" }],
  ] as [string, Partial<Quote>][])("%s blocks it and moves no funds", async (reason, override) => {
    const { w, last, kinds } = await refused(override);
    expect(last("RESCUE_BLOCKED")?.decision?.reasons).toContain(reason);
    expect(last("RESCUE_BLOCKED")?.request).toBeDefined();
    expect(w.sent).toEqual([]);
    expect(kinds()).not.toContain("RESCUE_ALLOWED");
  });

  it("doesn't ask for more quotes every 5 s after a refusal", async () => {
    const { w, step } = await refused({ recipient: "0x9999999999999999999999999999999999999999" });
    const asked = w.quotes.length;
    w.nowMs += 5000;
    await step();
    expect(w.quotes).toHaveLength(asked);
    w.nowMs += 30_000;
    await step();
    expect(w.quotes.length).toBeGreaterThan(asked);
  });
});

describe("when the rescue goes wrong", () => {
  it("records RESCUE_FAILED when 1Click won't quote, and moves no funds", async () => {
    const { w, step, last, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteError = new QuoteRefusedError("Amount is too low for the destination chain");
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_FAILED"]);
    expect(last("RESCUE_FAILED")?.explanation).toContain("Amount is too low");
    expect(w.sent).toEqual([]);
  });

  it("retries a failed quote later without repeating the record", async () => {
    const { w, step, store } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteError = new Error("1Click is down");
    await step();
    w.nowMs += 31_000;
    await step();
    expect(store.ledger(100).filter((r) => r.kind === "RESCUE_FAILED")).toHaveLength(1);
    w.quoteError = null;
    w.nowMs += 31_000;
    await step();
    expect(w.sent).toHaveLength(1);
  });

  it("still doesn't repeat a failure once the AI has reworded it", async () => {
    const { w, step, store } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteError = new Error("1Click is down");
    await step();
    const first = store.ledger(100).find((r) => r.kind === "RESCUE_FAILED");
    store.setExplanation(first?.id ?? "", "The AI's friendlier wording of the same failure.");
    w.nowMs += 31_000;
    await step();
    expect(store.ledger(100).filter((r) => r.kind === "RESCUE_FAILED")).toHaveLength(1);
  });

  it("hands the vault the text 1Click signed, so the vault can check where the money goes", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    await step();
    expect(w.sent[0]).toMatchObject({ quote: "signed-2", signature: "sig-2", depositAddress: "deposit-2" });
  });

  it("refuses a live quote that 1Click didn't sign for a deposit", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteOverride = { signed: undefined };
    await step();
    expect(w.rescueAttempts).toBe(0);
    expect(last("RESCUE_FAILED")?.explanation).toMatch(/didn't sign the quote/);
  });

  it("refuses a live quote with no deposit address", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteOverride = { depositAddress: null };
    await step();
    expect(last("RESCUE_FAILED")?.explanation).toMatch(/deposit address/i);
    expect(w.sent).toEqual([]);
  });

  it("records RESCUE_FAILED when the vault refuses, and never claims it was done", async () => {
    const { w, step, last, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.vaultError = new VaultRejectedError("Smart contract panicked: cooldown not passed");
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_FAILED"]);
    expect(last("RESCUE_FAILED")?.explanation).toContain("cooldown not passed");
    expect(last("RESCUE_FAILED")?.request?.id).toBeDefined();
  });

  describe("when a send times out, so nobody knows if it went through", () => {
    it("follows the deposit if it did, and records the true outcome", async () => {
      const { w, step, kinds } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.landsDespiteError = true;
      await step();
      expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_DONE"]);
    });

    it("keeps waiting while 1Click works, instead of writing FAILED and sending a second", async () => {
      const { w, step, keeper, kinds } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.landsDespiteError = true;
      w.statuses = [...Array<SwapStatus>(300).fill("PROCESSING"), "SUCCESS"]; // 10 minutes of polling
      const running = step();
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await keeper.tick();
      }
      await running;
      expect(w.rescueAttempts).toBe(1);
      expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_DONE"]);
    });

    it("calls it failed soon if the chain shows it never landed, so the user isn't stuck", async () => {
      const { w, step, last } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.finalStatus = "PENDING_DEPOSIT";
      const startedAt = w.nowMs;
      await step();
      expect(last("RESCUE_FAILED")?.explanation).toMatch(/never reached the vault/i);
      expect(w.nowMs - startedAt).toBeLessThan(5 * MIN);
    });

    it("trusts the chain's no only once the quote is too old for the vault to accept, since the send may still land", async () => {
      const { w, step, last, vault } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.finalStatus = "PENDING_DEPOSIT";
      let askedAt: number | null = null;
      const realGetRescues = vault.getRescues;
      vault.getRescues = async (user) => {
        if (w.rescueAttempts > 0 && askedAt === null) askedAt = w.nowMs;
        return realGetRescues(user);
      };
      const quotedAt = w.nowMs;
      await step();
      expect(last("RESCUE_FAILED")?.explanation).toMatch(/never reached the vault/i);
      // The vault takes a quote for 2 minutes, and 1Click's clock may run 30 s behind NEAR's.
      expect((askedAt ?? 0) - quotedAt).toBeGreaterThanOrEqual(150 * SEC);
    });

    it("waits it out if the chain can't be read either, because a false FAILED could send twice", async () => {
      const { w, step, last, vault } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.finalStatus = "PENDING_DEPOSIT";
      const realGetRescues = vault.getRescues;
      vault.getRescues = async (user) => {
        if (w.rescueAttempts > 0) throw new Error("rpc down");
        return realGetRescues(user);
      };
      const startedAt = w.nowMs;
      await step();
      expect(w.nowMs - startedAt).toBeGreaterThanOrEqual(30 * MIN);
      expect(last("RESCUE_FAILED")?.explanation).toMatch(/may still arrive/i);
    });

    it("treats old vault records with no quote id as a maybe, not a no", async () => {
      const { w, step, vault } = makeWorld();
      w.accountValue = TRIGGER_VALUE;
      w.vaultError = new Error("RPC timeout");
      w.finalStatus = "PENDING_DEPOSIT";
      const realGetRescues = vault.getRescues;
      vault.getRescues = async (user) => {
        const rescues = await realGetRescues(user);
        return w.rescueAttempts > 0 ? [...rescues, { amount: "1", at: new Date(0).toISOString() }] : rescues;
      };
      const startedAt = w.nowMs;
      await step();
      expect(w.nowMs - startedAt).toBeGreaterThanOrEqual(30 * MIN);
    });
  });

  it("doesn't call a refused rescue failed while the vault's history can't be read, because an earlier send may have landed", async () => {
    const { w, step, last, vault } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.vaultError = new VaultRejectedError("Smart contract panicked: DEPOSIT_REUSED");
    w.finalStatus = "PENDING_DEPOSIT";
    const realGetRescues = vault.getRescues;
    vault.getRescues = async (user) => {
      if (w.rescueAttempts > 0) throw new Error("rpc down");
      return realGetRescues(user);
    };
    const startedAt = w.nowMs;
    await step();
    expect(w.nowMs - startedAt).toBeGreaterThanOrEqual(30 * MIN);
    expect(last("RESCUE_FAILED")?.explanation).toMatch(/may still arrive/i);
  });

  it("follows the deposit if the vault says no but the chain shows the rescue landed", async () => {
    // near-api-js re-signs after a nonce error, so the retry can be refused after the first landed.
    const { w, step, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.vaultError = new VaultRejectedError("Smart contract panicked: cooldown not passed");
    w.landsDespiteError = true;
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_DONE"]);
  });

  it("doesn't resend every 5 s after the vault refuses, which would burn the keeper's gas", async () => {
    const { w, step } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.vaultError = new VaultRejectedError("Smart contract panicked: wrong keeper");
    await step();
    expect(w.rescueAttempts).toBe(1);
    for (let i = 0; i < 12; i += 1) {
      w.nowMs += 5000;
      await step();
    }
    expect(w.rescueAttempts).toBe(1);
    w.nowMs += 5 * MIN;
    await step();
    expect(w.rescueAttempts).toBe(2);
  });

  it("says the outcome is unknown when 1Click's status can't be read at all", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.statuses = Array<Error>(1000).fill(new Error("status api down"));
    await step();
    const failed = last("RESCUE_FAILED");
    expect(failed?.oneClickStatus).toBeUndefined();
    expect(failed?.explanation).toMatch(/couldn't be read/i);
    expect(failed?.explanation).toMatch(/may still arrive/i);
    expect(failed?.nearTx).toBe("tx-1");
  });

  it("keeps a secret in a read error out of the public ledger and the logs", async () => {
    const { w, step, last, vault } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    vault.getReserve = async () => {
      throw new Error("http://rpc.example/?apiKey=SUPERSECRET Bad Gateway");
    };
    await step();
    expect(last("RESCUE_FAILED")?.explanation).toBeDefined();
    expect(JSON.stringify(last("RESCUE_FAILED"))).not.toContain("SUPERSECRET");
    expect(w.logs.join("\n")).not.toContain("SUPERSECRET");
  });

  it("keeps a secret in a refused send out of the public ledger too", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.vaultError = new VaultRejectedError("refused by https://rpc.example/?apiKey=SUPERSECRET");
    await step();
    expect(JSON.stringify(last("RESCUE_FAILED"))).not.toContain("SUPERSECRET");
  });

  it("doesn't claim a confirmed rescue when the money never shows on Hyperliquid", async () => {
    const { w, step, last, store } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.creditNever = true;
    await step();
    const done = last("RESCUE_DONE");
    expect(done?.oneClickStatus).toBe("SUCCESS");
    expect(done?.latencyMs).toBeUndefined();
    expect(done?.explanation).toMatch(/didn't show on Hyperliquid/i);
    expect(store.stats().totalUsdRescued).toBe(0);
    expect(store.stats().latencyP50Ms).toBeNull();
  });

  it("still rescues if saving the latest health fails, like on a full disk", async () => {
    const { w, step, store } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    store.saveHealth = () => {
      throw new Error("disk full");
    };
    await step();
    expect(w.sent).toHaveLength(1);
  });

  it("still rescues if recording a warning fails, like when a storage quota runs out", async () => {
    const { w, step, store } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    const latest = store.latest.bind(store);
    store.latest = (user, kind) => {
      if (kind === "WARN") throw new Error("rows read limit exceeded");
      return latest(user, kind);
    };
    await step();
    expect(w.sent).toHaveLength(1);
  });

  it("stores a real number when the position closes mid-rescue", async () => {
    const world = makeWorld();
    world.w.accountValue = TRIGGER_VALUE;
    const original = world.intents.getQuote;
    world.intents.getQuote = async (params) => {
      world.w.margin = 0; // the position closed, so health is now infinite
      return original(params);
    };
    await world.step();
    const blocked = world.last("RESCUE_BLOCKED");
    expect(blocked?.decision?.reasons).toEqual(["NOT_BELOW_TRIGGER"]);
    expect(blocked?.request?.snapshot.health).toBeCloseTo(1.4);
  });

  it("counts latency from the first time health fell, not the last failed attempt", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.quoteError = new Error("1Click is down");
    await step();
    w.nowMs += 31_000;
    w.quoteError = null;
    await step();
    expect(last("RESCUE_DONE")?.latencyMs).toBeGreaterThanOrEqual(31_000);
  });

  it("starts that clock again after a block it wasn't trying to get past", async () => {
    const { w, step, last } = makeWorld({ policy: { paused: true } });
    w.accountValue = TRIGGER_VALUE;
    await step();
    w.nowMs += 3 * 3_600_000;
    w.policy = { ...w.policy, paused: false };
    await step();
    expect(last("RESCUE_DONE")?.latencyMs).toBeLessThan(MIN);
  });

  it.each(["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const)("%s from 1Click is RESCUE_FAILED", async (status) => {
    const { w, step, last, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.finalStatus = status;
    await step();
    expect(kinds()).toEqual(["WARN", "RESCUE_ALLOWED", "RESCUE_FAILED"]);
    expect(last("RESCUE_FAILED")?.oneClickStatus).toBe(status);
    expect(last("RESCUE_FAILED")?.nearTx).toBe("tx-1");
  });

  it.each(["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const)("stops at %s without waiting out the timeout", async (status) => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.finalStatus = status;
    const startedAt = w.nowMs;
    await step();
    expect(w.nowMs - startedAt).toBeLessThan(MIN);
    expect(last("RESCUE_FAILED")?.explanation).toContain(`1Click reported ${status}`);
  });

  it("gives up when 1Click never finishes, and says what it last saw", async () => {
    const { w, step, last } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.finalStatus = "PROCESSING";
    await step();
    expect(last("RESCUE_FAILED")?.oneClickStatus).toBe("PROCESSING");
    expect(last("RESCUE_FAILED")?.explanation).toMatch(/still not finished/i);
  });

  it("keeps polling through a failed status read", async () => {
    const { w, step, kinds } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    w.statuses = [new Error("timeout"), "PROCESSING", new Error("timeout"), "SUCCESS"];
    await step();
    expect(kinds()).toContain("RESCUE_DONE");
  });

  it("calls the rescue off if health recovers while the quote is being fetched", async () => {
    const world = makeWorld();
    world.w.accountValue = TRIGGER_VALUE;
    const original = world.intents.getQuote;
    world.intents.getQuote = async (params) => {
      world.w.accountValue = 90; // the price bounced back
      return original(params);
    };
    await world.step();
    expect(world.last("RESCUE_BLOCKED")?.decision?.reasons).toEqual(["NOT_BELOW_TRIGGER"]);
    expect(world.w.sent).toEqual([]);
  });

  it("still rescues on the snapshot it has if the re-read fails, as long as it's fresh", async () => {
    const world = makeWorld();
    world.w.accountValue = TRIGGER_VALUE;
    // The first read works; the re-read after the quote fails.
    const original = world.intents.getQuote;
    world.intents.getQuote = async (params) => {
      world.w.healthDown = true;
      return original(params);
    };
    await world.step();
    expect(world.w.sent).toHaveLength(1);
  });

  it("doesn't let one user's error stop another user's rescue", async () => {
    const { w, store, intents, vault } = makeWorld();
    w.accountValue = TRIGGER_VALUE;
    const keeper = new Keeper({
      store,
      intents,
      vault: {
        ...vault,
        getPolicy: async (user) => {
          if (user === "broken.near") throw new Error("rpc down");
          return w.policy;
        },
      },
      users: () => ["broken.near", USER],
      readHealth: async () => ({
        status: "ok",
        snapshot: snapshot(w.accountValue, w.margin, new Date(w.nowMs).toISOString()),
        isolatedCoins: [],
      }),
      now: () => new Date(w.nowMs),
      sleep: async (ms) => {
        w.nowMs += ms;
      },
      newId: () => `other-${Math.random()}`,
      dryQuotes: false,
      log: () => {},
    });
    await keeper.tick();
    await keeper.settled();
    expect(w.sent).toHaveLength(1);
  });
});

describe("after a crash", () => {
  const crashMidRescue = async () => {
    const world = makeWorld();
    world.w.accountValue = TRIGGER_VALUE;
    // The first run writes RESCUE_ALLOWED and dies before it can write an outcome.
    world.store.append({
      id: "allowed-1",
      user: USER,
      kind: "RESCUE_ALLOWED",
      healthBefore: 1.4,
      at: new Date(world.w.nowMs - 10_000).toISOString(),
      request: {
        id: "req-crashed",
        user: USER,
        token: ASSETS.NEAR_USDC.contractId,
        amount: "18498453",
        usdNeeded: 18,
        quoteId: "corr-old",
        depositAddress: "deposit-old",
        recipient: HL,
        quoteAt: AT,
        snapshot: snapshot(TRIGGER_VALUE, 30),
      },
    });
    return world;
  };

  it("finishes the rescue it was running instead of sending another", async () => {
    const { w, keeper, last, store } = await crashMidRescue();
    w.sent.push({
      user: USER,
      token: ASSETS.NEAR_USDC.contractId,
      amount: "18498453",
      depositAddress: "deposit-old",
      recipient: HL,
      quoteId: "corr-old",
      quote: "",
      signature: "",
    });
    keeper.recover();
    await keeper.tick();
    await keeper.settled();
    expect(w.sent).toHaveLength(1);
    expect(last("RESCUE_DONE")?.request?.id).toBe("req-crashed");
    expect(store.unfinishedRescues()).toEqual([]);
  });

  it("marks it failed soon if the chain shows it was never sent, so the next rescue isn't stuck", async () => {
    const { w, keeper, last, store } = await crashMidRescue();
    w.finalStatus = "PENDING_DEPOSIT";
    const startedAt = w.nowMs;
    keeper.recover();
    await keeper.settled();
    expect(last("RESCUE_FAILED")?.explanation).toMatch(/never reached the vault/i);
    // Not before its quote is too old to land, but well before the 30-minute wait.
    expect(w.nowMs - startedAt).toBeLessThan(5 * MIN);
    expect(store.unfinishedRescues()).toEqual([]);
  });

  it("keeps waiting after a restart if the chain shows the rescue was sent", async () => {
    const { w, keeper, last } = await crashMidRescue();
    w.sent.push({ user: USER, token: ASSETS.NEAR_USDC.contractId, amount: "18498453", depositAddress: "deposit-old", recipient: HL, quoteId: "corr-old", quote: "", signature: "" });
    w.rescues.push({ amount: "18498453", at: new Date(w.nowMs).toISOString(), quoteId: "corr-old" });
    w.statuses = [...Array<SwapStatus>(100).fill("PROCESSING"), "SUCCESS"]; // 200 s, longer than the first check
    keeper.recover();
    await keeper.settled();
    expect(last("RESCUE_DONE")?.request?.id).toBe("req-crashed");
  });

  it("leaves latency out of a resumed rescue, because downtime isn't rescue time", async () => {
    const { w, keeper, last } = await crashMidRescue();
    w.sent.push({ user: USER, token: ASSETS.NEAR_USDC.contractId, amount: "18498453", depositAddress: "deposit-old", recipient: HL, quoteId: "corr-old", quote: "", signature: "" });
    keeper.recover();
    await keeper.settled();
    expect(last("RESCUE_DONE")?.latencyMs).toBeUndefined();
  });
});

describe("running on a timer", () => {
  it("keeps ticking until stopped", async () => {
    const { w, keeper } = makeWorld();
    w.accountValue = 90;
    let sleeps = 0;
    w.onSleep = () => {
      sleeps += 1;
      if (sleeps === 3) keeper.stop();
    };
    await keeper.run(5000);
    await keeper.settled();
    expect(w.nowMs).toBe(Date.parse(AT) + 15000);
    expect(w.reads).toBe(3);
  });
});
