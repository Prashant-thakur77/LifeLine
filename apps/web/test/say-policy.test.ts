import { describe, expect, test } from "vitest";
import { heardText, sayPolicy } from "../src/lib/say-policy";
import { presetDraft, validatePolicy } from "../src/lib/policy";

const HL = `0x${"aB".repeat(20)}`;

describe("rules in plain words", () => {
  test.each([
    ["Rescue me below 1.6, refill to 2.2, warn me at 2", { trigger: "1.6", target: "2.2", warn: "2" }],
    ["Keep me above 1.4 and spend at most $20 a day", { trigger: "1.4", maxPerDayUsdc: "20" }],
    ["Top me up when health drops below 1.5, back to 2.1. Max 12.50 USDC per rescue, $1,000 per day", { trigger: "1.5", target: "2.1", maxPerRescueUsdc: "12.5", maxPerDayUsdc: "1000" }],
    ["alert me if it falls under 1.9 and step in at 1.3", { warn: "1.9", trigger: "1.3" }],
    ["no more than 1k daily, 250 at a time", { maxPerDayUsdc: "1000", maxPerRescueUsdc: "250" }],
    ["wait 5 minutes between rescues", { cooldownSec: "300" }],
    ["rescues 90 seconds apart", { cooldownSec: "90" }],
    ["daily cap of 75, rescue cap 30", { maxPerDayUsdc: "75", maxPerRescueUsdc: "30" }],
    [`protect ${HL} when it hits 1.5`, { hlAddress: HL, trigger: "1.5" }],
  ])("%s", (text, changes) => expect(sayPolicy(text).changes).toEqual(changes));

  test("what isn't understood is said, not guessed", () => {
    expect(sayPolicy("use 10x leverage and 35% of my bag")).toMatchObject({ changes: {}, unused: ["10x", "35%"] });
    expect(sayPolicy("send $500 to my friend").unused).toEqual(["$500"]);
  });
  test("a rule said two ways is dropped and named", () => {
    expect(sayPolicy("rescue me below 1.5, or rescue me below 1.7")).toMatchObject({ changes: {}, clashes: ["Rescue below"] });
    expect(sayPolicy("rescue below 1.5. Yes, rescue below 1.5")).toMatchObject({ changes: { trigger: "1.5" }, clashes: [] });
  });
  test.each(["don't rescue me below 1.5", "never warn me at 2", "do not top me up below 1.4"])("a rule turned down isn't a rule: %s", (text) => {
    expect(sayPolicy(text).changes).toEqual({});
    expect(sayPolicy(text).unused).toHaveLength(1);
  });
  test("a limit said with a never is still a limit", () => expect(sayPolicy("never more than $20 a day").changes).toEqual({ maxPerDayUsdc: "20" }));
  test.each([
    "$1.2345678 a day", "$20-30 a day", "10 to 20 USDC per rescue", "wait 1.5 minutes between rescues", "rescue below 1,6", "refill to 2,5", "rescue below 1.5-1.7",
    "please do not ever under any circumstances rescue me below 1.5", "I was hit when health was above 1.2", "my account got liquidated under 1.1",
  ])("not guessed at: %s", (text) => {
    expect(sayPolicy(text).changes).toEqual({});
    expect(sayPolicy(text).unused.length).toBeGreaterThan(0);
  });
  test("a money amount is never read as a health", () => {
    expect(sayPolicy("top me up to 2 USDC").changes.target).toBeUndefined();
    expect(sayPolicy("refill to 5k").changes).toEqual({});
  });
  test("nothing in, nothing out", () => expect(sayPolicy("")).toEqual({ changes: {}, heard: [], unused: [], clashes: [] }));
  test("a huge text is cut, not chewed on", () => {
    const start = performance.now();
    sayPolicy("rescue when health is at to my the account ".repeat(5000));
    expect(performance.now() - start).toBeLessThan(500);
  });
  test("the form still has the last word", () => {
    const draft = { ...presetDraft("standard", HL), ...sayPolicy("rescue me below 9").changes };
    expect(validatePolicy(draft, "keeper.near")).toMatchObject({ ok: false, errors: { trigger: expect.any(String) } });
  });
  test("how it's shown", () => {
    expect(heardText({ field: "maxPerDayUsdc", label: "", value: "20" })).toBe("20 USDC");
    expect(heardText({ field: "cooldownSec", label: "", value: "90" })).toBe("90 s");
    expect(heardText({ field: "hlAddress", label: "", value: HL })).toBe("0xaBaB…aBaB");
    expect(heardText({ field: "warn", label: "", value: "1.8" })).toBe("1.8");
  });
});
