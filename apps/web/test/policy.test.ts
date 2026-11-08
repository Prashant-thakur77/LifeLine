import { POLICY_DEFAULTS, POLICY_RANGES } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { hlAddressError, isHlAddress, isNearAccount } from "../src/lib/accounts";
import { PRESETS, draftFromVault, matchPreset, presetDraft, validatePolicy, type PolicyDraft } from "../src/lib/policy";

const HL = "0x1111111111111111111111111111111111111111";
const KEEPER = "keeper.lifeline.near";
const good = (): PolicyDraft => presetDraft("standard", HL);

function errorsOf(draft: PolicyDraft, keeper: string | null = KEEPER) {
  const result = validatePolicy(draft, keeper);
  return result.ok ? {} : result.errors;
}

describe("presets", () => {
  it("every preset passes the vault's own checks", () => {
    for (const preset of PRESETS) {
      const result = validatePolicy(presetDraft(preset.id, HL), KEEPER);
      expect(result.ok, preset.id).toBe(true);
    }
  });
  it("triggers are the plan's 2.0, 1.5 and 1.3, and Standard is the default policy", () => {
    expect(PRESETS.map((p) => [p.id, p.trigger])).toEqual([
      ["careful", 2.0],
      ["standard", 1.5],
      ["tight", 1.3],
    ]);
    const standard = PRESETS.find((p) => p.id === "standard")!;
    expect([standard.warn, standard.trigger, standard.target]).toEqual([POLICY_DEFAULTS.warn, POLICY_DEFAULTS.trigger, POLICY_DEFAULTS.target]);
  });
  it("starts with the default caps and cooldown", () => {
    expect(presetDraft("tight")).toMatchObject({ maxPerRescueUsdc: "25", maxPerDayUsdc: "50", cooldownSec: "120", hlAddress: "" });
  });
  it("recognises a preset from its levels", () => {
    expect(matchPreset(2.4, 2.0, 2.8)).toBe("careful");
    expect(matchPreset(1.8, 1.5, 2)).toBe("standard");
    expect(matchPreset(1.8, 1.5, 2.1)).toBe("custom");
  });
});

describe("validatePolicy", () => {
  it("builds the vault's set_policy argument in base units and lower case", () => {
    const result = validatePolicy({ ...good(), hlAddress: "0xABCDEFabcdef1234567890ABCDEFabcdef123456", maxPerRescueUsdc: "2.5" }, KEEPER);
    expect(result).toEqual({
      ok: true,
      policy: {
        hl_address: "0xabcdefabcdef1234567890abcdefabcdef123456",
        keeper: KEEPER,
        warn: 1.8,
        trigger: 1.5,
        target: 2,
        max_per_rescue: "2500000",
        max_per_day: "50000000",
        cooldown_sec: 120,
      },
    });
  });

  it("accepts the edges of every range, like the vault", () => {
    expect(validatePolicy({ ...good(), warn: "3.0", trigger: "2.5", target: "4.0" }, KEEPER).ok).toBe(true);
    expect(validatePolicy({ ...good(), warn: "1.3", trigger: "1.2", target: "1.21" }, KEEPER).ok).toBe(true);
    expect(validatePolicy({ ...good(), cooldownSec: "30" }, KEEPER).ok).toBe(true);
    expect(validatePolicy({ ...good(), cooldownSec: "3600" }, KEEPER).ok).toBe(true);
    expect(validatePolicy({ ...good(), maxPerRescueUsdc: "2", maxPerDayUsdc: "2" }, KEEPER).ok).toBe(true);
  });

  it("refuses warn outside 1.3 to 3.0", () => {
    expect(errorsOf({ ...good(), warn: "1.29" }).warn).toBe("Warn must be from 1.3 to 3.0.");
    expect(errorsOf({ ...good(), warn: "3.01" }).warn).toBe("Warn must be from 1.3 to 3.0.");
  });

  it("refuses trigger outside 1.2 to 2.5, or not strictly below warn", () => {
    expect(errorsOf({ ...good(), trigger: "1.19" }).trigger).toBe("Trigger must be from 1.2 to 2.5.");
    expect(errorsOf({ ...good(), warn: "3.0", trigger: "2.51", target: "3" }).trigger).toBe("Trigger must be from 1.2 to 2.5.");
    expect(errorsOf({ ...good(), warn: "1.5", trigger: "1.5" }).trigger).toBe("Trigger must be below warn.");
  });

  it("refuses a target at or below trigger, or above 4.0", () => {
    expect(errorsOf({ ...good(), target: "1.5" }).target).toBe("Target must be above trigger.");
    expect(errorsOf({ ...good(), target: "4.01" }).target).toBe("Target can be at most 4.0.");
  });

  it("matches the shared ranges, so a change there shows up here", () => {
    expect(POLICY_RANGES).toEqual({ warn: { min: 1.3, max: 3.0 }, trigger: { min: 1.2, max: 2.5 }, target: { max: 4.0 }, cooldownSec: { min: 30, max: 3600 } });
  });

  it("refuses caps below the 1Click minimum, a daily cap below the per-rescue cap, and bad numbers", () => {
    expect(errorsOf({ ...good(), maxPerRescueUsdc: "1.99" }).maxPerRescueUsdc).toMatch(/At least 2 USDC/);
    expect(errorsOf({ ...good(), maxPerRescueUsdc: "30", maxPerDayUsdc: "29.99" }).maxPerDayUsdc).toBe(
      "The daily cap must be at least the cap per rescue.",
    );
    expect(errorsOf({ ...good(), maxPerRescueUsdc: "1.0000001" }).maxPerRescueUsdc).toBe("At most 6 decimal places.");
    expect(errorsOf({ ...good(), maxPerDayUsdc: "lots" }).maxPerDayUsdc).toBe("Enter a number, like 10 or 2.5.");
  });

  it("refuses caps the vault's u128 can't hold", () => {
    const huge = "340282366920938463463374607431768.211456"; // 2^128 base units
    expect(errorsOf({ ...good(), maxPerRescueUsdc: huge, maxPerDayUsdc: huge }).maxPerRescueUsdc).toBe("That's more than the vault can store.");
    const max = "340282366920938463463374607431768.211455"; // 2^128 - 1
    expect(validatePolicy({ ...good(), maxPerRescueUsdc: "25", maxPerDayUsdc: max }, KEEPER).ok).toBe(true);
  });

  it("refuses a cooldown outside 30 to 3,600 seconds or not whole", () => {
    expect(errorsOf({ ...good(), cooldownSec: "29" }).cooldownSec).toBe("Cooldown must be from 30 to 3,600 seconds.");
    expect(errorsOf({ ...good(), cooldownSec: "3601" }).cooldownSec).toBe("Cooldown must be from 30 to 3,600 seconds.");
    expect(errorsOf({ ...good(), cooldownSec: "90.5" }).cooldownSec).toBe("Enter whole seconds, like 120.");
  });

  it("refuses levels that aren't plain decimals", () => {
    for (const bad of ["", "abc", "1e0", "-1.5", "Infinity", "NaN"]) {
      expect(errorsOf({ ...good(), warn: bad }).warn, bad).toBe("Enter a number, like 1.8.");
    }
  });

  it("needs a keeper account", () => {
    expect(errorsOf(good(), null).keeper).toMatch(/No keeper account/);
    expect(errorsOf(good(), "Not A Keeper").keeper).toMatch(/isn't a valid NEAR account/);
  });

  it("reports every problem at once", () => {
    expect(Object.keys(errorsOf({ ...good(), hlAddress: "", warn: "9", cooldownSec: "1" })).sort()).toEqual(["cooldownSec", "hlAddress", "warn"]);
  });
});

describe("draftFromVault", () => {
  it("fills the form from a saved policy, caps back in USDC", () => {
    expect(
      draftFromVault({
        hl_address: HL,
        keeper: KEEPER,
        warn: 2.4,
        trigger: 2,
        target: 2.8,
        max_per_rescue: "2500000",
        max_per_day: "100000000",
        cooldown_sec: 300,
        paused: true,
      }),
    ).toEqual({ hlAddress: HL, warn: "2.4", trigger: "2", target: "2.8", maxPerRescueUsdc: "2.5", maxPerDayUsdc: "100", cooldownSec: "300" });
  });
});

describe("accounts", () => {
  it("checks Hyperliquid addresses the way the vault does", () => {
    expect(isHlAddress(HL)).toBe(true);
    expect(isHlAddress("0xABCDEFabcdef1234567890ABCDEFabcdef123456")).toBe(true);
    expect(isHlAddress("0x111")).toBe(false);
    expect(isHlAddress(`${HL}1`)).toBe(false);
    expect(isHlAddress("1x1111111111111111111111111111111111111111")).toBe(false);
    expect(isHlAddress("0x111111111111111111111111111111111111111g")).toBe(false);
  });
  it("explains what's wrong with an address", () => {
    expect(hlAddressError("")).toMatch(/Enter the address/);
    expect(hlAddressError("1111")).toMatch(/starts with 0x/);
    expect(hlAddressError("0x1234")).toMatch(/this one has 4/);
    expect(hlAddressError("0x111111111111111111111111111111111111111z")).toMatch(/Only 0-9 and a-f/);
    expect(hlAddressError(` ${HL} `)).toBeNull();
  });
  it("checks NEAR account IDs", () => {
    for (const ok of ["demo.near", "keeper.lifeline.near", "a1", "alice_b-c.testnet", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]) {
      expect(isNearAccount(ok), ok).toBe(true);
    }
    for (const bad of ["a", "Alice.near", ".near", "alice..near", "alice.", "-alice.near", "a".repeat(65), "al ice.near"]) {
      expect(isNearAccount(bad), bad).toBe(false);
    }
  });
});
