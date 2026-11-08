import { ASSETS, MAX_QUOTE_SLIPPAGE_BPS } from "@lifeline/shared";

// The 1Click Swap API, as documented at https://docs.near-intents.org and its OpenAPI spec
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml). It allows any origin, so the
// browser calls it directly. Funding a reserve swaps any token on any chain into USDC on
// NEAR, delivered to the user's own NEAR account.

export const ONECLICK_URL = "https://1click.chaindefuser.com";

export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string | null;
};

export type QuoteRequest = {
  dry: boolean;
  depositMode?: "SIMPLE" | "MEMO";
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
};

export type Quote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
};

/** No quoteId: correlationId identifies the quote. */
export type QuoteResponse = {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
};

export const SWAP_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "SUCCESS",
  "INCOMPLETE_DEPOSIT",
  "REFUNDED",
  "FAILED",
] as const;

export type SwapStatus = (typeof SWAP_STATUSES)[number];

export type StatusResponse = {
  correlationId: string;
  status: SwapStatus;
  updatedAt: string;
  quoteResponse?: QuoteResponse;
  swapDetails?: {
    amountOutFormatted?: string;
    refundedAmountFormatted?: string;
    refundReason?: string;
    depositedAmountFormatted?: string;
    nearTxHashes?: string[];
  };
};

/** Where a funding swap lands: USDC on NEAR, the reserve token. */
export const FUNDING_DESTINATION = ASSETS.NEAR_USDC.assetId;

/** 1Click refuses SIMPLE deposits from these chains ("Incorrect depositMode", 2026-11-08). */
const MEMO_CHAINS = new Set(["stellar"]);

/** Chains where a deposit can take an hour to confirm get a longer deadline. */
const SLOW_CHAINS = new Set(["btc", "ltc", "doge", "bch", "dash", "zec", "cardano"]);

export type FundingQuoteInput = {
  originAsset: string;
  originChain: string;
  amountBase: string;
  /** The user's NEAR account. USDC arrives here, and refunds go here when no origin address is given. */
  nearAccount: string;
  /** An address on the origin chain for refunds. Leave empty to refund into the account's NEAR Intents balance. */
  refundAddress?: string;
  dry: boolean;
  nowMs: number;
};

/**
 * The quote request for funding a reserve. With no refund address on the origin chain, a
 * refund goes to the user's own NEAR account inside NEAR Intents, which 1Click accepts
 * for every origin chain (checked with a dry quote on 2026-11-08).
 */
export function buildFundingQuote(input: FundingQuoteInput): QuoteRequest {
  const refundAddress = input.refundAddress?.trim() ?? "";
  const hours = SLOW_CHAINS.has(input.originChain) ? 3 : 1;
  return {
    dry: input.dry,
    ...(MEMO_CHAINS.has(input.originChain) ? { depositMode: "MEMO" as const } : {}),
    swapType: "EXACT_INPUT",
    slippageTolerance: MAX_QUOTE_SLIPPAGE_BPS,
    originAsset: input.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: FUNDING_DESTINATION,
    amount: input.amountBase,
    refundTo: refundAddress === "" ? input.nearAccount : refundAddress,
    refundType: refundAddress === "" ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: input.nearAccount,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(input.nowMs + hours * 3_600_000).toISOString(),
  };
}

/**
 * Refuses a quote that doesn't pay USDC on NEAR to the account it was asked for, so a
 * deposit address is only ever shown for the connected account's own funding.
 */
export function fundingQuoteProblem(response: QuoteResponse, nearAccount: string): string | null {
  const request = response.quoteRequest;
  if (request.recipient !== nearAccount) return `This quote pays ${request.recipient}, not ${nearAccount}.`;
  if (request.destinationAsset !== FUNDING_DESTINATION) return "This quote doesn't deliver USDC on NEAR.";
  if (request.recipientType !== "DESTINATION_CHAIN") return "This quote doesn't deliver to the NEAR account itself.";
  return null;
}

export type Tone = "waiting" | "progress" | "success" | "warning" | "error";

export type StatusInfo = { title: string; detail: string; tone: Tone; final: boolean };

/** What to tell the user for each 1Click status. `final` stops the polling. */
export function statusInfo(status: string, chainName = "the origin chain"): StatusInfo {
  switch (status) {
    case "PENDING_DEPOSIT":
      return {
        title: "Waiting for your deposit",
        detail: `Send the exact amount to the deposit address from ${chainName}. This page updates on its own.`,
        tone: "waiting",
        final: false,
      };
    case "KNOWN_DEPOSIT_TX":
      return {
        title: "Deposit seen",
        detail: `1Click has seen your transaction and is waiting for it to confirm on ${chainName}.`,
        tone: "progress",
        final: false,
      };
    case "PROCESSING":
      return {
        title: "Swapping to USDC",
        detail: "Your deposit arrived. 1Click is converting it to USDC and sending it to your NEAR account.",
        tone: "progress",
        final: false,
      };
    case "SUCCESS":
      return {
        title: "USDC delivered",
        detail: "The USDC is in your NEAR account. Move it into your reserve below so rescues can use it.",
        tone: "success",
        final: true,
      };
    case "INCOMPLETE_DEPOSIT":
      return {
        title: "Deposit too small",
        detail: "Less than the quoted amount arrived. Send the rest to the same address before the deadline, or 1Click refunds what it received.",
        tone: "warning",
        final: false,
      };
    case "REFUNDED":
      return {
        title: "Refunded",
        detail: "The swap couldn't complete, so 1Click sent your funds back to the refund address. Nothing reached your reserve.",
        tone: "warning",
        final: true,
      };
    case "FAILED":
      return {
        title: "Swap failed",
        detail: "1Click couldn't complete the swap. Look the deposit address up on the NEAR Intents explorer, and keep it for 1Click support.",
        tone: "error",
        final: true,
      };
    default:
      return { title: "Unrecognised status", detail: `1Click reported "${status}". This page keeps checking.`, tone: "waiting", final: false };
  }
}

const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  gnosis: "Gnosis",
  sol: "Solana",
  btc: "Bitcoin",
  ton: "TON",
  tron: "Tron",
  sui: "Sui",
  aptos: "Aptos",
  stellar: "Stellar",
  xrp: "XRP Ledger",
  doge: "Dogecoin",
  ltc: "Litecoin",
  bch: "Bitcoin Cash",
  zec: "Zcash",
  dash: "Dash",
  cardano: "Cardano",
  bera: "Berachain",
  monad: "Monad",
  xlayer: "X Layer",
  scroll: "Scroll",
  starknet: "Starknet",
  plasma: "Plasma",
  hypercore: "Hyperliquid",
  hlevm: "HyperEVM",
  movement: "Movement",
};

export function chainName(blockchain: string): string {
  return CHAIN_NAMES[blockchain] ?? blockchain.toUpperCase();
}

/** Popular origins first, so most people find theirs without scrolling. */
const CHAIN_ORDER = ["eth", "base", "arb", "sol", "near", "btc", "op", "pol", "bsc", "avax"];
const STABLES = new Set(["USDC", "USDT"]);

/** Every token that can fund a reserve, minus NEAR USDC itself, grouped by chain. */
export function fundingChains(tokens: readonly OneClickToken[]): { chain: string; name: string; tokens: OneClickToken[] }[] {
  const byChain = new Map<string, OneClickToken[]>();
  for (const token of tokens) {
    if (token.assetId === FUNDING_DESTINATION) continue;
    const list = byChain.get(token.blockchain);
    if (list) list.push(token);
    else byChain.set(token.blockchain, [token]);
  }
  const rank = (chain: string) => {
    const index = CHAIN_ORDER.indexOf(chain);
    return index === -1 ? CHAIN_ORDER.length : index;
  };
  return [...byChain.entries()]
    .map(([chain, list]) => ({
      chain,
      name: chainName(chain),
      tokens: [...list].sort((a, b) => Number(STABLES.has(b.symbol)) - Number(STABLES.has(a.symbol)) || a.symbol.localeCompare(b.symbol)),
    }))
    .sort((a, b) => rank(a.chain) - rank(b.chain) || a.name.localeCompare(b.name));
}

/** 1Click errors come back as { message }. */
export function oneClickErrorMessage(status: number, body: unknown): string {
  const message = typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message) : null;
  if (status === 429) return "1Click is rate limiting requests. Wait a minute and try again.";
  if (message && /internal server error/i.test(message)) {
    return "1Click couldn't make this quote. Check the NEAR account exists and the amount isn't tiny, then try again.";
  }
  if (message) return `1Click said: ${message}`;
  return `1Click answered with HTTP ${status}.`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ONECLICK_URL}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("Couldn't reach 1Click. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(oneClickErrorMessage(response.status, body));
  return body as T;
}

export const getTokens = () => call<OneClickToken[]>("/v0/tokens");

export const getQuote = (request: QuoteRequest) =>
  call<QuoteResponse>("/v0/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });

export const getStatus = (depositAddress: string, depositMemo?: string) => {
  const params = new URLSearchParams({ depositAddress });
  if (depositMemo) params.set("depositMemo", depositMemo);
  return call<StatusResponse>(`/v0/status?${params}`);
};

/** Optional: tells 1Click about the deposit so it doesn't wait to spot it. */
export const submitDepositTx = (depositAddress: string, txHash: string, depositMemo?: string) =>
  call<StatusResponse>("/v0/deposit/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ depositAddress, txHash, ...(depositMemo ? { memo: depositMemo } : {}) }),
  });
