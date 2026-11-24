import { describe, expect, test } from "vitest";
import { CHAINS, ROLES, SIZES, VENUES, WANTS } from "@lifeline/waitlist";
import { leadingZeroBits, powDigest } from "@lifeline/waitlist/pow";
import { CHAIN_LABEL, EMPTY_DRAFT, ROLE_LABEL, SIZE_LABEL, VENUE_LABEL, WANT_LABEL, largestAmount, nextStep, problemWith, shareHref, signUp, sizeOf, solvePow, toggle, understand, wasLiquidated, withStory } from "../src/lib/waitlist";

describe("understanding plain typing", () => {
  test("a whole sentence", () => {
    expect(understand("I trade perps on hyperliquid with about $5k at 10x, money sits on base and I got liquidated in October")).toEqual({
      venues: ["hyperliquid"], chains: ["base"], size: "1k-10k", liquidated: true, role: "trader",
    });
  });
  test("ordinary words aren't chains", () => {
    expect(understand("I was near liquidation, the base case was bad, long ETH and BTC").chains).toEqual([]);
    expect(understand("my funds are on near and solana").chains).toEqual(["near", "solana"]);
  });
  test.each([
    ["nothing here", null], ["10x long since 2024", null], ["$500", 500], ["5k", 5000], ["1.5m", 1_500_000], ["12,000 usdc", 12_000], ["$200 then 30k", 30_000], ["2 million dollars", 2_000_000],
  ])("amount in %s", (text, usd) => expect(largestAmount(text)).toBe(usd));
  test.each([[999, "under-1k"], [1000, "1k-10k"], [10_000, "10k-100k"], [100_000, "10k-100k"], [100_001, "over-100k"]] as const)("%d is %s", (usd, size) => expect(sizeOf(usd)).toBe(size));
  test.each([
    ["I got liquidated twice", true], ["I have never been liquidated", false], ["I haven't been liquidated yet", false],
    ["I don't want to get liquidated", null], ["scared of being liquidated", null], ["I trade", null], ["Never slept. Got rekt in May", true],
  ])("%s", (text, was) => expect(wasLiquidated(text)).toBe(was));
  test.each([["I run a trading agent", "agent"], ["building a perps app", "builder"], ["we'd like to partner", "partner"], ["hello", null]])("%s is %s", (text, role) => expect(understand(text).role).toBe(role));
});

describe("the conversation", () => {
  test("the story adds to what was picked, and never replaces it", () => {
    expect(withStory({ ...EMPTY_DRAFT, role: "builder", venues: ["gmx"], size: "over-100k", note: "I trade on hyperliquid with $500" })).toMatchObject({ role: "builder", venues: ["gmx", "hyperliquid"], size: "over-100k" });
  });
  test("skips what the story answered", () => {
    expect(nextStep("story", { ...EMPTY_DRAFT, role: "trader", venues: ["gmx"], chains: ["base"] })).toBe("size");
    expect(nextStep("story", EMPTY_DRAFT)).toBe("role");
  });
  test("doesn't ask a builder what they trade", () => {
    expect(nextStep("role", { ...EMPTY_DRAFT, role: "builder" })).toBe("chains");
    expect(nextStep("chains", { ...EMPTY_DRAFT, role: "partner" })).toBe("wants");
  });
  test("ends after the email", () => expect(nextStep("email", EMPTY_DRAFT)).toBeNull());
  test("says what's missing", () => {
    expect(problemWith("name", EMPTY_DRAFT)).toMatch(/name/);
    expect(problemWith("role", EMPTY_DRAFT)).toMatch(/Pick/);
    expect(problemWith("email", { ...EMPTY_DRAFT, email: "x" })).toMatch(/email/);
    expect(problemWith("story", EMPTY_DRAFT)).toBeNull();
  });
  test("every choice has a label", () => {
    for (const [list, labels] of [[ROLES, ROLE_LABEL], [VENUES, VENUE_LABEL], [CHAINS, CHAIN_LABEL], [SIZES, SIZE_LABEL], [WANTS, WANT_LABEL]] as const)
      expect(Object.keys(labels).sort()).toEqual([...list].sort());
  });
  test("toggling", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

test("the spam check is solved, and never an unreasonable one", async () => {
  const nonce = await solvePow("c", 8, async () => {});
  expect(leadingZeroBits(powDigest("c", nonce))).toBeGreaterThanOrEqual(8);
  await expect(solvePow("c", 60)).rejects.toThrow(/too much/);
});

test("only the email, role and source are sent", () => {
  expect(signUp({ ...EMPTY_DRAFT, name: "Asha", note: "3 am", email: "a@b.co", role: "trader", size: "1k-10k" }, "Discord")).toEqual({ email: "a@b.co", role: "trader", source: "discord" });
  expect(signUp(EMPTY_DRAFT, null).source).toBe("direct");
});

test("the shared post names the berth and never an email", () => {
  expect(new URL(shareHref("ABC-DEF")).searchParams.get("text")).toContain("ABC-DEF");
});
