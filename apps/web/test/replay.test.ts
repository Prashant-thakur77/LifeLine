import type { AuditRecord } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { lastRescueStory, storyLog } from "../src/lib/replay";

const request = (id: string, health: number, at: string) => ({
  id,
  user: "demo.near",
  token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  amount: "3469653",
  usdNeeded: 3.12,
  quoteId: `q-${id}`,
  depositAddress: `sim-${id}`,
  recipient: "0x1111111111111111111111111111111111111111",
  quoteAt: at,
  snapshot: { hlAddress: "0x1111111111111111111111111111111111111111", accountValue: 8, maintenanceMarginUsed: 5.56, health, positions: [], at },
  destinationAsset: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
  minAmountOutUsd: 3.119014,
  refundTo: "demo.near",
});

/** One drop, newest first, the way the sim keeper's /api/audit returns it. */
function drop(id: string, warnAt: string, allowedAt: string, doneAt: string): AuditRecord[] {
  const req = request(id, 1.4388, allowedAt);
  return [
    { id: `${id}-d`, user: "demo.near", kind: "RESCUE_DONE", at: doneAt, request: req, decision: { verdict: "allow", reasons: [] }, nearTx: "sim-tx-1", oneClickStatus: "SUCCESS", healthBefore: 1.4388, healthAfter: 2.0062, latencyMs: 5895, explanation: "Lifeline moved 3.47 USDC." },
    { id: `${id}-a`, user: "demo.near", kind: "RESCUE_ALLOWED", at: allowedAt, request: req, decision: { verdict: "allow", reasons: [] }, healthBefore: 1.4388 },
    { id: `${id}-w`, user: "demo.near", kind: "WARN", at: warnAt, healthBefore: 1.7857 },
  ];
}

const latest = drop("b813", "2026-11-08T18:22:09.478Z", "2026-11-08T18:22:16.373Z", "2026-11-08T18:22:20.373Z");
const older = drop("8358", "2026-11-08T18:06:14.405Z", "2026-11-08T18:06:21.144Z", "2026-11-08T18:06:25.144Z");

describe("lastRescueStory", () => {
  it("tells the newest finished rescue: the warning, the trigger and the refill, from the records alone", () => {
    const story = lastRescueStory([...latest, ...older]);
    expect(story).toEqual({
      warn: { health: 1.7857, at: "2026-11-08T18:22:09.478Z" },
      trigger: { health: 1.4388, at: "2026-11-08T18:22:16.373Z" },
      restored: { health: 2.0062, at: "2026-11-08T18:22:20.373Z" },
      amount: "3.47 USDC",
      latencyMs: 5895,
      simulated: true,
      explanation: "Lifeline moved 3.47 USDC.",
      rulesBroken: 0,
      recipient: "0x1111111111111111111111111111111111111111",
    });
  });

  it("doesn't depend on the order the records arrive in", () => {
    const shuffled = [older[2]!, latest[0]!, older[0]!, latest[2]!, latest[1]!, older[1]!];
    expect(lastRescueStory(shuffled)?.restored.at).toBe("2026-11-08T18:22:20.373Z");
  });

  it("leaves the warning out when none came shortly before the trigger", () => {
    const [done, allowed] = latest;
    const farWarn: AuditRecord = { id: "w-old", user: "demo.near", kind: "WARN", at: "2026-11-08T17:00:00.000Z", healthBefore: 1.79 };
    expect(lastRescueStory([done!, allowed!, farWarn])?.warn).toBeNull();
  });

  it("ignores a warning that is lower than the trigger, which would draw the story backwards", () => {
    const [done, allowed] = latest;
    const odd: AuditRecord = { id: "w-low", user: "demo.near", kind: "WARN", at: "2026-11-08T18:22:12.000Z", healthBefore: 1.3 };
    expect(lastRescueStory([done!, allowed!, odd])?.warn).toBeNull();
  });

  it("falls back to the request's own snapshot when the allow record is missing", () => {
    const story = lastRescueStory([latest[0]!]);
    expect(story?.trigger).toEqual({ health: 1.4388, at: "2026-11-08T18:22:16.373Z" });
  });

  it("returns null when no rescue finished, or a finished one lacks its health readings", () => {
    expect(lastRescueStory([])).toBeNull();
    expect(lastRescueStory([latest[1]!, latest[2]!])).toBeNull();
    const { healthAfter: _drop, ...noAfter } = latest[0]!;
    expect(lastRescueStory([noAfter])).toBeNull();
    expect(lastRescueStory([{ ...latest[0]!, healthBefore: Number.NaN }])).toBeNull();
  });

  it("leaves the policy verdict unknown when the allow record is missing", () => {
    expect(lastRescueStory([latest[0]!])?.rulesBroken).toBe(0);
    const { decision: _d, ...noDecision } = latest[0]!;
    expect(lastRescueStory([noDecision])?.rulesBroken).toBeNull();
  });

  it("marks a real rescue as not simulated", () => {
    const real = latest.map((r) => ({ ...r, ...(r.nearTx ? { nearTx: "9xQf1bq" } : {}), ...(r.request ? { request: { ...r.request, depositAddress: "a".repeat(64) } } : {}) }));
    expect(lastRescueStory(real)?.simulated).toBe(false);
  });
});

describe("storyLog", () => {
  const story = lastRescueStory([...latest, ...older])!;
  const levels = { warn: 1.8, trigger: 1.5, target: 2 };

  it("writes the keeper's log of the rescue from the recorded values, beat by beat", () => {
    expect(storyLog(story, levels)).toEqual([
      { beat: "warn", tag: "READ", text: "health 1.79, below the warn line of 1.80" },
      { beat: "trigger", tag: "READ", text: "health 1.44, below the trigger of 1.50" },
      { beat: "trigger", tag: "QUOTE", text: "3.47 USDC to the perps balance" },
      { beat: "trigger", tag: "POLICY", text: "allowed, no rule broken" },
      { beat: "throw", tag: "VAULT", text: "paid (simulated vault)" },
      { beat: "restored", tag: "SAFE", text: "health 2.01, 5.9 s after the trigger" },
    ]);
  });

  it("says what it doesn't know rather than guessing", () => {
    const sparse = { ...story, warn: null, latencyMs: null, rulesBroken: null, simulated: false };
    expect(storyLog(sparse, levels).map((l) => `${l.tag} ${l.text}`)).toEqual([
      "READ health 1.44, below the trigger of 1.50",
      "QUOTE 3.47 USDC to the perps balance",
      "POLICY allowed",
      "VAULT checked the signed quote and paid",
      "SAFE health 2.01",
    ]);
  });
});
