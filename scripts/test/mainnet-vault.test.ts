import { ONE_CLICK_QUOTE_SIGNER } from "@lifeline/intents";
import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { CODE_HASH, FUNDING, INIT_ARGS, KEEPER, PARENT, VAULT, codeHash } from "../src/mainnet-vault";

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
