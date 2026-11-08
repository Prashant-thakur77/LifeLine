import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { signedQuotePayload } from "../src/signed";
import dry from "./recorded/quote-dry.json";
import real from "./recorded/quote-real.json";

type Raw = Parameters<typeof quoteHash>[0];
const hashOf = (payload: string) => base58.encode(sha256(new TextEncoder().encode(payload)));

describe("signedQuotePayload, the exact text 1Click signs", () => {
  it.each([
    ["a real live quote", real],
    ["a real dry quote", dry],
  ])("hashes to the SDK's quoteHash for %s", (_name, raw) => {
    expect(hashOf(signedQuotePayload(raw as unknown as Raw))).toBe(quoteHash(raw as unknown as Raw));
  });

  it("carries what the vault checks: the deposit address, recipient, refund account, assets and amount", () => {
    const signed = JSON.parse(signedQuotePayload(real as unknown as Raw)) as Record<string, unknown>;
    expect(signed).toMatchObject({
      dry: false,
      depositAddress: real.quote.depositAddress,
      recipient: real.quoteRequest.recipient,
      refundTo: real.quoteRequest.refundTo,
      originAsset: real.quoteRequest.originAsset,
      destinationAsset: real.quoteRequest.destinationAsset,
      amount: "5000000",
      amountIn: "5000000",
      timestamp: real.timestamp,
    });
  });

  it("leaves out what 1Click doesn't sign, so a changed app fee can't pass as signed", () => {
    const signed = JSON.parse(signedQuotePayload(real as unknown as Raw)) as Record<string, unknown>;
    expect(signed).not.toHaveProperty("appFees");
    expect(signed).not.toHaveProperty("correlationId");
  });
});
