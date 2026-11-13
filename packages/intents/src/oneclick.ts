import type { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { signedQuotePayload } from "./signed";
import { ASSETS, MAX_QUOTE_SLIPPAGE_BPS } from "@lifeline/shared";
import { QuoteRefusedError, SWAP_STATUSES, type Intents, type Quote, type SwapStatus } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
const QUOTE_DEADLINE_MS = 5 * 60 * 1000;

export type OneClickOptions = {
  apiUrl: string;
  jwt?: string;
  nearSenderAccount: string; // the vault, which is what sends the deposit
  /** The key quotes must be signed with, `ed25519:…`. Default: 1Click's. */
  quoteSigner?: string;
  now?: () => Date;
  fetch?: typeof fetch;
};

type QuoteResponse = Parameters<typeof verifyQuoteSignature>[0] & {
  correlationId: string;
  timestamp: string;
  quote: {
    amountIn: string;
    minAmountOut: string;
    withdrawFee: string;
    depositAddress?: string;
  };
  quoteRequest: { recipient: string; refundTo: string; destinationAsset: string };
};

const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

/** 1Click's signing key: the 1Click SDK's own default, which a test holds this to. */
export const ONE_CLICK_QUOTE_SIGNER = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** The 32 bytes of an `ed25519:<base58>` public key. Throws on anything else. */
export function signerKeyBytes(key: string): Uint8Array {
  if (!key.startsWith("ed25519:")) throw new Error("a quote signer key must start with ed25519:");
  const bytes = base58.decode(key.slice("ed25519:".length));
  if (bytes.length !== 32) throw new Error("a quote signer key must be 32 bytes");
  return bytes;
}

/**
 * The SDK's verifyQuoteSignature, over the same message (the base58 SHA-256 of the signed
 * text, which is the SDK's quoteHash), but with noble's strict Ed25519 instead of
 * tweetnacl's: about 1 ms of CPU instead of 12, which matters where CPU per invocation is
 * capped, like a Cloudflare Worker. Tests hold the two to the same answer on real quotes
 * and on every field a tamperer would change. The vault runs the same check on chain.
 */
export function isSignedBy(raw: Parameters<typeof verifyQuoteSignature>[0], signer: string | Uint8Array = ONE_CLICK_QUOTE_SIGNER): boolean {
  try {
    const key = typeof signer === "string" ? signerKeyBytes(signer) : signer;
    const signature = base58.decode(raw.signature.replace(/^ed25519:/, ""));
    const hash = base58.encode(sha256(new TextEncoder().encode(signedQuotePayload(raw))));
    const message = new TextEncoder().encode(hash);
    return ed25519.verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}

const ONE_CLICK_KEY = signerKeyBytes(ONE_CLICK_QUOTE_SIGNER);

/** isSignedBy with 1Click's own key. */
export function isSignedBy1Click(raw: Parameters<typeof verifyQuoteSignature>[0]): boolean {
  return isSignedBy(raw, ONE_CLICK_KEY);
}

/**
 * Every field the keeper sent must come back, signed, unchanged. A valid signature alone
 * isn't enough: a dry quote's signature leaves out the deposit address and fee, so a
 * genuine dry quote with an attacker's deposit address added would otherwise pass as a
 * live one. The deadline is the one field left out: a stale quote fails the policy
 * engine's 60 s age check anyway.
 */
function checkEcho(raw: QuoteResponse, sent: Record<string, unknown>): void {
  const echoed = (raw.quoteRequest ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(sent)) {
    if (field === "deadline") continue;
    if (echoed[field] !== value) throw new QuoteRefusedError(`the quote doesn't answer what was asked: ${field} differs`);
  }
}

function parseQuote(raw: QuoteResponse, sent: Record<string, unknown>, signer: Uint8Array): Quote {
  // Checked before anything is read, so a tampered field can never be used.
  if (!isSignedBy(raw, signer)) throw new QuoteRefusedError("the quote's signature is invalid");
  checkEcho(raw, sent);

  const { correlationId, timestamp, quote, quoteRequest } = raw;
  const fields = [
    correlationId,
    timestamp,
    quote.amountIn,
    quote.minAmountOut,
    quote.withdrawFee,
    quoteRequest.recipient,
    quoteRequest.refundTo,
    quoteRequest.destinationAsset,
  ];
  if (!fields.every(isString)) throw new QuoteRefusedError("the quote is missing a field");

  return {
    quoteId: correlationId,
    depositAddress: quote.depositAddress ?? null,
    amountIn: quote.amountIn,
    minAmountOut: quote.minAmountOut,
    withdrawFee: quote.withdrawFee,
    recipient: quoteRequest.recipient,
    refundTo: quoteRequest.refundTo,
    destinationAsset: quoteRequest.destinationAsset,
    quotedAt: timestamp,
    ...((sent.dry as boolean) ? {} : { signed: { payload: signedQuotePayload(raw), signature: raw.signature } }),
  };
}

/**
 * The keeper's 1Click calls: NEAR USDC to Hyperliquid USDC, nothing else. Every quote's
 * signature and echoed request are checked before any field of it is read.
 */
export function createOneClick(options: OneClickOptions): Intents {
  const { apiUrl, jwt, nearSenderAccount } = options;
  const signer = options.quoteSigner === undefined ? ONE_CLICK_KEY : signerKeyBytes(options.quoteSigner);
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await doFetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = (body as { message?: unknown } | null)?.message;
      throw new QuoteRefusedError(`1Click ${response.status}: ${isString(message) ? message : "request failed"}`);
    }
    return body;
  };

  return {
    async getQuote({ amount, recipient, refundTo, dry }) {
      const body = {
        dry,
        swapType: "EXACT_INPUT",
        slippageTolerance: MAX_QUOTE_SLIPPAGE_BPS,
        originAsset: ASSETS.NEAR_USDC.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: ASSETS.HYPERLIQUID_USDC.assetId,
        amount,
        refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(now().getTime() + QUOTE_DEADLINE_MS).toISOString(),
      };
      const raw = await request("/v0/quote", { method: "POST", body: JSON.stringify(body) });
      return parseQuote(raw as QuoteResponse, body, signer);
    },

    async getStatus(depositAddress) {
      const raw = await request(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      const status = (raw as { status?: unknown } | null)?.status;
      if (!SWAP_STATUSES.includes(status as SwapStatus)) throw new Error(`unknown 1Click status: ${String(status)}`);
      return status as SwapStatus;
    },

    async submitDeposit({ txHash, depositAddress }) {
      await request("/v0/deposit/submit", {
        method: "POST",
        body: JSON.stringify({ txHash, depositAddress, nearSenderAccount }),
      });
    },
  };
}
