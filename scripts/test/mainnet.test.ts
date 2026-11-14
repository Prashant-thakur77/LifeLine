import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { MAINNET, MAX_SEND, ONE_NEAR, RESERVE, checkReserve, formatNear, readMainnetSettings, sizeAmount, wrapAndDepositActions } from "../src/mainnet";

const ACCOUNT = "3d6e0c641a8a2504385f51080f0ee3ac0918a487182d37c11246a1ab460cdc6a";
const DEPOSIT = "78b5b0e911904274d011a9a90f181da62fc56368c4a1f05448ed43e2cddd2749";
const HL = "0x1111111111111111111111111111111111111111";
const ENV = { HL_MAINNET_ADDRESS: HL, MAINNET_NEAR_ACCOUNT: ACCOUNT, MAINNET_NEAR_PRIVATE_KEY: "ed25519:fake" };

describe("the mainnet route", () => {
  it("quotes the assets the keeper uses, on mainnet 1Click with 1Click's key", () => {
    expect(MAINNET.originAsset).toBe(ASSETS.NEAR_WNEAR.assetId);
    expect(MAINNET.destinationAsset).toBe(ASSETS.HYPERLIQUID_USDC.assetId);
    expect(MAINNET.quoteSigner).toBe("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
    expect(MAINNET.apiUrl).toBe("https://1click.chaindefuser.com");
  });
});

describe("readMainnetSettings", () => {
  it("quotes with --dry, and holds no key then", () => {
    expect(readMainnetSettings(["--dry"], ENV)).toEqual({ dry: true, hlAddress: HL, nearAccount: ACCOUNT, nearKey: null });
  });

  it("spends only with --send, with the key", () => {
    expect(readMainnetSettings(["--send"], ENV)).toEqual({ dry: false, hlAddress: HL, nearAccount: ACCOUNT, nearKey: "ed25519:fake" });
  });

  it("refuses a bare run, both flags, or anything else, so nothing spends by accident", () => {
    for (const argv of [[], ["--dry", "--send"], ["--yes"], ["--send", HL]]) expect(() => readMainnetSettings(argv, ENV)).toThrow(/usage/);
  });

  it("refuses a missing Hyperliquid address, a named account, or --send without a key", () => {
    expect(() => readMainnetSettings(["--dry"], { ...ENV, HL_MAINNET_ADDRESS: "" })).toThrow(/HL_MAINNET_ADDRESS/);
    expect(() => readMainnetSettings(["--dry"], { ...ENV, MAINNET_NEAR_ACCOUNT: "me.near" })).toThrow(/implicit/);
    expect(() => readMainnetSettings(["--send"], { ...ENV, MAINNET_NEAR_PRIVATE_KEY: "" })).toThrow(/MAINNET_NEAR_PRIVATE_KEY/);
  });
});

describe("sizeAmount", () => {
  // 1 wNEAR quoted at 3.2 USDC minimum out, after a 0.3 USDC flat fee (8 decimals).
  const sample = { amountIn: ONE_NEAR.toString(), minAmountOut: "320000000", withdrawFee: "30000000" };

  it("sends enough for the 2.5 USDC target after the flat fee, rounded up to 0.01 NEAR", () => {
    // (2.5 + 0.3) / (3.2 + 0.3) = 0.8 NEAR exactly.
    expect(sizeAmount(sample)).toBe((80n * ONE_NEAR / 100n).toString());
    // (2.5 + 0.3) / (3.0 + 0.3) = 0.8484… NEAR, so 0.85.
    expect(sizeAmount({ ...sample, minAmountOut: "300000000" })).toBe((85n * ONE_NEAR / 100n).toString());
  });

  it("refuses anything over 1.5 NEAR, as when NEAR's price falls", () => {
    // (2.5 + 0.3) / (1.5 + 0.3) = 1.5555… NEAR: over the cap.
    expect(() => sizeAmount({ ...sample, minAmountOut: "150000000" })).toThrow(/1.5 NEAR cap/);
    // (2.5 + 0.3) / (1.6 + 0.3) = 1.4736… NEAR, so 1.48: under it.
    expect(BigInt(sizeAmount({ ...sample, minAmountOut: "160000000" }))).toBeLessThanOrEqual(MAX_SEND);
  });

  it("refuses a sample that delivers nothing", () => {
    expect(() => sizeAmount({ ...sample, minAmountOut: "0", withdrawFee: "0" })).toThrow(/delivers nothing/);
  });
});

describe("wrapAndDepositActions", () => {
  const base = { account: ACCOUNT, depositAddress: DEPOSIT, amount: (109n * ONE_NEAR / 100n).toString(), wnearBalance: "0", accountRegistered: false, depositRegistered: false, storageYocto: 1_250_000_000_000_000_000_000n };

  it("registers both accounts, wraps, and transfers, in that order, for a fresh account", () => {
    const steps = wrapAndDepositActions(base);
    expect(steps.map((s) => s.method)).toEqual(["storage_deposit", "near_deposit", "storage_deposit", "ft_transfer"]);
    expect(steps[0]!.args).toEqual({ account_id: ACCOUNT, registration_only: true });
    expect(steps[1]!.depositYocto).toBe(BigInt(base.amount));
    expect(steps[2]!.args).toEqual({ account_id: DEPOSIT, registration_only: true });
    expect(steps[3]).toEqual({ method: "ft_transfer", args: { receiver_id: DEPOSIT, amount: base.amount }, depositYocto: 1n, gasTgas: 30 });
  });

  it("wraps only what the account doesn't hold yet, and skips registrations already done", () => {
    const steps = wrapAndDepositActions({ ...base, wnearBalance: ONE_NEAR.toString(), accountRegistered: true, depositRegistered: true });
    expect(steps.map((s) => s.method)).toEqual(["near_deposit", "ft_transfer"]);
    expect(steps[0]!.depositYocto).toBe(9n * ONE_NEAR / 100n);
    expect(wrapAndDepositActions({ ...base, wnearBalance: base.amount, accountRegistered: true, depositRegistered: true }).map((s) => s.method)).toEqual(["ft_transfer"]);
  });

  it("refuses more than 1.5 NEAR, nothing, or a named deposit account", () => {
    expect(() => wrapAndDepositActions({ ...base, amount: (MAX_SEND + 1n).toString() })).toThrow(/cap is 1.5/);
    expect(() => wrapAndDepositActions({ ...base, amount: "0" })).toThrow();
    expect(() => wrapAndDepositActions({ ...base, depositAddress: "attacker.near" })).toThrow(/fresh deposit address/);
  });
});

describe("checkReserve", () => {
  const steps = wrapAndDepositActions({ account: ACCOUNT, depositAddress: DEPOSIT, amount: ONE_NEAR.toString(), wnearBalance: "0", accountRegistered: false, depositRegistered: false, storageYocto: 1_250_000_000_000_000_000_000n });

  it("keeps 0.15 NEAR back", () => {
    expect(RESERVE).toBe(15n * ONE_NEAR / 100n);
  });

  it("passes when at least 0.15 NEAR is left after the deposits and gas", () => {
    // 1 NEAR wrapped + 2 × 0.00125 storage + 1 yocto + 0.05 gas allowance from 1.3 NEAR leaves about 0.2475.
    expect(checkReserve(13n * ONE_NEAR / 10n, steps)).toBeGreaterThanOrEqual(RESERVE);
  });

  it("refuses when less would be left, and says how much", () => {
    expect(() => checkReserve(12n * ONE_NEAR / 10n, steps)).toThrow(/leave 0.1474 NEAR, under the 0.1500 NEAR/);
  });
});

describe("formatNear", () => {
  it("shows four decimals, and a negative as negative", () => {
    expect(formatNear(1_090_000_000_000_000_000_000_000n)).toBe("1.0900");
    expect(formatNear(-ONE_NEAR / 10n)).toBe("-0.1000");
  });
});
