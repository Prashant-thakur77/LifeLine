const CACHE_SECONDS = 5;

/** The two calls this uses from Cloudflare's `caches.default`. */
export type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

/**
 * Serves API reads from Cloudflare's cache for 5 s. A dashboard polls every few seconds,
 * and each read that reaches the keeper's object costs a request and rows read from the
 * free plan's daily allowance, which the watch loop needs. Only successful GETs under
 * /api/ are cached: never a write, the Telegram webhook, the status page or an error.
 */
export async function serveWithEdgeCache(
  request: Request,
  deps: { cache: EdgeCache; upstream: () => Promise<Response>; waitUntil: (work: Promise<unknown>) => void },
): Promise<Response> {
  const cacheable = request.method === "GET" && new URL(request.url).pathname.startsWith("/api/");
  if (!cacheable) return deps.upstream();

  const hit = await deps.cache.match(request);
  if (hit !== undefined) return hit;

  const response = await deps.upstream();
  if (response.status !== 200) return response;
  const shared = new Response(response.body, response);
  shared.headers.set("cache-control", `public, max-age=${CACHE_SECONDS}`);
  deps.waitUntil(deps.cache.put(request, shared.clone()));
  return shared;
}
