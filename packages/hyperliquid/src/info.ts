const DEFAULT_API_URL = "https://api.hyperliquid.xyz";

export type InfoOptions = {
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
  /** Per attempt. The default keeps the worst case (9.4 s) under the 15 s snapshot limit. */
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class InfoApiError extends Error {
  override name = "InfoApiError";
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The API rejected the request itself, so sending it again can't help. */
const isFinal = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

/** POSTs to Hyperliquid's info endpoint, retrying failures with growing delays. */
export async function postInfo(body: unknown, options: InfoOptions = {}): Promise<unknown> {
  const {
    fetch: send = globalThis.fetch,
    apiUrl = process.env.HYPERLIQUID_API_URL || DEFAULT_API_URL,
    timeoutMs = 2000,
    retries = 3,
    retryDelayMs = 200,
    sleep = wait,
  } = options;

  let failure = "no attempt made";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));
    try {
      const response = await send(`${apiUrl}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.json();
      failure = `HTTP ${response.status}`;
      if (isFinal(response.status)) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new InfoApiError(failure);
}
