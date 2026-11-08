const REQUEST_TIMEOUT_MS = 10_000;

/** A token 1Click can swap, as GET /v0/tokens lists it. */
export type Token = {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
  contractAddress: string | null;
};

function parseToken(raw: unknown): Token | null {
  if (raw === null || typeof raw !== "object") return null;
  const { assetId, blockchain, symbol, decimals, price, contractAddress } = raw as Record<string, unknown>;
  if (typeof assetId !== "string" || typeof blockchain !== "string" || typeof symbol !== "string") return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return null;
  return {
    assetId,
    blockchain,
    symbol,
    decimals,
    priceUsd: typeof price === "number" && Number.isFinite(price) ? price : null,
    contractAddress: typeof contractAddress === "string" ? contractAddress : null,
  };
}

/** Every token 1Click can swap. An entry that can't be read is left out, never guessed at. */
export async function getTokens(options: { apiUrl: string; jwt?: string; fetch?: typeof fetch }): Promise<Token[]> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${options.apiUrl}/v0/tokens`, {
    headers: options.jwt ? { authorization: `Bearer ${options.jwt}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { message?: unknown } | null)?.message;
    throw new Error(`1Click ${response.status}: ${typeof message === "string" ? message : "request failed"}`);
  }
  if (!Array.isArray(body)) throw new Error("1Click's token list isn't a list");
  return body.map(parseToken).filter((token): token is Token => token !== null);
}
