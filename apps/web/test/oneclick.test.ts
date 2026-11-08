import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import {
  SWAP_STATUSES,
  buildFundingQuote,
  chainName,
  fundingChains,
  fundingQuoteProblem,
  oneClickErrorMessage,
  statusInfo,
  type OneClickToken,
} from "../src/lib/oneclick";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

describe("buildFundingQuote", () => {
  it("asks for USDC on NEAR, delivered to the user's own account, with 1% slippage", () => {
    expect(
      buildFundingQuote({ originAsset: BASE_USDC, originChain: "base", amountBase: "20000000", nearAccount: "alice.near", dry: true, nowMs: NOW }),
    ).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: BASE_USDC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ASSETS.NEAR_USDC.assetId,
      amount: "20000000",
      refundTo: "alice.near",
      refundType: "INTENTS",
      recipient: "alice.near",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-08T13:00:00.000Z",
    });
  });

  it("refunds on the origin chain when the user gives an address there", () => {
    const quote = buildFundingQuote({
      originAsset: BASE_USDC,
      originChain: "base",
      amountBase: "1",
      nearAccount: "alice.near",
      refundAddress: "  0x2527D02599Ba641c19FEa793cD0F167589a0f10D ",
      dry: false,
      nowMs: NOW,
    });
    expect(quote).toMatchObject({ dry: false, refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", refundType: "ORIGIN_CHAIN" });
  });

  it("treats a blank refund address as none", () => {
    const quote = buildFundingQuote({ originAsset: "x", originChain: "eth", amountBase: "1", nearAccount: "alice.near", refundAddress: "   ", dry: true, nowMs: NOW });
    expect(quote).toMatchObject({ refundTo: "alice.near", refundType: "INTENTS" });
  });

  it("asks for a memo deposit where 1Click requires one", () => {
    const stellar = buildFundingQuote({ originAsset: "nep245:x", originChain: "stellar", amountBase: "1", nearAccount: "a.near", dry: true, nowMs: NOW });
    expect(stellar.depositMode).toBe("MEMO");
    const base = buildFundingQuote({ originAsset: BASE_USDC, originChain: "base", amountBase: "1", nearAccount: "a.near", dry: true, nowMs: NOW });
    expect("depositMode" in base).toBe(false);
  });

  it("gives slow chains three hours before the refund starts", () => {
    const quote = buildFundingQuote({ originAsset: "nep141:btc.omft.near", originChain: "btc", amountBase: "10000", nearAccount: "a.near", dry: true, nowMs: NOW });
    expect(quote.deadline).toBe("2026-11-08T15:00:00.000Z");
  });
});

describe("fundingQuoteProblem", () => {
  const request = buildFundingQuote({ originAsset: BASE_USDC, originChain: "base", amountBase: "1", nearAccount: "alice.near", dry: false, nowMs: NOW });
  const response = (patch: Partial<typeof request>) => ({
    correlationId: "c",
    timestamp: "t",
    signature: "s",
    quoteRequest: { ...request, ...patch },
    quote: { amountIn: "1", amountInFormatted: "1", amountInUsd: "1", minAmountIn: "1", amountOut: "1", amountOutFormatted: "1", amountOutUsd: "1", minAmountOut: "1", timeEstimate: 1 },
  });
  it("accepts a quote that pays USDC on NEAR to the account", () => {
    expect(fundingQuoteProblem(response({}), "alice.near")).toBeNull();
  });
  it("refuses one for another account, another asset or another kind of recipient", () => {
    expect(fundingQuoteProblem(response({}), "bob.near")).toBe("This quote pays alice.near, not bob.near.");
    expect(fundingQuoteProblem(response({ destinationAsset: "nep141:wrap.near" }), "alice.near")).toMatch(/USDC on NEAR/);
    expect(fundingQuoteProblem(response({ recipientType: "INTENTS" as never }), "alice.near")).toMatch(/NEAR account itself/);
  });
});

describe("statusInfo", () => {
  it("has a message for every 1Click status", () => {
    for (const status of SWAP_STATUSES) {
      const info = statusInfo(status, "Base");
      expect(info.title.length, status).toBeGreaterThan(0);
      expect(info.detail.length, status).toBeGreaterThan(20);
    }
  });
  it("stops polling only on SUCCESS, REFUNDED and FAILED", () => {
    expect(SWAP_STATUSES.filter((s) => statusInfo(s).final)).toEqual(["SUCCESS", "REFUNDED", "FAILED"]);
  });
  it("keeps polling an incomplete deposit, since the rest can still arrive", () => {
    expect(statusInfo("INCOMPLETE_DEPOSIT")).toMatchObject({ tone: "warning", final: false });
  });
  it("names the origin chain where it matters", () => {
    expect(statusInfo("PENDING_DEPOSIT", "Base").detail).toContain("from Base");
    expect(statusInfo("KNOWN_DEPOSIT_TX", "Solana").detail).toContain("on Solana");
  });
  it("uses tones that match the outcome", () => {
    expect(statusInfo("SUCCESS").tone).toBe("success");
    expect(statusInfo("REFUNDED").tone).toBe("warning");
    expect(statusInfo("FAILED").tone).toBe("error");
    expect(statusInfo("PROCESSING").tone).toBe("progress");
  });
  it("copes with a status 1Click adds later", () => {
    expect(statusInfo("SOMETHING_NEW")).toMatchObject({ final: false, tone: "waiting" });
  });
});

describe("fundingChains", () => {
  const token = (assetId: string, blockchain: string, symbol: string): OneClickToken => ({
    assetId,
    blockchain,
    symbol,
    decimals: 6,
    price: 1,
    priceUpdatedAt: "2026-11-08T12:00:00.000Z",
  });
  const tokens = [
    token(ASSETS.NEAR_USDC.assetId, "near", "USDC"),
    token("nep141:wrap.near", "near", "wNEAR"),
    token("nep141:eth.omft.near", "eth", "ETH"),
    token("eth-usdc", "eth", "USDC"),
    token("zz", "zzchain", "ZZ"),
    token("sol", "sol", "SOL"),
  ];

  it("leaves out NEAR USDC, the destination itself", () => {
    const all = fundingChains(tokens).flatMap((c) => c.tokens.map((t) => t.assetId));
    expect(all).not.toContain(ASSETS.NEAR_USDC.assetId);
    expect(all).toHaveLength(5);
  });
  it("puts popular chains first and stablecoins first within a chain", () => {
    const chains = fundingChains(tokens);
    expect(chains.map((c) => c.chain)).toEqual(["eth", "sol", "near", "zzchain"]);
    expect(chains[0]!.tokens.map((t) => t.symbol)).toEqual(["USDC", "ETH"]);
    expect(chains[3]!.name).toBe("ZZCHAIN");
  });
  it("names chains", () => {
    expect(chainName("arb")).toBe("Arbitrum");
    expect(chainName("hypercore")).toBe("Hyperliquid");
  });
});

describe("oneClickErrorMessage", () => {
  it("passes on 1Click's own message", () => {
    expect(oneClickErrorMessage(400, { message: "refundTo is not valid" })).toBe("1Click said: refundTo is not valid");
  });
  it("explains the unhelpful ones", () => {
    expect(oneClickErrorMessage(500, { message: "Internal server error" })).toMatch(/account exists/);
    expect(oneClickErrorMessage(429, null)).toMatch(/rate limiting/);
    expect(oneClickErrorMessage(502, "<html>")).toBe("1Click answered with HTTP 502.");
  });
});
