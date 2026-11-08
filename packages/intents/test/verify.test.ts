import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import type { Quote } from "../src/types";
import { verifyQuote } from "../src/verify";

const HL = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const quote: Quote = {
  quoteId: "corr-1",
  depositAddress: "ef0eeb5ba22b7da3ad34b9cf99c637dd4d81758b1d1e529125ab4f7240a16fbb",
  amountIn: "3000000",
  minAmountOut: "266000000",
  withdrawFee: "31530000",
  recipient: HL.toLowerCase(),
  refundTo: "alice.near",
  destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
  quotedAt: "2026-11-08T12:00:00.000Z",
};
const expected = { recipient: HL, destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId, minAmountOut: "266000000" };

describe("verifyQuote", () => {
  it("passes a quote that pays the right address the right asset, at least the amount expected", () => {
    expect(verifyQuote(quote, expected)).toEqual([]);
    expect(verifyQuote({ ...quote, minAmountOut: "300000000" }, expected)).toEqual([]);
  });

  it("names every problem at once", () => {
    const bad = { ...quote, recipient: "0x9999999999999999999999999999999999999999", destinationAsset: "1cs_v1:hypercore:erc20:0x1", minAmountOut: "1" };
    expect(verifyQuote(bad, expected)).toEqual(["recipient", "destinationAsset", "minAmountOut"]);
  });

  it("compares a 0x address in any case, but a NEAR account exactly", () => {
    expect(verifyQuote({ ...quote, recipient: HL.toUpperCase().replace("0X", "0x") }, expected)).toEqual([]);
    expect(verifyQuote({ ...quote, recipient: "Alice.near" }, { ...expected, recipient: "alice.near" })).toEqual(["recipient"]);
  });

  it("refuses an amount it can't read rather than pass it", () => {
    expect(verifyQuote({ ...quote, minAmountOut: "lots" }, expected)).toEqual(["minAmountOut"]);
  });
});
