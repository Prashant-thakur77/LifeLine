import { ASSETS, POLICY_DEFAULTS, REASON_CODES, type HealthSnapshot, type Policy } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { evaluate, GUARD_CODES, type PolicyRequest, type RescueHistory } from "../src/index";

const NOW = new Date("2026-11-08T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1000;
const HOUR = 3600 * SEC;

const USER_HL = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";

const snapshot: HealthSnapshot = {
  hlAddress: USER_HL,
  accountValue: 50.32,
  maintenanceMarginUsed: 34,
  health: 1.48,
  positions: [{ coin: "ETH", size: 0.5, entryPx: 3400, liquidationPx: 3120.5 }],
  at: ago(5 * SEC),
};

const policy: Policy = {
  user: "alice.near",
  hlAddress: USER_HL,
  warn: POLICY_DEFAULTS.warn,
  trigger: POLICY_DEFAULTS.trigger,
  target: POLICY_DEFAULTS.target,
  maxPerRescue: POLICY_DEFAULTS.maxPerRescue,
  maxPerDay: POLICY_DEFAULTS.maxPerDay,
  cooldownSec: POLICY_DEFAULTS.cooldownSec,
  paused: false,
};

const request: PolicyRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  user: "alice.near",
  token: ASSETS.NEAR_USDC.contractId,
  amount: "18056800",
  usdNeeded: 17.68,
  quoteId: "fake-quote",
  depositAddress: "fake-deposit-address",
  recipient: USER_HL,
  quoteAt: ago(10 * SEC),
  snapshot,
  destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
  minAmountOutUsd: 17.7,
};

const history: RescueHistory = { rescues: [], reserve: "20000000" };

type Overrides = {
  request?: Partial<PolicyRequest>;
  policy?: Partial<Policy>;
  history?: Partial<RescueHistory>;
  snapshot?: Partial<HealthSnapshot>;
  now?: Date;
};

const run = (o: Overrides = {}) =>
  evaluate(
    { ...request, ...o.request },
    { ...policy, ...o.policy },
    { ...history, ...o.history },
    { ...snapshot, ...o.snapshot },
    o.now ?? NOW,
  );

const blocked = (reason: string) => ({ verdict: "block", reasons: [reason] });
const allowed = { verdict: "allow", reasons: [] };

describe("a good rescue", () => {
  it("is allowed with no reasons", () => {
    expect(run()).toEqual(allowed);
  });
});

describe("RECIPIENT_MISMATCH", () => {
  it("blocks a quote that pays an attacker", () => {
    expect(run({ request: { recipient: ATTACKER } })).toEqual(blocked("RECIPIENT_MISMATCH"));
  });
  it("blocks an empty recipient", () => {
    expect(run({ request: { recipient: "" } })).toEqual(blocked("RECIPIENT_MISMATCH"));
  });
  it("allows the registered address", () => {
    expect(run({ request: { recipient: USER_HL } })).toEqual(allowed);
  });
  it("allows the same address in different case, since EVM addresses ignore case", () => {
    const hl = "0xAbCdEf0000000000000000000000000000000001";
    expect(
      run({
        request: { recipient: hl.toLowerCase() },
        policy: { hlAddress: hl },
        snapshot: { hlAddress: hl },
      }),
    ).toEqual(allowed);
  });
});

describe("WRONG_DEST_ASSET", () => {
  it("blocks the HyperEVM USDC, which adds no margin", () => {
    const destinationAsset = "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f";
    expect(run({ request: { destinationAsset } })).toEqual(blocked("WRONG_DEST_ASSET"));
  });
  it("blocks another token on Hyperliquid", () => {
    const destinationAsset = "1cs_v1:hypercore:hip1:0x20b8c9d2f022ffd2aea4f7962b7b1d8b";
    expect(run({ request: { destinationAsset } })).toEqual(blocked("WRONG_DEST_ASSET"));
  });
  it("allows Hyperliquid perps USDC", () => {
    expect(run({ request: { destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId } })).toEqual(allowed);
  });
});

describe("PAUSED", () => {
  it("blocks while the user has paused", () => {
    expect(run({ policy: { paused: true } })).toEqual(blocked("PAUSED"));
  });
  it("allows when not paused", () => {
    expect(run({ policy: { paused: false } })).toEqual(allowed);
  });
});

describe("OVER_PER_RESCUE", () => {
  const big = { request: { minAmountOutUsd: 25, usdNeeded: 25 }, history: { reserve: "90000000" } };
  it("allows exactly the cap", () => {
    expect(run({ ...big, request: { ...big.request, amount: "25000000" } })).toEqual(allowed);
  });
  it("blocks one base unit over the cap", () => {
    expect(run({ ...big, request: { ...big.request, amount: "25000001" } })).toEqual(
      blocked("OVER_PER_RESCUE"),
    );
  });
  it("compares amounts too large for a JS number exactly", () => {
    const cap = "9007199254740993000"; // past 2^53
    const wide = {
      policy: { maxPerRescue: cap, maxPerDay: "99999999999999999999" },
      history: { reserve: "99999999999999999999" },
    };
    expect(run({ ...wide, request: { amount: cap } })).toEqual(allowed);
    expect(run({ ...wide, request: { amount: "9007199254740993001" } })).toEqual(
      blocked("OVER_PER_RESCUE"),
    );
  });
  it("blocks a wNEAR rescue today: its base units dwarf a cap set in USDC units", () => {
    const oneNear = `1${"0".repeat(ASSETS.NEAR_WNEAR.decimals)}`;
    const decision = run({
      request: { token: ASSETS.NEAR_WNEAR.contractId, amount: oneNear },
      history: { reserve: oneNear },
    });
    expect(decision.verdict).toBe("block");
    expect(decision.reasons).toContain("OVER_PER_RESCUE");
  });
});

describe("OVER_DAILY", () => {
  const spent = (amount: string, at: string) => ({ rescues: [{ amount, at }] });
  it("allows reaching exactly the daily cap", () => {
    expect(run({ history: spent("31943200", ago(3 * HOUR)) })).toEqual(allowed);
  });
  it("blocks one base unit past the daily cap", () => {
    expect(run({ history: spent("31943201", ago(3 * HOUR)) })).toEqual(blocked("OVER_DAILY"));
  });
  it("sums every rescue inside the window", () => {
    const rescues = [
      { amount: "20000000", at: ago(3 * HOUR) },
      { amount: "20000000", at: ago(2 * HOUR) },
    ];
    expect(run({ history: { rescues } })).toEqual(blocked("OVER_DAILY"));
  });
  it("still counts a rescue just inside 24 h", () => {
    const at = ago(24 * HOUR - 1);
    expect(run({ history: spent("40000000", at) })).toEqual(blocked("OVER_DAILY"));
  });
  it("forgets a rescue exactly 24 h old, because the window rolls", () => {
    expect(run({ history: spent("40000000", ago(24 * HOUR)) })).toEqual(allowed);
  });
});

describe("COOLDOWN", () => {
  const last = (at: string) => ({ rescues: [{ amount: "1000000", at }] });
  it("blocks just inside the cooldown", () => {
    expect(run({ history: last(ago(120 * SEC - 1)) })).toEqual(blocked("COOLDOWN"));
  });
  it("allows exactly when the cooldown ends", () => {
    expect(run({ history: last(ago(120 * SEC)) })).toEqual(allowed);
  });
  it("allows a first rescue with no history", () => {
    expect(run({ history: { rescues: [] } })).toEqual(allowed);
  });
  it("uses the newest rescue, whatever order history is in", () => {
    const rescues = [
      { amount: "1000000", at: ago(10 * SEC) },
      { amount: "1000000", at: ago(5 * HOUR) },
    ];
    expect(run({ history: { rescues } })).toEqual(blocked("COOLDOWN"));
  });
  it("follows the user's own cooldown setting", () => {
    expect(run({ policy: { cooldownSec: 30 }, history: last(ago(45 * SEC)) })).toEqual(allowed);
    expect(run({ policy: { cooldownSec: 60 }, history: last(ago(45 * SEC)) })).toEqual(
      blocked("COOLDOWN"),
    );
  });
});

describe("NOT_BELOW_TRIGGER", () => {
  it("allows health just below the trigger", () => {
    expect(run({ snapshot: { health: 1.4999 } })).toEqual(allowed);
  });
  it.each([
    ["exactly at the trigger", 1.5],
    ["above the trigger", 2.4],
    ["with no positions", Number.POSITIVE_INFINITY],
    ["when health is not a number", Number.NaN],
  ])("blocks %s", (_name, health) => {
    expect(run({ snapshot: { health } })).toEqual(blocked("NOT_BELOW_TRIGGER"));
  });
  it("trusts the fresh snapshot, not the one in the request", () => {
    const stale = { ...snapshot, health: 1.1 };
    expect(run({ request: { snapshot: stale }, snapshot: { health: 2.4 } })).toEqual(
      blocked("NOT_BELOW_TRIGGER"),
    );
  });
});

describe("SNAPSHOT_STALE", () => {
  it("allows a snapshot exactly 15 s old", () => {
    expect(run({ snapshot: { at: ago(15 * SEC) } })).toEqual(allowed);
  });
  it("blocks one just older than 15 s", () => {
    expect(run({ snapshot: { at: ago(15 * SEC + 1) } })).toEqual(blocked("SNAPSHOT_STALE"));
  });
  it("blocks a time it can't read", () => {
    expect(run({ snapshot: { at: "not a date" } })).toEqual(blocked("SNAPSHOT_STALE"));
  });
  it("allows small clock skew but blocks a snapshot far in the future", () => {
    expect(run({ snapshot: { at: ago(-2 * SEC) } })).toEqual(allowed);
    expect(run({ snapshot: { at: ago(-60 * SEC) } })).toEqual(blocked("SNAPSHOT_STALE"));
  });
});

describe("QUOTE_STALE", () => {
  it("allows a quote exactly 60 s old", () => {
    expect(run({ request: { quoteAt: ago(60 * SEC) } })).toEqual(allowed);
  });
  it("blocks one just older than 60 s", () => {
    expect(run({ request: { quoteAt: ago(60 * SEC + 1) } })).toEqual(blocked("QUOTE_STALE"));
  });
  it("blocks a time it can't read", () => {
    expect(run({ request: { quoteAt: "" } })).toEqual(blocked("QUOTE_STALE"));
  });
  it("allows small clock skew but blocks a quote far in the future", () => {
    expect(run({ request: { quoteAt: ago(-2 * SEC) } })).toEqual(allowed);
    expect(run({ request: { quoteAt: ago(-120 * SEC) } })).toEqual(blocked("QUOTE_STALE"));
  });
});

describe("SLIPPAGE", () => {
  const needed = { usdNeeded: 10 };
  it("allows a guaranteed amount of exactly 99% of what's needed", () => {
    expect(run({ request: { ...needed, minAmountOutUsd: 9.9 } })).toEqual(allowed);
  });
  it("blocks anything below 99%", () => {
    expect(run({ request: { ...needed, minAmountOutUsd: 9.89 } })).toEqual(blocked("SLIPPAGE"));
  });
  it("blocks when the guaranteed amount isn't a number", () => {
    expect(run({ request: { ...needed, minAmountOutUsd: Number.NaN } })).toEqual(blocked("SLIPPAGE"));
  });
});

describe("INSUFFICIENT_RESERVE", () => {
  it("allows spending the whole reserve", () => {
    expect(run({ history: { reserve: "18056800" } })).toEqual(allowed);
  });
  it("blocks one base unit short", () => {
    expect(run({ history: { reserve: "18056799" } })).toEqual(blocked("INSUFFICIENT_RESERVE"));
  });
  it("blocks an empty reserve", () => {
    expect(run({ history: { reserve: "0" } })).toEqual(blocked("INSUFFICIENT_RESERVE"));
  });
});

describe("UNKNOWN_TOKEN", () => {
  it("blocks a token that isn't a reserve asset", () => {
    expect(run({ request: { token: "usdt.tether-token.near" } })).toEqual(blocked("UNKNOWN_TOKEN"));
  });
  it("allows USDC", () => {
    expect(run({ request: { token: ASSETS.NEAR_USDC.contractId } })).toEqual(allowed);
  });
  it("allows wNEAR when the amount fits the caps", () => {
    expect(run({ request: { token: ASSETS.NEAR_WNEAR.contractId } })).toEqual(allowed);
  });
});

describe("bad input fails closed", () => {
  it("blocks a request for another user", () => {
    expect(run({ request: { user: "mallory.near" } })).toEqual(blocked("USER_MISMATCH"));
  });
  it("blocks when the fresh snapshot is of another account", () => {
    expect(run({ snapshot: { hlAddress: ATTACKER } })).toEqual(blocked("SNAPSHOT_MISMATCH"));
  });
  it.each([
    ["a non-numeric amount", { request: { amount: "abc" } }],
    ["a negative amount", { request: { amount: "-5" } }],
    ["a zero amount", { request: { amount: "0" } }],
    ["a decimal amount", { request: { amount: "1.5" } }],
    ["a hex amount", { request: { amount: "0x10" } }],
    ["a bad per-rescue cap", { policy: { maxPerRescue: "" } }],
    ["a bad daily cap", { policy: { maxPerDay: "lots" } }],
    ["a bad reserve", { history: { reserve: "NaN" } }],
    ["a zero dollar need", { request: { usdNeeded: 0 } }],
    ["a dollar need that isn't a number", { request: { usdNeeded: Number.NaN } }],
    ["a history amount it can't read", { history: { rescues: [{ amount: "x", at: ago(HOUR) }] } }],
    ["a history time it can't read", { history: { rescues: [{ amount: "1", at: "?" }] } }],
    ["a cooldown that isn't a number", { policy: { cooldownSec: Number.NaN } }],
    [
      "a policy with no Hyperliquid address, which an empty recipient would match",
      { policy: { hlAddress: "" }, request: { recipient: "" }, snapshot: { hlAddress: "" } },
    ],
  ] as [string, Overrides][])("blocks %s without throwing", (_name, overrides) => {
    const decision = run(overrides);
    expect(decision.verdict).toBe("block");
    expect(decision.reasons).toContain("MALFORMED_INPUT");
  });
});

describe("the decision as a whole", () => {
  it("reports every broken rule, not just the first", () => {
    const decision = run({
      request: { recipient: ATTACKER, amount: "25000001", quoteAt: ago(120 * SEC) },
      policy: { paused: true },
      snapshot: { health: 2.4 },
    });
    expect(decision.verdict).toBe("block");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "RECIPIENT_MISMATCH",
        "PAUSED",
        "OVER_PER_RESCUE",
        "NOT_BELOW_TRIGGER",
        "QUOTE_STALE",
      ]),
    );
  });

  it("only ever returns codes the rest of the system knows", () => {
    const known: readonly string[] = [...REASON_CODES, ...GUARD_CODES];
    const decision = run({
      request: {
        user: "mallory.near",
        recipient: ATTACKER,
        token: "x.near",
        amount: "abc",
        quoteAt: "",
        destinationAsset: "x",
        minAmountOutUsd: 0,
      },
      policy: { paused: true },
      history: { reserve: "x", rescues: [{ amount: "y", at: "z" }] },
      snapshot: { health: 9, at: "?", hlAddress: ATTACKER },
    });
    expect(decision.reasons.length).toBeGreaterThan(0);
    for (const reason of decision.reasons) expect(known).toContain(reason);
  });

  it("is pure: same input, same answer, and nothing it was given changes", () => {
    const input = structuredClone({ request, policy, history, snapshot });
    const first = evaluate(input.request, input.policy, input.history, input.snapshot, NOW);
    const second = evaluate(input.request, input.policy, input.history, input.snapshot, NOW);
    expect(first).toEqual(second);
    expect(input).toEqual({ request, policy, history, snapshot });
  });

  it("makes no network calls", () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("no network allowed");
    }) as typeof fetch;
    try {
      expect(run()).toEqual(allowed);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
