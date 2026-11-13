import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ASSETS } from "@lifeline/shared";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { ONE_CLICK_QUOTE_SIGNER, createOneClick, isSignedBy, isSignedBy1Click, signerKeyBytes } from "../src/oneclick";
import { signedQuotePayload } from "../src/signed";
import dry from "./recorded/quote-dry.json";
import real from "./recorded/quote-real.json";
import statusPending from "./recorded/status-pending.json";

type Call = { url: string; init: RequestInit };

function client(respond: (call: Call) => Response | Promise<Response>, jwt?: string) {
  const calls: Call[] = [];
  const oneClick = createOneClick({
    apiUrl: "https://oneclick.test",
    ...(jwt === undefined ? {} : { jwt }),
    nearSenderAccount: "vault.team.near",
    now: () => new Date("2026-11-08T15:00:00.000Z"),
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  });
  return { oneClick, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const params = { amount: "5000000", recipient: "0x1111111111111111111111111111111111111111", refundTo: "wrap.near" };
const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>;

describe("getQuote", () => {
  it("reads a real dry quote, which has no deposit address", async () => {
    const { oneClick } = client(() => json(dry));
    expect(await oneClick.getQuote({ ...params, dry: true })).toEqual({
      quoteId: dry.correlationId,
      depositAddress: null,
      amountIn: dry.quote.amountIn,
      minAmountOut: dry.quote.minAmountOut,
      withdrawFee: dry.quote.withdrawFee,
      recipient: params.recipient,
      refundTo: "wrap.near",
      destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
      quotedAt: dry.timestamp,
    });
  });

  it("reads a real non-dry quote's deposit address", async () => {
    const { oneClick } = client(() => json(real));
    const quote = await oneClick.getQuote({ ...params, dry: false });
    expect(quote.depositAddress).toBe(real.quote.depositAddress);
    expect(quote.quoteId).toBe(real.correlationId);
  });

  it("keeps a live quote's signed text and signature, for the vault to check", async () => {
    const { oneClick } = client(() => json(real));
    const quote = await oneClick.getQuote({ ...params, dry: false });
    expect(quote.signed).toEqual({ payload: signedQuotePayload(real as never), signature: real.signature });
  });

  it("asks for NEAR USDC to Hyperliquid USDC, 1% slippage, on the perps route", async () => {
    const { oneClick, calls } = client(() => json(dry));
    await oneClick.getQuote({ ...params, dry: true });
    expect(calls[0]?.url).toBe("https://oneclick.test/v0/quote");
    expect(bodyOf(calls[0])).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSETS.NEAR_USDC.assetId,
      destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      amount: "5000000",
      recipient: params.recipient,
      refundTo: "wrap.near",
      deadline: "2026-11-08T15:05:00.000Z",
    });
  });

  it("rejects a quote whose recipient was changed after 1Click signed it", async () => {
    const tampered = structuredClone(real);
    tampered.quoteRequest.recipient = "0x9999999999999999999999999999999999999999";
    const { oneClick } = client(() => json(tampered));
    await expect(oneClick.getQuote({ ...params, dry: false })).rejects.toThrow(/signature/i);
  });

  it("rejects a quote whose deposit address was changed after 1Click signed it", async () => {
    const tampered = structuredClone(real);
    tampered.quote.depositAddress = "attacker.near";
    const { oneClick } = client(() => json(tampered));
    await expect(oneClick.getQuote({ ...params, dry: false })).rejects.toThrow(/signature/i);
  });

  it("rejects a quote with no signature", async () => {
    const { signature: _removed, ...unsigned } = real;
    const { oneClick } = client(() => json(unsigned));
    await expect(oneClick.getQuote({ ...params, dry: false })).rejects.toThrow();
  });

  it("passes on 1Click's own error message", async () => {
    const { oneClick } = client(() => json({ message: "Amount is too low for the destination chain" }, 400));
    await expect(oneClick.getQuote({ ...params, dry: true })).rejects.toThrow("Amount is too low");
  });

  it("copes with an error that isn't JSON", async () => {
    const { oneClick } = client(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(oneClick.getQuote({ ...params, dry: true })).rejects.toThrow("502");
  });

  it("sets a timeout on the request", async () => {
    const { oneClick, calls } = client(() => json(dry));
    await oneClick.getQuote({ ...params, dry: true });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the JWT only when there is one", async () => {
    const withJwt = client(() => json(dry), "secret-token");
    await withJwt.oneClick.getQuote({ ...params, dry: true });
    expect((withJwt.calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");

    const without = client(() => json(dry));
    await without.oneClick.getQuote({ ...params, dry: true });
    expect((without.calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("getStatus", () => {
  it("reads a real status response", async () => {
    const { oneClick, calls } = client(() => json(statusPending));
    expect(await oneClick.getStatus("abc def")).toBe("PENDING_DEPOSIT");
    expect(calls[0]?.url).toBe("https://oneclick.test/v0/status?depositAddress=abc%20def");
  });

  it.each(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT", "PROCESSING", "KNOWN_DEPOSIT_TX"])("knows %s", async (status) => {
    const { oneClick } = client(() => json({ status }));
    expect(await oneClick.getStatus("x")).toBe(status);
  });

  it("throws on a status it doesn't know, rather than guessing", async () => {
    const { oneClick } = client(() => json({ status: "SOMETHING_NEW" }));
    await expect(oneClick.getStatus("x")).rejects.toThrow("SOMETHING_NEW");
  });

  it("throws on an error response", async () => {
    const { oneClick } = client(() => json({ message: "Deposit address not found" }, 404));
    await expect(oneClick.getStatus("x")).rejects.toThrow("Deposit address not found");
  });
});

describe("submitDeposit", () => {
  it("names the vault as the NEAR sender", async () => {
    const { oneClick, calls } = client(() => json({}));
    await oneClick.submitDeposit({ txHash: "hash", depositAddress: "addr" });
    expect(calls[0]?.url).toBe("https://oneclick.test/v0/deposit/submit");
    expect(bodyOf(calls[0])).toEqual({ txHash: "hash", depositAddress: "addr", nearSenderAccount: "vault.team.near" });
  });
});

describe("the quote signature check", () => {
  type Raw = Parameters<typeof verifyQuoteSignature>[0];
  const recorded: [string, Raw][] = [
    ["a real quote", real as unknown as Raw],
    ["a dry quote", dry as unknown as Raw],
  ];

  it.each(recorded)("accepts %s, as the 1Click SDK does", (_name, quote) => {
    expect(verifyQuoteSignature(quote)).toBe(true);
    expect(isSignedBy1Click(quote)).toBe(true);
  });

  /** Every field a tamperer would want, plus the signature and timestamp themselves. */
  type Editable = { quote: Record<string, unknown>; quoteRequest: Record<string, unknown>; signature: string; timestamp: string };
  const tamperings: [string, (q: Editable) => void][] = [
    ["recipient", (q) => (q.quoteRequest.recipient = "0x9999999999999999999999999999999999999999")],
    ["refundTo", (q) => (q.quoteRequest.refundTo = "attacker.near")],
    ["destinationAsset", (q) => (q.quoteRequest.destinationAsset = "nep141:wrap.near")],
    ["depositAddress", (q) => (q.quote.depositAddress = "attacker.near")],
    ["amountIn", (q) => (q.quote.amountIn = "1")],
    ["minAmountOut", (q) => (q.quote.minAmountOut = "999999999999")],
    ["withdrawFee", (q) => (q.quote.withdrawFee = "0")],
    ["timestamp", (q) => (q.timestamp = "2030-01-01T00:00:00.000Z")],
    ["signature", (q) => (q.signature = q.signature.slice(0, -4) + (q.signature.endsWith("1111") ? "2222" : "1111"))],
  ];

  it.each(tamperings)("refuses a quote with a changed %s, as the 1Click SDK does", (_field, tamper) => {
    const quote = structuredClone(real) as unknown as Editable;
    tamper(quote);
    expect(verifyQuoteSignature(quote as unknown as Raw)).toBe(false);
    expect(isSignedBy1Click(quote as unknown as Raw)).toBe(false);
  });

  it("refuses junk instead of throwing", () => {
    expect(isSignedBy1Click({ ...(real as object), signature: "not base58 !" } as never)).toBe(false);
    expect(isSignedBy1Click({} as never)).toBe(false);
  });
});

describe("another quote signer, such as a testnet sandbox's", () => {
  type Raw = Parameters<typeof verifyQuoteSignature>[0];
  const secret = ed25519.utils.randomSecretKey();
  const testKey = `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`;
  /** A recorded quote, signed again the way 1Click signs, but with the test key. */
  const signedWithTestKey = <T extends object>(recorded: T): T => {
    const hash = base58.encode(sha256(new TextEncoder().encode(signedQuotePayload(recorded as unknown as Raw))));
    return { ...recorded, signature: `ed25519:${base58.encode(ed25519.sign(new TextEncoder().encode(hash), secret))}` };
  };

  it("verifies a quote signed by a test key with that key only, as the 1Click SDK does", () => {
    const quote = signedWithTestKey(real) as unknown as Raw;
    expect(isSignedBy(quote, testKey)).toBe(true);
    expect(verifyQuoteSignature(quote, testKey)).toBe(true);
    expect(isSignedBy(quote)).toBe(false);
    expect(isSignedBy1Click(quote)).toBe(false);
    expect(verifyQuoteSignature(quote)).toBe(false);
    expect(isSignedBy(real as unknown as Raw, testKey)).toBe(false);
  });

  it("defaults to 1Click's key, the one the 1Click SDK uses", () => {
    expect(ONE_CLICK_QUOTE_SIGNER).toBe("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
    expect(isSignedBy(real as unknown as Raw)).toBe(true);
    expect(verifyQuoteSignature(real as unknown as Raw, ONE_CLICK_QUOTE_SIGNER)).toBe(true);
  });

  it("makes createOneClick accept only quotes signed by the key it was given", async () => {
    const resigned = signedWithTestKey(dry);
    const withTestKey = (body: unknown) =>
      createOneClick({ apiUrl: "https://sandbox.test", nearSenderAccount: "vault.team.testnet", quoteSigner: testKey, now: () => new Date("2026-11-08T15:00:00.000Z"), fetch: (async () => json(body)) as unknown as typeof fetch });
    expect((await withTestKey(resigned).getQuote({ ...params, dry: true })).quoteId).toBe(dry.correlationId);
    await expect(withTestKey(dry).getQuote({ ...params, dry: true })).rejects.toThrow(/signature is invalid/);
  });

  it("keeps createOneClick on 1Click's key when no signer is given", async () => {
    await expect(client(() => json(signedWithTestKey(dry))).oneClick.getQuote({ ...params, dry: true })).rejects.toThrow(/signature is invalid/);
    expect((await client(() => json(dry)).oneClick.getQuote({ ...params, dry: true })).quoteId).toBe(dry.correlationId);
  });

  it("refuses a malformed signer key when the client is made, not on the first quote", () => {
    for (const bad of ["reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc", "ed25519:abc", "ed25519:not base58 !"]) {
      expect(() => signerKeyBytes(bad)).toThrow();
      expect(() => createOneClick({ apiUrl: "https://x.test", nearSenderAccount: "v.testnet", quoteSigner: bad })).toThrow();
    }
  });
});

describe("a signed quote that doesn't answer what was asked", () => {
  it("refuses a signed dry quote served for a live request, even with a deposit address added", async () => {
    // A dry quote's signature leaves out the deposit address and fee, so this would otherwise pass.
    const replayed = { ...structuredClone(dry), quote: { ...structuredClone(dry).quote, depositAddress: "attacker.near", withdrawFee: "1" } };
    const { oneClick } = client(() => json(replayed));
    await expect(oneClick.getQuote({ ...params, dry: false })).rejects.toThrow(/dry/);
  });

  it("refuses a live quote served for a dry request", async () => {
    const { oneClick } = client(() => json(real));
    await expect(oneClick.getQuote({ ...params, dry: true })).rejects.toThrow(/dry/);
  });

  it.each([
    ["amount", { amount: "9000000" }],
    ["recipient", { recipient: "0x2222222222222222222222222222222222222222" }],
    ["refundTo", { refundTo: "someone-else.near" }],
  ])("refuses a genuine quote for a different %s", async (field, changed) => {
    const { oneClick } = client(() => json(real));
    await expect(oneClick.getQuote({ ...params, ...changed, dry: false })).rejects.toThrow(new RegExp(field));
  });
});

