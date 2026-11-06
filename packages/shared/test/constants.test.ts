import { describe, expect, it } from "vitest";
import {
  ASSETS,
  KEEPER_POLL_INTERVAL_SEC,
  MAX_QUOTE_AGE_SEC,
  MAX_QUOTE_SLIPPAGE_BPS,
  MAX_SNAPSHOT_AGE_SEC,
  POLICY_DEFAULTS,
  POLICY_RANGES,
  REASON_CODES,
} from "../src/index";

describe("default policy", () => {
  it("matches the locked defaults", () => {
    expect(POLICY_DEFAULTS).toEqual({
      warn: 1.8,
      trigger: 1.5,
      target: 2.0,
      maxPerRescue: "25000000",
      maxPerDay: "50000000",
      cooldownSec: 120,
    });
  });

  it("sits inside the allowed ranges", () => {
    const { warn, trigger, target, cooldownSec } = POLICY_DEFAULTS;
    expect(warn).toBeGreaterThanOrEqual(POLICY_RANGES.warn.min);
    expect(warn).toBeLessThanOrEqual(POLICY_RANGES.warn.max);
    expect(trigger).toBeGreaterThanOrEqual(POLICY_RANGES.trigger.min);
    expect(trigger).toBeLessThanOrEqual(POLICY_RANGES.trigger.max);
    expect(trigger).toBeLessThan(warn);
    expect(target).toBeGreaterThan(trigger);
    expect(target).toBeLessThanOrEqual(POLICY_RANGES.target.max);
    expect(cooldownSec).toBeGreaterThanOrEqual(POLICY_RANGES.cooldownSec.min);
    expect(cooldownSec).toBeLessThanOrEqual(POLICY_RANGES.cooldownSec.max);
  });
});

describe("fixed keeper limits", () => {
  it("matches the plan", () => {
    expect(KEEPER_POLL_INTERVAL_SEC).toBe(5);
    expect(MAX_QUOTE_SLIPPAGE_BPS).toBe(100);
    expect(MAX_QUOTE_AGE_SEC).toBe(60);
    expect(MAX_SNAPSHOT_AGE_SEC).toBe(15);
  });
});

describe("reason codes", () => {
  it("has the 12 codes the policy engine must check, once each", () => {
    expect([...REASON_CODES].sort()).toEqual(
      [
        "RECIPIENT_MISMATCH",
        "WRONG_DEST_ASSET",
        "PAUSED",
        "OVER_PER_RESCUE",
        "OVER_DAILY",
        "COOLDOWN",
        "NOT_BELOW_TRIGGER",
        "SNAPSHOT_STALE",
        "QUOTE_STALE",
        "SLIPPAGE",
        "INSUFFICIENT_RESERVE",
        "UNKNOWN_TOKEN",
      ].sort(),
    );
  });
});

describe("assets from the 1Click token list", () => {
  it("sends rescues to the Hyperliquid perps asset, not the HyperEVM ERC-20", () => {
    expect(ASSETS.HYPERLIQUID_USDC.assetId).toMatch(/^1cs_v1:hypercore:hip1:/);
    expect(ASSETS.HYPERLIQUID_USDC.decimals).toBe(8);
  });

  it("derives each NEAR asset id from its contract id", () => {
    expect(ASSETS.NEAR_USDC.assetId).toBe(`nep141:${ASSETS.NEAR_USDC.contractId}`);
    expect(ASSETS.NEAR_USDC.decimals).toBe(6);
    expect(ASSETS.NEAR_WNEAR.assetId).toBe(`nep141:${ASSETS.NEAR_WNEAR.contractId}`);
    expect(ASSETS.NEAR_WNEAR.decimals).toBe(24);
  });
});
