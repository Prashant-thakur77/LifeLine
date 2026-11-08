import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { signTestnetQuote } from "../src/testnet-quote";

const seed = new Uint8Array(32).fill(5);
const pub = ed25519.getPublicKey(seed);
const key = `ed25519:${base58.encode(new Uint8Array([...seed, ...pub]))}`;
const at = new Date("2026-11-08T15:00:00.000Z");

describe("signTestnetQuote, the stand-in for 1Click on testnet", () => {
  const quote = signTestnetQuote({
    key,
    user: "alice.lifeline-team.testnet",
    token: "usdc.lifeline-team.testnet",
    amount: "1000000",
    recipient: "0x1111111111111111111111111111111111111111",
    depositAddress: "abc",
    now: at,
  });

  it("signs as 1Click does: the base58 SHA-256 of the quote text", () => {
    const message = new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(quote.payload))));
    expect(ed25519.verify(base58.decode(quote.signature.replace("ed25519:", "")), message, pub)).toBe(true);
  });

  it("says everything the vault checks", () => {
    expect(JSON.parse(quote.payload)).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      originAsset: "nep141:usdc.lifeline-team.testnet",
      destinationAsset: "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
      amount: "1000000",
      amountIn: "1000000",
      refundTo: "alice.lifeline-team.testnet",
      recipient: "0x1111111111111111111111111111111111111111",
      depositAddress: "abc",
      slippageTolerance: 100,
      timestamp: "2026-11-08T14:59:58.000Z",
    });
  });
});
