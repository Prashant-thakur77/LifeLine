import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ASSETS, MAX_QUOTE_SLIPPAGE_BPS } from "@lifeline/shared";
import { SWAP_STATUSES, type Intents, type Quote, type SwapStatus } from "./ports";

const REQUEST_TIMEOUT_MS = 10_000;
const QUOTE_DEADLINE_MS = 5 * 60 * 1000;

export type OneClickOptions = {
  apiUrl: string;
  jwt?: string;
  nearSenderAccount: string; // the vault, which is what sends the deposit
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

function parseQuote(raw: QuoteResponse): Quote {
  // Checked before anything is read, so a tampered field can never be used.
  if (!verifyQuoteSignature(raw)) throw new Error("the quote's signature is invalid");

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
  if (!fields.every(isString)) throw new Error("the quote is missing a field");

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
  };
}

/**
 * The keeper's 1Click calls: NEAR USDC to Hyperliquid USDC, nothing else. Written
 * here so the keeper can run before packages/intents lands; swap it in then.
 */
export function createOneClick(options: OneClickOptions): Intents {
  const { apiUrl, jwt, nearSenderAccount } = options;
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
      throw new Error(`1Click ${response.status}: ${isString(message) ? message : "request failed"}`);
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
      return parseQuote(raw as QuoteResponse);
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
