import { ONE_CLICK_QUOTE_SIGNER } from "@lifeline/intents";
import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Quote } from "@lifeline/intents";
import { CODE_HASH, FUNDING, INIT_ARGS, KEEPER, PARENT, SWAP_IN, VAULT, codeHash, policyFor, swapProblems } from "../src/mainnet-vault";

const ME = "3d6e0c641a8a2504385f51080f0ee3ac0918a487182d37c11246a1ab460cdc6a";
const DEPOSIT = "bf1eeb6fedde5f04ff276caa3d55608c173f4e2115964f0d18f7b7444b6ef3d2";
const swapQuote: Quote = {
  quoteId: "q",
  depositAddress: DEPOSIT,
  amountIn: SWAP_IN.toString(),
  minAmountOut: "3100000",
  withdrawFee: "0",
  recipient: ME,
  refundTo: ME,
  destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  quotedAt: "t",
};
const expected = { implicit: ME, amount: SWAP_IN.toString(), dryMinAmountOut: "3150000" };

describe("swapProblems, for the reserve swap's live quote", () => {
  it("passes an honest quote within 2% of the dry one", () => {
    expect(swapProblems(swapQuote, expected)).toEqual([]);
  });

  it("refuses a minimum more than 2% under the dry quote, or under 2.8 USDC whatever the dry quote said", () => {
    expect(swapProblems({ ...swapQuote, minAmountOut: "3086999" }, expected)).toEqual(["minAmountOut"]);
    expect(swapProblems({ ...swapQuote, minAmountOut: "2799999" }, { ...expected, dryMinAmountOut: "2800000" })).toEqual(["minAmountOut"]);
  });

  it("names every redirected or changed field", () => {
    const bad = { ...swapQuote, recipient: "attacker.near", refundTo: "attacker.near", destinationAsset: "nep141:wrap.near", amountIn: "1", depositAddress: "attacker.near" };
    expect(swapProblems(bad, expected)).toEqual(["recipient", "destinationAsset", "it refunds attacker.near", "it takes 1", "no fresh deposit address"]);
  });
});

describe("policyFor", () => {
  it("is a policy the vault accepts: trigger under warn, target above trigger, 3 USDC caps, keeper named", () => {
    const p = policyFor("0x1311b80F726cfA860b948037b455882713908De0");
    expect(p.trigger).toBeLessThan(p.warn);
    expect(p.target).toBeGreaterThan(p.trigger);
    expect(p.trigger).toBeLessThanOrEqual(2.5);
    expect(p.max_per_rescue).toBe("3000000");
    expect(BigInt(p.max_per_day)).toBeGreaterThanOrEqual(BigInt(p.max_per_rescue));
    expect(p.keeper).toBe(KEEPER);
  });
});

describe("the mainnet vault deployment", () => {
  it("hashes code the way NEAR does: base58 of the SHA-256", () => {
    // The SHA-256 of no bytes, in base58.
    expect(codeHash(new Uint8Array())).toBe("GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
    expect(CODE_HASH).toBe("FUWd4fuXeaL5eu5k6YfkmufXfm7T8uq7gDD6PvuuzAnq");
  });

  it("initialises with native USDC first, then wNEAR, and 1Click's own key", () => {
    expect(INIT_ARGS.tokens).toEqual([ASSETS.NEAR_USDC.contractId, ASSETS.NEAR_WNEAR.contractId]);
    expect(INIT_ARGS.quote_signer).toBe(ONE_CLICK_QUOTE_SIGNER);
  });

  it("names the vault and keeper under the parent", () => {
    expect([PARENT, VAULT, KEEPER]).toEqual(["lifeline-hq.near", "vault.lifeline-hq.near", "keeper.lifeline-hq.near"]);
  });

  it("funds the parent enough for the vault and keeper it creates", () => {
    expect(FUNDING.parent).toBeGreaterThan(FUNDING.vault + FUNDING.keeper);
  });
});
